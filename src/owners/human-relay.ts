import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { NativeIdentity } from '../contracts/domain.ts';
import { canonical } from '../storage/database.ts';
import { factoryClientId } from './vscode.ts';

// VS Code's native FileAccess fallback authority in the pinned host source.
const desktopOrigin='vscode-file://vscode-app';
function allowedFrame(text:string,identity:NativeIdentity):boolean {
  let value:any;try{value=JSON.parse(text)}catch{return false}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.jsonrpc!=='2.0'||typeof value.method!=='string'||!value.params||typeof value.params!=='object')return false;
  const p=value.params;const allowed=new Set(['ahp-root://',identity.sessionId,identity.chatId]);
  if(value.method==='initialize')return typeof p.clientId==='string'&&p.clientId.length>0&&p.clientId.length<=256&&p.clientId!==factoryClientId&&p.channel==='ahp-root://'&&(!p.initialSubscriptions||Array.isArray(p.initialSubscriptions)&&p.initialSubscriptions.every((s:unknown)=>typeof s==='string'&&allowed.has(s)))&&(!p.subscriptions||Array.isArray(p.subscriptions)&&p.subscriptions.every((s:unknown)=>typeof s==='string'&&allowed.has(s)));
  if(value.method==='subscribe'||value.method==='unsubscribe')return typeof p.channel==='string'&&allowed.has(p.channel);
  if(value.method==='listSessions'||value.method==='ping')return p.channel==='ahp-root://';
  if(value.method==='fetchTurns')return p.channel===identity.chatId;
  if(value.method==='dispatchAction')return p.channel===identity.chatId&&p.action&&['chat/turnStarted','chat/turnCancelled','chat/inputAnswerChanged','chat/inputCompleted'].includes(p.action.type);
  return false;
}
/** Disposable one-use desktop admission; its upstream is separate from the factory owner transport. */
export async function startHumanRelay(options:{runtimeOwnerId:string;identity:NativeIdentity;assertCurrent():void;connect():Promise<AhpTransport>;beforeHumanAction(action:Record<string,unknown>):string|void;humanActionAcknowledged?(key:string):void;ttlMs?:number}) {
  const ttl=options.ttlMs??60000;if(!options.runtimeOwnerId||!options.identity.chatId||!Number.isInteger(ttl)||ttl<1||ttl>60000)throw new Error('Invalid human relay admission');
  options.assertCurrent();const token=randomBytes(32).toString('base64url');const expected=Buffer.from(token);const expiresAt=Date.now()+ttl;
  const server=createServer((_req,res)=>res.writeHead(404).end());const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
  let used=false;let closed=false;let revoked=false;let accepting=true;let active:WebSocket|undefined;let upstream:AhpTransport|undefined;let chain=Promise.resolve();let closing:Promise<void>|undefined;let finalClose:Promise<void>|undefined;
  const guard=()=>{try{options.assertCurrent();return true}catch{return false}};
  const closeActive=():Promise<void>=>{accepting=false;active?.terminate();active=undefined;if(closing)return closing;const transport=upstream;upstream=undefined;closing=(async()=>{const close=Promise.resolve().then(()=>transport?.close());const results=await Promise.allSettled([chain,close]);if(results.some(result=>result.status==='rejected'))throw new Error('Human relay closure remains uncertain')})();return closing};
  const revoke=()=>{revoked=true;void closeActive().catch(()=>{});if(server.listening)server.close()};
  const check=setInterval(()=>{if(!guard())revoke()},100);check.unref();
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>{});
    let supplied:Buffer;try{const url=new URL(req.url??'','http://127.0.0.1');const values=url.searchParams.getAll('tkn');if(url.pathname!=='/'||values.length!==1||[...url.searchParams.keys()].some(k=>k!=='tkn'))throw Error();supplied=Buffer.from(values[0]!)}catch{socket.destroy();return}
    const current=guard();if(!current)revoke();
    if(closed||revoked||used||Date.now()>=expiresAt||req.headers.origin!==desktopOrigin||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||!current){socket.destroy();return}
    used=true;
    void (async()=>{
      let transport:AhpTransport|undefined;let expired=false;
      try {
        const pending=options.connect();void pending.then(value=>{if(expired)void value.close()},()=>{});
        transport=await Promise.race([pending,new Promise<never>((_,reject)=>setTimeout(()=>{expired=true;reject(Error('timeout'))},5000).unref())]);
        if(closed||socket.destroyed||!guard()){await transport.close();socket.destroy();return}
        upstream=transport;
        wss.handleUpgrade(req,socket,head,ws=>{
          active=ws;server.close();let queued=0;let initialized=false;let clientId='';const pending=new Map<number,{key:string;action:string}>();const seen=new Set<number>();
          ws.on('error',()=>{void closeActive().catch(()=>{})});ws.on('close',()=>{void closeActive().catch(()=>{})});
          ws.on('message',(data,binary)=>{
            if(!accepting)return;if(binary||++queued>64){void closeActive().catch(()=>{});return}const text=data.toString();
            chain=chain.then(async()=>{queued--;if(!accepting||closed)return;if(!guard()){revoke();return}if(!allowedFrame(text,options.identity)||!upstream){void closeActive().catch(()=>{});return}const message=JSON.parse(text);const method=message.method;if((!initialized&&method!=='initialize')||(initialized&&method==='initialize')){void closeActive().catch(()=>{});return}if(!initialized)clientId=message.params.clientId;initialized=true;if(method==='dispatchAction'){const seq=message.params.clientSeq;if(!Number.isSafeInteger(seq)||seq<0||seen.has(seq)){void closeActive().catch(()=>{});return}seen.add(seq);const action=message.params.action;const key=options.beforeHumanAction(action);if(key)pending.set(seq,{key,action:canonical(action)})}await upstream.send(text)}).catch(()=>{void closeActive().catch(()=>{})});
          });
          void (async()=>{try{while(active===ws&&upstream){const frame:TransportFrame|null=await upstream.recv();if(!frame)break;if(!guard())break;
            const text=frame.kind==='text'?frame.text:frame.kind==='parsed'?JSON.stringify(frame.message):'';if(!text||Buffer.byteLength(text)>1024*1024||ws.bufferedAmount>1024*1024)break;
            let message:any;try{message=JSON.parse(text)}catch{break}
            if(message?.method==='action'&&message.params?.channel===options.identity.chatId&&message.params.origin?.clientId===clientId&&Number.isSafeInteger(message.params.origin?.clientSeq)&&Number.isSafeInteger(message.params.serverSeq)&&message.params.serverSeq>0&&!message.params.rejectionReason){const seq=message.params.origin.clientSeq;const entry=pending.get(seq);if(entry&&canonical(message.params.action)===entry.action){options.humanActionAcknowledged?.(entry.key);pending.delete(seq)}}
            if(message&&typeof message.method==='string'&&message.id!==undefined){await upstream.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client capability unavailable'}});continue}
            if(message?.method&&message?.params?.channel&&!['ahp-root://',options.identity.sessionId,options.identity.chatId].includes(message.params.channel))continue;
            ws.send(text);
          }}catch{}finally{void closeActive().catch(()=>{})}})();
        });
      } catch {if(transport)void transport.close();socket.destroy()}
    })();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=server.address();if(!address||typeof address==='string'){clearInterval(check);server.close();throw new Error('Human relay unavailable')}
  const expiry=setTimeout(()=>{if(!used&&server.listening)server.close()},Math.max(1,expiresAt-Date.now()));expiry.unref();
  return {address:`127.0.0.1:${address.port}`,token,expiresAt,runtimeOwnerId:options.runtimeOwnerId,close(){if(finalClose)return finalClose;closed=true;clearTimeout(expiry);clearInterval(check);const settled=closeActive();wss.close();finalClose=(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await settled})();return finalClose}};
}
