import { OwnedDocker, images, restrictedArgs } from '../../../../probes/docker.ts';
import { inspectRestrictions, workerCanary, requireWorkerAssertions } from '../../../../probes/isolation.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
if (!process.argv.includes('--live')) throw new Error('Explicit --live consent required');
const outputDir='release/evidence/p4/headless';
const resources=JSON.parse(await readFile(`${outputDir}/setup-resources.json`,'utf8'));
const artifact=JSON.parse(await readFile(`${outputDir}/artifact.json`,'utf8'));
const manifest=JSON.parse(await readFile(`${outputDir}/${resources.owner}-resources.json`,'utf8'));
const docker=new OwnedDocker(outputDir);
Object.defineProperty(docker,'owner',{value:resources.owner}); docker.resources.push(...manifest.resources);
const report={mode:'live',status:'blocked',observedAt:new Date().toISOString(),nativeProfileVerified:false,modelTurnsStarted:0,loginStarted:false,resourceOwner:docker.owner,assertions:[]};
try {
 const script=String.raw`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');(async()=>{const url='https://main.vscode-cdn.net/agent-sdk/codex/0.163.0/linux-x64.tgz';const r=await fetch(url);if(!r.ok)throw new Error('SDK unavailable');const b=Buffer.from(await r.arrayBuffer());if(crypto.createHash('sha256').update(b).digest('hex')!=='201b83598aaa2764468788cff3ad450e81e5d1e2f00662be668f94d85e8de294')throw new Error('SDK hash mismatch');fs.writeFileSync('/tmp/codex.tgz',b);fs.mkdirSync('/assets/codex-sdk',{recursive:true});cp.execFileSync('tar',['-xzf','/tmp/codex.tgz','-C','/assets/codex-sdk']);console.log(JSON.stringify({url,version:'0.163.0',sha256:crypto.createHash('sha256').update(b).digest('hex'),bytes:b.length}));})().catch(e=>{console.error(e.message);process.exit(1)});`;
 const sdk=await docker.run('sdk-setup',['--pull','never','--network','bridge','--mount',`type=volume,src=${resources.assets},dst=/assets`,images.worker.image,'node','-e',script]);
 assert.equal(await docker.command(['wait',sdk]),'0');
 report.sdk=JSON.parse(await docker.command(['logs',sdk]));
 const mounts=[{name:resources.assets,destination:'/assets',readOnly:true},{name:resources.state,destination:'/state',readOnly:false},{name:resources.config,destination:'/config',readOnly:true}];
 const runtime=await docker.run('native',[...restrictedArgs(),'--tmpfs','/workspace:rw,nosuid,nodev,noexec,uid=1000,gid=1000','--tmpfs','/home/node:rw,nosuid,nodev,uid=1000,gid=1000',...mounts.flatMap(m=>['--mount',`type=volume,src=${m.name},dst=${m.destination}${m.readOnly?',readonly':''}`]),'--env','VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED=false','--env','VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED=true','--env','VSCODE_AGENT_HOST_CODEX_SDK_ROOT=/assets/codex-sdk','--env','SF_DECLARED_MODEL_CANARY=sf-model-fixed-canary',images.worker.image,`/assets/vscode/bin/${artifact.serverApplicationName}`,'--start-server','--accept-server-license-terms','--host','127.0.0.1','--port','8080','--agent-host-port','8081','--server-data-dir','/state','--connection-token-file','/config/token','--telemetry-level','off']);
 const effective=await docker.inspect(runtime); inspectRestrictions(effective,mounts);
 report.effectiveSettings={image:effective.Config.Image,user:effective.Config.User,readOnly:effective.HostConfig.ReadonlyRootfs,network:effective.HostConfig.NetworkMode,capDrop:effective.HostConfig.CapDrop,securityOpt:effective.HostConfig.SecurityOpt,mounts:effective.Mounts.map(m=>({type:m.Type,name:m.Name,destination:m.Destination,readWrite:m.RW}))};
 const diagnostic=String.raw`
const fs=require('fs');
(async()=>{
 const token=fs.readFileSync('/config/token','utf8');
 const invalidRejected=await new Promise(resolve=>{const ws=new WebSocket('ws://127.0.0.1:8081/?tkn=wrong-fixed-canary');const timer=setTimeout(()=>{ws.close();resolve(false)},3000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(false)};ws.onerror=()=>{clearTimeout(timer);resolve(true)};});
 const ws=new WebSocket('ws://127.0.0.1:8081/?tkn='+encodeURIComponent(token));
 const pending=new Map();let id=0;const sent=[];
 const timeout=setTimeout(()=>process.exit(2),15000);
 ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.id&&pending.has(v.id)){pending.get(v.id)(v);pending.delete(v.id)}};
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 const request=(method,params)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);sent.push(method);ws.send(JSON.stringify({jsonrpc:'2.0',id:n,method,params}))});
 const init=await request('initialize',{channel:'ahp-root://',clientId:'sf-p4-contained-diagnostic',protocolVersions:['1.0.0'],initialSubscriptions:['ahp-root://'],clientInfo:{name:'sf-p4-contained-diagnostic',version:'0.1.0'},_meta:{'vscode.ahpSessionUris':true,'vscode.ahpChatUris':true}});
 if(init.error)throw new Error('initialize rejected');
 const root=init.result.snapshots.find(s=>s.resource==='ahp-root://').state;
 const sessions=await request('listSessions',{channel:'ahp-root://',limit:100});
 if(sessions.error)throw new Error('listSessions rejected');
 const config=root.config?.values??{};
 console.log(JSON.stringify({protocol:init.result.protocolVersion,hostBuild:root._meta?.hostBuild,providers:root.agents.map(a=>({id:a.provider,modelCount:a.models?.length??0})),config:{githubMcpServerEnabled:config.githubMcpServerEnabled,mcpConnectorsEnabled:config.mcpConnectorsEnabled,systemProxyEnabled:config.systemProxyEnabled,computerUseEnabled:config.computerUseEnabled},sessionCount:sessions.result.items.length,invalidTokenRejected:invalidRejected,sentMethods:sent,clientExecution:'docker exec within native container',clientContributions:[]}));
 clearTimeout(timeout);ws.close();
})().catch(()=>process.exit(1));`;
 let result;
 for(let n=0;n<30;n++){
  try {result=JSON.parse(await docker.command(['exec',runtime,'node','-e',diagnostic]));break;} catch {if(!(await docker.inspect(runtime)).State.Running)break;await delay(1000);}
 }
 if(!result){const logs=await docker.command(['logs','--tail','120',runtime]);report.startupErrors=logs.split('\n').filter(l=>/Error:|Cannot find|Permission denied|Read-only file|GLIBC|not found/.test(l)).map(l=>l.slice(0,250)).slice(-10);throw new Error('Headless discovery did not complete');}
 report.discovery=result;
 assert.equal(result.invalidTokenRejected,true);
 assert.equal(result.config.githubMcpServerEnabled,false);assert.equal(result.config.mcpConnectorsEnabled,false);
 assert.equal(result.providers.some(p=>p.id==='claude'),false);
 assert.equal(result.sessionCount,0);
 assert.deepEqual(result.sentMethods,['initialize','listSessions']);
 const canaries=JSON.parse(await docker.command(['exec',runtime,'node','-e',workerCanary]));requireWorkerAssertions(canaries);
 report.assertions=[{name:'headless-startup-and-ahp-discovery-only',passed:true},{name:'private-token-required',passed:true},{name:'github-mcp-and-connectors-disabled',passed:true},{name:'claude-disabled',passed:true},{name:'zero-native-sessions',passed:true},{name:'diagnostic-client-contained-no-contributions',passed:true},...canaries];
 report.runtimeNode=await docker.command(['exec',runtime,'/assets/vscode/node','--version']);
 report.reason='No native model/task/tool execution verified. Next: approved provider authentication and restricted service-egress binding, then lifecycle and all-client-tool execution proof; no host credential fallback.';
} catch(error){report.failure=error.message;}
finally {try{await docker.cleanup();report.cleanup='complete'}catch(e){report.cleanup=e.message} await writeFile(`${outputDir}/bootstrap.json`,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
