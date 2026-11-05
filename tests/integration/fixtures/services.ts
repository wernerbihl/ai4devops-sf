import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {parse} from 'yaml';
import {fakeHost} from '../../owners/ahp-fixture.ts';
import {decodeWorkerRequest,encodeWorkerResponse} from '../../../src/contracts/worker-transport.ts';
const mode=process.argv[2];const host=mode==='native'?fakeHost():undefined;
let flow:any;let execution:any;let starts=0;let resumes=0;let native:any;
const server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):{};
  let output:any;
  if(req.url==='/stats')output=mode==='native'?{creates:host!.creates,sessions:[...host!.sessions.keys()]}:{starts,resumes,executionId:execution?.id};
  else if(req.url==='/tool'){await host!.tool(input.chatId,'sf_factory_operation',input.input);output={ok:true};}
  else if(req.url==='/park'){native=input.identity;execution.state.current='PAUSED';execution.taskRunList=[{id:'native-1',taskId:'native_start',state:{current:'SUCCESS'}},{id:'pause-1',taskId:'await_result',state:{current:'PAUSED'}}];output={ok:true};}
  else if(req.url==='/engine'){
    const q=input;const url=new URL('http://fixture'+q.path);
    if(q.path.startsWith('/flows/'))output=flow?{status:200,body:flow}:{status:404,body:null};
    else if(q.path==='/flows'){flow={...parse(q.body),revision:1};output={status:200,body:flow};}
    else if(url.pathname==='/executions/search')output={status:200,body:{total:execution?1:0,results:execution?[execution]:[]}};
    else if(url.searchParams.has('revision')){starts++;const request=decodeWorkerRequest(q.body.sf_native_start);execution={id:'execution-original',namespace:flow.namespace,flowId:flow.id,flowRevision:1,labels:url.searchParams.getAll('labels').map(v=>{const i=v.indexOf(':');return{key:v.slice(0,i),value:v.slice(i+1)}}),state:{current:'RUNNING'},taskRunList:[],nativeRequestId:request.requestId};output={status:200,body:execution};}
    else if(q.path.endsWith('/actions/resume')){resumes++;execution.resume=q.body.sf_result;execution.state.current='SUCCESS';execution.taskRunList.forEach((t:any)=>t.state.current='SUCCESS');output={status:204,body:null};}
    else if(q.path.endsWith('/actions/eval')){const result=q.body==='{{ outputs.native_start.body }}'?encodeWorkerResponse({requestId:execution.nativeRequestId,ok:true,result:native}):q.body==='{{ outputs.await_result.onResume.sf_result }}'?execution.resume:encodeWorkerResponse({requestId:decodeWorkerRequest(execution.resume).requestId,ok:true,result:decodeWorkerRequest(execution.resume).payload as import('../../../src/contracts/domain.ts').TaskResult});output={status:200,body:{result}};}
    else if(q.path==='/executions/execution-original')output={status:200,body:execution};
    else throw Error('unknown engine fixture request');
  }else throw Error('fixture route');
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(output));
}catch(error){res.writeHead(500).end(JSON.stringify({error:String(error)}))}});
if(host){const ws=new WebSocketServer({server});ws.on('connection',async socket=>{const transport=await host.connect();socket.on('message',data=>void transport.send(data.toString()));socket.on('close',()=>void transport.close());void(async()=>{for(;;){const frame=await transport.recv();if(!frame)break;if(frame.kind==='text'&&socket.readyState===1)socket.send(frame.text)}})()})}
server.listen(0,'127.0.0.1',()=>{const address=server.address() as {port:number};process.send?.({url:'http://127.0.0.1:'+address.port,pid:process.pid})});
