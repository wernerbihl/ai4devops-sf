import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';
import {startHumanRelay} from '../../src/owners/human-relay.ts';

function upstream(){const sent:string[]=[];let end!:(value:null)=>void;const wait=new Promise<null>(r=>end=r);return {sent,transport:{send(value:unknown){sent.push(typeof value==='string'?value:JSON.stringify(value))},recv(){return wait},close(){end(null)}}}}
const identity={ownerId:'vscode',providerId:'copilot' as const,sessionId:'ahp-session:/fixture',chatId:'ahp-chat:/fixture'};
function socket(address:string,token:string,origin='vscode-file://vscode-app'){return new WebSocket(`ws://${address}/?tkn=${encodeURIComponent(token)}`,{origin})}

test('relay admits one exact desktop connection and rejects untrusted configuration actions',async()=>{
 const native=upstream();let current=true;const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){if(!current)throw Error('revoked')},async connect(){return native.transport}});
 try {
  const denied=socket(relay.address,relay.token,'https://evil.example');await assert.rejects(once(denied,'open'));
  const ws=socket(relay.address,relay.token);await once(ws,'open');
  ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop-1'}}));
  await new Promise(r=>setTimeout(r,20));assert.equal(native.sent.length,1);
  ws.send(JSON.stringify({jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:'ahp-root://',action:{type:'root/configChanged',config:{}}}}));
  await once(ws,'close');assert.equal(native.sent.length,1);
  const replay=socket(relay.address,relay.token);await assert.rejects(once(replay,'open'));
 } finally {current=false;await relay.close()}
});

test('expired admission and revoked human authority cannot steer a relay',async()=>{
 const native=upstream();let current=true;const expired=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){if(!current)throw Error('revoked')},async connect(){return native.transport},ttlMs:20});
 try {await new Promise(r=>setTimeout(r,40));const ws=socket(expired.address,expired.token);await assert.rejects(once(ws,'open'));assert.equal(native.sent.length,0)}finally{await expired.close()}
 const next=upstream();const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){if(!current)throw Error('revoked')},async connect(){return next.transport}});
 try {const ws=socket(relay.address,relay.token);await once(ws,'open');current=false;ws.send(JSON.stringify({jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:identity.chatId,action:{type:'chat/turnStarted'}}}));await once(ws,'close');assert.equal(next.sent.length,0)}finally{await relay.close()}
});

test('admission expiry does not end an authenticated current human connection',async()=>{
 const native=upstream();let current=true;const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){if(!current)throw Error('revoked')},async connect(){return native.transport},ttlMs:30});
 try {const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop-1'}}));await new Promise(r=>setTimeout(r,50));ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'ping',params:{channel:'ahp-root://'}}));await new Promise(r=>setTimeout(r,20));assert.equal(native.sent.length,2);current=false;await once(ws,'close')}
 finally{await relay.close()}
});

test('losing authority before connection permanently revokes the capability',async()=>{
 const native=upstream();let current=true;const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){if(!current)throw Error('revoked')},async connect(){return native.transport},ttlMs:1000});
 try {current=false;await new Promise(r=>setTimeout(r,150));current=true;const ws=socket(relay.address,relay.token);await assert.rejects(once(ws,'open'));assert.equal(native.sent.length,0)}finally{await relay.close()}
});

test('relay closes rather than exposing native filesystem or replacing the factory client tools',async()=>{
 const forbidden=[{jsonrpc:'2.0',id:1,method:'resourceRead',params:{channel:'ahp-root://',uri:'file:///opt/software-factory/native-state/connection-token'}},{jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:identity.sessionId,action:{type:'session/activeClientSet',activeClient:{tools:[]}}}},{jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:'ahp-chat:/other',action:{type:'chat/turnStarted'}}}];
 for(const message of forbidden){const native=upstream();const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){},async connect(){return native.transport}});try{const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop-1'}}));await new Promise(r=>setTimeout(r,10));ws.send(JSON.stringify(message));await once(ws,'close');assert.equal(native.sent.length,1)}finally{await relay.close()}}
});

test('desktop cannot impersonate the private factory client identity',async()=>{
 const native=upstream();const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){},async connect(){return native.transport}});
 try {const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'software-factory'}}));await Promise.race([once(ws,'close'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Impersonation connection stayed open')),150))]);assert.equal(native.sent.length,0)}finally{await relay.close()}
});

test('native reverse resource requests are refused instead of reaching the desktop',async()=>{
 const sent:string[]=[];let push!:(value:any)=>void;
 const transport={send(value:unknown){sent.push(typeof value==='string'?value:JSON.stringify(value))},recv(){return new Promise<any>(r=>push=r)},close(){push(null)}};
 const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){},async connect(){return transport}});
 try {const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop-1'}}));await new Promise(r=>setTimeout(r,15));let desktopMessages=0;ws.on('message',()=>desktopMessages++);push({kind:'text',text:JSON.stringify({jsonrpc:'2.0',id:77,method:'resourceRead',params:{channel:'ahp-root://',uri:'file:///host/secret'}})});await new Promise(r=>setTimeout(r,20));assert.equal(desktopMessages,0);assert.equal(JSON.parse(sent[1]!).error.code,-32601);ws.terminate()}
 finally {await relay.close()}
});

test('return waits for in-flight human send, discards queued actions and awaits upstream closure',async()=>{
 let release!:()=>void;let closed!:()=>void;const sending=new Promise<void>(r=>release=r);const closeWait=new Promise<void>(r=>closed=r);let sentActions=0;let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);
 const transport={async send(value:unknown){const text=typeof value==='string'?value:JSON.stringify(value);if(text.includes('turnStarted')){sentActions++;enter();await sending}},recv(){return new Promise<null>(()=>{})},async close(){await closeWait}};
 const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,assertCurrent(){},async connect(){return transport},beforeHumanAction(){}} as any);
 const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop-1'}}));
 const action=JSON.stringify({jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:identity.chatId,action:{type:'chat/turnStarted'}}});ws.send(action);await entered;ws.send(action);await new Promise(r=>setTimeout(r,20));
 let finished=false;let secondFinished=false;const closing=relay.close().then(()=>{finished=true});const second=relay.close().then(()=>{secondFinished=true});await new Promise(r=>setTimeout(r,20));assert.equal(finished,false,'in-flight send and transport closure must be settled before return');assert.equal(secondFinished,false,'concurrent close must wait for the same barrier');release();await new Promise(r=>setTimeout(r,20));assert.equal(finished,false,'upstream close must be awaited');closed();await Promise.all([closing,second]);assert.equal(sentActions,1,'queued actions must never forward after closure');
});

test('human action records durable uncertainty before forwarding to native',async()=>{
 let recorded=false;let observed=false;let sent!:()=>void;const sentAction=new Promise<void>(r=>sent=r);const native=upstream();
 const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,assertCurrent(){},beforeHumanAction(){recorded=true},async connect(){return {...native.transport,send(value:unknown){if(typeof value==='string'&&value.includes('turnStarted')){observed=recorded;sent()}native.transport.send(value)}}}} as any);
 try{const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop-1'}}));ws.send(JSON.stringify({jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:identity.chatId,action:{type:'chat/turnStarted'}}}));await sentAction;assert.equal(observed,true,'durable exclusion must precede forwarding')}finally{await relay.close()}
});

test('failed transport close cannot release an in-flight human send barrier',async()=>{
 let release!:()=>void;let entered!:()=>void;const stalled=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>entered=r);let end!:()=>void;const recv=new Promise<null>(r=>end=()=>r(null));
 const transport={async send(v:unknown){if(typeof v==='string'&&v.includes('turnStarted')){entered();await stalled}},recv(){return recv},async close(){end();throw Error('unknown close')}};
 const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,beforeHumanAction(){},assertCurrent(){},async connect(){return transport}});const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop'}}));ws.send(JSON.stringify({jsonrpc:'2.0',method:'dispatchAction',params:{clientSeq:1,channel:identity.chatId,action:{type:'chat/turnStarted'}}}));await started;
 let done=false;const closing=relay.close().then(()=>{done=true},()=>{done=true});await new Promise(r=>setTimeout(r,20));assert.equal(done,false);release();await closing;await assert.rejects(relay.close(),/uncertain/);
});

test('only exact native action acknowledgement resolves the durable human receipt',async()=>{
 let deliver!:(value:any)=>void;let resolved=0;const recv=()=>new Promise<any>(r=>deliver=r);const transport={send(){},recv,close(){deliver(null)}};
 const relay=await startHumanRelay({runtimeOwnerId:'owner-1',identity,assertCurrent(){},beforeHumanAction(){return 'receipt-1'},humanActionAcknowledged(key:string){assert.equal(key,'receipt-1');resolved++},async connect(){return transport}} as any);
 try{const ws=socket(relay.address,relay.token);await once(ws,'open');ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{channel:'ahp-root://',clientId:'desktop'}}));const action={type:'chat/turnStarted',turnId:'turn-1',message:{text:'fixture'}};ws.send(JSON.stringify({jsonrpc:'2.0',method:'dispatchAction',params:{channel:identity.chatId,clientSeq:7,action}}));await new Promise(r=>setTimeout(r,20));
 deliver({kind:'text',text:JSON.stringify({jsonrpc:'2.0',method:'action',params:{channel:identity.chatId,serverSeq:1,origin:{clientId:'other',clientSeq:7},action}})});await new Promise(r=>setTimeout(r,20));assert.equal(resolved,0);
 deliver({kind:'text',text:JSON.stringify({jsonrpc:'2.0',method:'action',params:{channel:identity.chatId,serverSeq:2,origin:{clientId:'desktop',clientSeq:7},action}})});await new Promise(r=>setTimeout(r,20));assert.equal(resolved,1);
 }finally{await relay.close()}
});
