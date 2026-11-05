import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('production_stdio_relay_serves_opaque_http_without_exposing_host_ports_or_secrets_in_argv', async () => {
  const module = await import('../../src/broker/bridge.ts').catch(() => undefined);
  assert.ok(module?.relaySource && module?.serveRelay, 'Concrete stdio broker relay required');
  // Real relay protocol and HTTP; only test subprocess listener uses an ephemeral loopback port.
  const child = spawn(process.execPath, ['-e', module.createRelaySource(0, '127.0.0.1')], { stdio: ['pipe','pipe','pipe'] });
  const errors: Buffer[] = []; child.stderr.on('data', b => errors.push(b));
  const source = child.stdout;
  const session = module.serveRelay({ stdin: child.stdin, stdout: source, close: () => { child.kill(); } }, async request => ({ status: request.path === '/worker/v1/results' ? 200 : 404, body: request.body }));
  const port = await session.ready;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/worker/v1/results`, { method: 'POST', body: '{"encoding":"sf-base64url-json-v1","payload":"e30"}', headers: { Authorization: 'Bearer secret-not-argv' } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '{"encoding":"sf-base64url-json-v1","payload":"e30"}');
  } finally { session.close(); await once(child, 'exit'); }
  assert.equal(Buffer.concat(errors).toString(), '');
});

test('bridge_checks_owned_prestart_network_and_requires_assigned_network_after_start', async () => {
  const { startPrivateBrokerBridge, createRelaySource } = await import('../../src/broker/bridge.ts');
  const { kestraImagePins } = await import('../../src/kestra/deployment.ts');
  let starts = 0; let running = false; let assigned = ''; let bad = false;
  const image = kestraImagePins.worker.image;
  const docker = { command: async (args: string[]) => {
    if(args[0]==='network') return JSON.stringify([{Id:'net',Name:'private',Internal:true,Driver:'bridge',Labels:{'sf.installation':'test'},Containers:{}}]);
    if(args[0]==='image') return JSON.stringify([{Id:'image',RepoDigests:[image],Os:'linux',Architecture:'amd64',Config:{Entrypoint:null,Env:[]}}]);
    if(args[0]==='start'){starts++;running=true;assigned='net';return '';}
    if(args[1]==='ls') return 'container';
    if(args[1]==='inspect') return JSON.stringify([{Id:'container',Image:'image',Config:{Image:image,User:'1000:1000',Cmd:['node','-e','setInterval(()=>{},2147483647)'],Entrypoint:null,Env:[],Labels:{'sf.installation':'test','sf.component':'attempt-broker','sf.network':'net'}},HostConfig:{ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],NetworkMode:'net',PidsLimit:64,Memory:256*1024*1024,NanoCpus:1e9},Mounts:[],State:{Running:running},NetworkSettings:{Networks:{private:{NetworkID:bad?'foreign':assigned,Aliases:['sf-broker']}}}}]);
    throw Error('Unexpected Docker operation');
  } };
  const streaming = {open:()=>{const child=spawn(process.execPath,['-e',createRelaySource(0,'127.0.0.1')],{stdio:['pipe','pipe','pipe']});child.stderr.resume();return {stdin:child.stdin,stdout:child.stdout,close:()=>{child.kill();}};}};
  const options = {installation:{id:'test',root:'/private',docker,secrets:{loadOrCreate:async()=>{throw Error('unused');}}},kestra:{installationId:'test',containerId:'engine',transportContainerId:'transport',journalDirectory:'/private',brokerNetwork:{id:'net',name:'private',alias:'sf-broker' as const,port:8080 as const},request:async()=>{throw Error('unused');}},broker:{handle:async()=>({status:200,body:'ok'})},streaming};
  bad=true;await assert.rejects(startPrivateBrokerBridge(options));assert.equal(starts,0);bad=false;
  const bridge=await startPrivateBrokerBridge(options);assert.equal(starts,1);bridge.close();
});
