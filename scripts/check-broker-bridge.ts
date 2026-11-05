/** Opt-in, scratch-only E3 production bridge check. No native provider readiness is inferred. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProcessDocker, kestraImagePins } from '../src/kestra/deployment.ts';
import { ProcessStreamingDocker, startPrivateBrokerBridge } from '../src/broker/bridge.ts';
import { createAttemptBroker } from '../src/broker/operations.ts';
import { startWorkerBroker } from '../src/broker/server.ts';
import { encodeWorkerRequest, decodeWorkerResponse } from '../src/contracts/worker-transport.ts';
import { createFixture } from '../tests/helpers/store.ts';
import { materializeFixture } from '../tests/helpers/fixtures.ts';
import { createScheduler } from '../src/scheduling/admission.ts';
import type { KestraHandle } from '../src/kestra/deployment.ts';
const executable = process.env.SF_E3_DOCKER;
if (!executable) throw Error('Set SF_E3_DOCKER explicitly for this scratch-only live check');
const docker = new ProcessDocker(executable); const id = 'e3-check-'+randomUUID(); const image = kestraImagePins.worker.image;
const f = createFixture(); let bridge: Awaited<ReturnType<typeof startPrivateBrokerBridge>> | undefined; let engine = ''; let network = '';
try {
  network = (await docker.command(['network','create','--internal','--driver','bridge','--label',`sf.installation=${id}`,id])).trim();
  engine = (await docker.command(['run','-d','--name',id+'-client','--label',`sf.installation=${id}`,'--pull','never','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--network',network,image,'node','-e','setInterval(()=>{},2147483647)'])).trim();
  const summary = f.store.snapshot().recipes[0]!;
  f.store.setRecipeReadiness(summary.id,summary.currentRevision,{hash:f.recipe.hash,ready:true,reasons:[]},summary.revision);
  await createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,readiness:async()=>({ready:true,baseSha:'scratch',workspacePath:f.directory,profileId:'unsupported-live-native'}),start:async r=>({kind:'started',identity:{workflow:{executionId:r.attempt.id,namespace:'sf',flowId:'fixture',revision:'1'}}})}).dispatch('manual');
  const r = f.store.getReservations()[0]!; const broker = createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,42)});
  const handle: KestraHandle = {installationId:id,containerId:engine,transportContainerId:engine,journalDirectory:f.directory,brokerNetwork:{id:network,name:id,alias:'sf-broker',port:8080},request:async()=>{throw Error('Engine request unused');}};
  bridge = await startPrivateBrokerBridge({installation:{id,root:f.directory,docker,secrets:{loadOrCreate:async()=>{throw Error('No secret store accessed');}}},kestra:handle,store:f.store,broker:await startWorkerBroker({broker}),streaming:new ProcessStreamingDocker(executable)});
  const token = broker.issueAttemptCapability(r.attempt.id,['grant-1'],['result.submit']); const scope = broker.authorizeAttempt(token,'result.submit',{});
  const proposal = {attemptId:r.attempt.id,summary:'fixed canary {{ raw < > }} 日本語',evidence:[],createdTaskIds:[],outcome:'result' as const};
  const body = encodeWorkerRequest({requestId:'fixed-live-result',idempotencyKey:'fixed-live-result',scope,operation:'result.submit',payload:proposal});
  const request = async (path: string, authorization: string) => JSON.parse(await docker.command(['exec','-i',engine,'node','-e',`let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',async()=>{const p=JSON.parse(s);const r=await fetch('http://sf-broker:8080'+p.path,{method:'POST',headers:{Authorization:p.authorization},body:p.body});process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}));});`],{stdin:JSON.stringify({path,authorization,body})}));
  const result = await request('/worker/v1/results','Bearer '+token); assert.equal(result.status,200); assert.deepEqual(decodeWorkerResponse(result.body),{requestId:'fixed-live-result',ok:true,result:proposal});
  assert.equal((await request('/v1/settings','Bearer '+token)).status,404); assert.equal((await request('/worker/v1/results','Bearer invalid')).status,401);
  assert.notEqual(f.store.getTask(r.task.spec.id)!.status,'completed'); assert.deepEqual(broker.getResultProposal(r.attempt.id),proposal);
  const c = JSON.parse(await docker.command(['container','inspect',bridge.containerId]))[0]; assert.deepEqual(c.HostConfig.PortBindings,{}); assert.deepEqual(c.Mounts,[]);
  console.log(JSON.stringify({status:'passed',assertions:['actual private Docker exec relay','opaque request and reply preserved','real signed capability and durable proposal','admin route absent','invalid capability denied','no published ports or host mounts','proposal is not closeout'],nativeProfiles:'none advertised; actual E4 native-tool boundary required'}));
} finally {
  bridge?.close();
  // Remove only resources carrying this run's unpredictable ownership label, including uncertain create outcomes.
  const owned = (await docker.command(['container','ls','--all','--filter',`label=sf.installation=${id}`,'--format','{{.ID}}'])).split(/\s+/).filter(Boolean);
  for(const container of owned) await docker.command(['rm','-f',container]);
  if(network) await docker.command(['network','rm',network]);
  f.close(); console.log('Owned scratch cleanup complete');
}
