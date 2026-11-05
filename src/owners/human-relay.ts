import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { NativeIdentity } from '../contracts/domain.ts';
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
export async function startHumanRelay(options:{runtimeOwnerId:string;identity:NativeIdentity;assertCurrent():void;connect():Promise<AhpTransport>;ttlMs?:number}) {
  const ttl=options.ttlMs??60000;if(!options.runtimeOwnerId||!options.identity.chatId||!Number.isInteger(ttl)||ttl<1||ttl>60000)throw new Error('Invalid human relay admission');
  options.assertCurrent();const token=randomBytes(32).toString('base64url');const expected=Buffer.from(token);const expiresAt=Date.now()+ttl;
  const server=createServer((_req,res)=>res.writeHead(404).end());const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
  let used=false;let closed=false;let revoked=false;let active:WebSocket|undefined;let upstream:AhpTransport|undefined;
  const guard=()=>{try{options.assertCurrent();return true}catch{return false}};
  const closeActive=()=>{active?.terminate();active=undefined;void upstream?.close();upstream=undefined};
  const revoke=()=>{revoked=true;closeActive();if(server.listening)server.close()};
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
          active=ws;server.close();let queued=0;let initialized=false;let chain=Promise.resolve();
          ws.on('error',()=>closeActive());ws.on('close',()=>closeActive());
          ws.on('message',(data,binary)=>{
            if(binary||++queued>64){closeActive();return}const text=data.toString();
            chain=chain.then(async()=>{queued--;if(!guard()){revoke();return}if(!allowedFrame(text,options.identity)||!upstream){closeActive();return}const method=JSON.parse(text).method;if((!initialized&&method!=='initialize')||(initialized&&method==='initialize')){closeActive();return}initialized=true;await upstream.send(text)}).catch(()=>closeActive());
          });
          void (async()=>{try{while(active===ws&&upstream){const frame:TransportFrame|null=await upstream.recv();if(!frame)break;if(!guard())break;
            const text=frame.kind==='text'?frame.text:frame.kind==='parsed'?JSON.stringify(frame.message):'';if(!text||Buffer.byteLength(text)>1024*1024||ws.bufferedAmount>1024*1024)break;
            let message:any;try{message=JSON.parse(text)}catch{break}
            if(message&&typeof message.method==='string'&&message.id!==undefined){await upstream.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client capability unavailable'}});continue}
            if(message?.method&&message?.params?.channel&&!['ahp-root://',options.identity.sessionId,options.identity.chatId].includes(message.params.channel))continue;
            ws.send(text);
          }}catch{}finally{closeActive()}})();
        });
      } catch {if(transport)void transport.close();socket.destroy()}
    })();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=server.address();if(!address||typeof address==='string'){clearInterval(check);server.close();throw new Error('Human relay unavailable')}
  const expiry=setTimeout(()=>{if(!used&&server.listening)server.close()},Math.max(1,expiresAt-Date.now()));expiry.unref();
  return {address:`127.0.0.1:${address.port}`,token,expiresAt,runtimeOwnerId:options.runtimeOwnerId,async close(){if(closed)return;closed=true;clearTimeout(expiry);clearInterval(check);closeActive();wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}};
}
