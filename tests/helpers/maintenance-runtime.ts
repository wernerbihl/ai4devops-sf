import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from '../../src/storage/database.ts';
import { openStore } from '../../src/storage/store.ts';
import { startRuntime } from '../../src/service/runtime.ts';
import { kestraImagePins } from '../../src/kestra/deployment.ts';

/** Shared exact-resource fixture; callers choose purpose and explicitly trigger scenario changes. */
export async function createMaintenanceRuntime(purpose:'reconfigure'|'uninstall') {
  const root=mkdtempSync(join(tmpdir(),'sf-maintenance-engine-'));
  const id='fixture', owner=fingerprint({id,root}), prefix='sf-'+owner.slice(0,24);
  for(const path of ['vault','kestra','kestra/journal','kestra/data','kestra/config'])
    mkdirSync(join(root,path),{recursive:true,mode:0o700});
  writeFileSync(join(root,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:id,
    allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[],native:[]}),{mode:0o600});
  for(const name of ['broker-signing','private-control','native-copilot'])
    writeFileSync(join(root,'vault',name),Buffer.alloc(32,7),{mode:0o600});
  writeFileSync(join(root,'install-owner.json'),JSON.stringify({schemaVersion:1,installationId:id,root}),{mode:0o600});
  writeFileSync(join(root,'kestra-secrets.json'),'test-engine-key',{mode:0o600});
  writeFileSync(join(root,'kestra/data/database.mv.db'),'test-h2',{mode:0o600});
  for(const path of ['startup.json','owned-images.json','native-copilot.json'])
    writeFileSync(join(root,path),'fixture-'+path,{mode:0o600});
  const h2config={datasources:{h2:{url:'jdbc:h2:file:/app/data/database;TIME ZONE=UTC;DB_CLOSE_DELAY=0;DB_CLOSE_ON_EXIT=TRUE;LOCK_TIMEOUT=30000',username:'sa',password:''}}};
  writeFileSync(join(root,'kestra/config/application.yaml'),JSON.stringify(h2config),{mode:0o600});
  const journal=join(root,'kestra/journal/execution-intents.sqlite');
  writeFileSync(journal,'',{mode:0o600});
  const db=new DatabaseSync(journal);
  db.exec('CREATE TABLE intents(attempt TEXT PRIMARY KEY,request_key TEXT,version INTEGER,body TEXT)');
  db.prepare('INSERT INTO intents VALUES(?,?,0,?)').run('unknown','key',JSON.stringify({phase:'sent',start:{attemptId:'unknown'}}));
  db.close();
  const engine='a'.repeat(64), transport='b'.repeat(64), network='c'.repeat(64), relay='d'.repeat(64);
  const relayName='sf-broker-'+fingerprint({installation:id,network}).slice(0,24);
  const store=openStore(join(root,'factory.sqlite'));
  store.enqueueAction({key:'maintenance:test',kind:'maintenance.intent',payload:{installationId:id,purpose}});
  for(const [name,cid,startedAt] of [[prefix+'-kestra',engine,'engine'],[prefix+'-transport',transport,'transport']]) {
    const receipt=store.enqueueAction({key:'kestra:owner:'+name,kind:'kestra.owner',payload:{installationId:id,name,containerId:cid,owner}});
    store.completeAction(receipt.id);
    const generation=store.enqueueAction({key:'kestra:generation:'+cid+':'+startedAt,kind:'kestra.generation',payload:{
      installationId:id,containerId:cid,startedAt,...(cid===engine?{configHash:fingerprint(h2config),h2Lifecycle:'jvm-exit',imageId:'engine-image'}:{})}});
    store.completeAction(generation.id);
  }
  const relayOwner=store.enqueueAction({key:'broker:relay:owner:'+relayName,kind:'broker.relay_owner',payload:{installationId:id,networkId:network,containerId:relay,name:relayName}});
  store.completeAction(relayOwner.id);
  const relayGeneration=store.enqueueAction({key:'broker:relay:generation:'+relay+':relay',kind:'broker.relay_generation',payload:{installationId:id,networkId:network,containerId:relay,startedAt:'relay'}});
  store.completeAction(relayGeneration.id);store.close();
  writeFileSync(join(root,'kestra/owned-resources.json'),JSON.stringify({installationId:id,owner,networkId:network,containerId:engine,transportContainerId:transport,images:[]}),{mode:0o600});
  const labels={'sf.installation':id,'sf.owner':owner,'sf.component':'kestra'};
  const objects:Record<string,any>={
    [relay]:{Id:relay,Name:'/'+relayName,Image:'relay-image',
      Config:{Image:kestraImagePins.worker.image,User:'1000:1000',Cmd:['node','-e','setInterval(()=>{},2147483647)'],Entrypoint:null,Env:[],Labels:{'sf.installation':id,'sf.component':'attempt-broker','sf.network':network}},
      HostConfig:{NetworkMode:network,RestartPolicy:{Name:'no'},AutoRemove:false,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidsLimit:64,Memory:268435456,NanoCpus:1e9},
      State:{Running:true,Paused:false,Pid:14,Status:'running',StartedAt:'relay'},NetworkSettings:{Networks:{[prefix+'-engine']:{NetworkID:network,Aliases:['sf-broker']}}},Mounts:[]},
    [network]:{Id:network,Name:prefix+'-engine',Internal:true,Driver:'bridge',Labels:labels},
    [engine]:{Id:engine,Image:'engine-image',Name:'/'+prefix+'-kestra',Config:{Labels:labels},HostConfig:{RestartPolicy:{Name:'no'}},
      State:{Running:true,Paused:false,Pid:12,Status:'running',StartedAt:'engine'},Mounts:[
        {Type:'bind',Source:join(root,'kestra/data'),Destination:'/app/data',RW:true},
        {Type:'bind',Source:join(root,'kestra/config'),Destination:'/app/confs',RW:false}]},
    [transport]:{Id:transport,Name:'/'+prefix+'-transport',Config:{Labels:labels},HostConfig:{RestartPolicy:{Name:'no'},NetworkMode:'container:'+engine},
      State:{Running:true,Paused:false,Pid:13,Status:'running',StartedAt:'transport'},Mounts:[]},
  };
  let stops=0;let held:undefined|{entered():void;release:Promise<void>};
  const docker={async command(args:string[]){
    if(held&&args[0]==='container'&&args[1]==='inspect'&&args[2]===engine){const pause=held;held=undefined;pause.entered();await pause.release}
    if(args[0]==='run')return 'SF_H2_VALID';
    if(args[0]==='image')return JSON.stringify([{Id:args[2]===kestraImagePins.kestra.image?'engine-image':'relay-image',RepoDigests:[args[2]],Os:'linux',Architecture:'amd64',Config:{Entrypoint:null,Env:[]}}]);
    if(args[1]==='rm'){delete objects[args[2]!];return ''}
    if(args[1]==='ls'){
      if(args.some(a=>a.startsWith('label=sf.h2-validation=')))return '';
      if(args[0]==='network'||args.includes('label=sf.runtime-owner'))return '';
      if(args.some(a=>a.startsWith('name=')))return relay;
      return Object.keys(objects).filter(key=>key!==network&&objects[key]?.Mounts).join('\n');
    }
    if(args[1]==='inspect')return JSON.stringify([objects[args[2]!]]);
    if(args[1]==='stop'){
      stops++;const previous=objects[args.at(-1)!].State;
      objects[args.at(-1)!].State={...previous,Running:false,Paused:false,Pid:0,Status:'exited',ExitCode:143,OOMKilled:false,Error:'',FinishedAt:'finished'};
      return '';
    }
    throw Error('unexpected docker command');
  }};
  const runtime=await startRuntime({id,root,docker,secrets:{async loadOrCreate(){throw Error('not used')}}});
  const headers={authorization:'Bearer '+Buffer.alloc(32,7).toString('base64url'),'content-type':'application/json'};
  const request=(path:string,body?:object)=>fetch(runtime.controlUrl+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});
  const maintenance=()=>request('/maintenance',{purpose});
  const foreign='f'.repeat(64);
  return {
    root,engine,transport,network,relay,foreign,objects,runtime,request,maintenance,
    get stops(){return stops},
    clearUnknownIntent(){const db=new DatabaseSync(journal);try{db.exec('DELETE FROM intents')}finally{db.close()}},
    addForeignMount(){objects[foreign]={Id:foreign,Mounts:[{Type:'bind',Source:root,Destination:'/shared',RW:true}]}},
    removeForeignMount(){delete objects[foreign]},
    holdNextEngineInspection(){let entered!:()=>void,release!:()=>void;const wait=new Promise<void>(r=>entered=r),resume=new Promise<void>(r=>release=r);held={entered,release:resume};return {wait,release}},
    async close(){await runtime.stop();rmSync(root,{recursive:true,force:true})},
  };
}

/** All three scenarios must reject both unknown execution and foreign mount before stopping. */
export async function proveOwnedEngineStopped(f:Awaited<ReturnType<typeof createMaintenanceRuntime>>) {
  const blocked=await f.maintenance();assert.equal((await blocked.json()).state,'admission_closed');assert.equal(f.stops,0);
  f.clearUnknownIntent();f.addForeignMount();
  const foreignBlocked=await f.maintenance();assert.equal((await foreignBlocked.json()).state,'admission_closed');assert.equal(f.stops,0);
  f.removeForeignMount();
  const [response,parallel]=await Promise.all([f.maintenance(),f.maintenance()]);
  assert.equal(response.status,200);assert.equal((await response.json()).state,'engine_stopped');assert.equal((await parallel.json()).state,'engine_stopped');
  assert.equal(f.stops,3);assert.equal(f.objects[f.relay].State.Running,false);assert.equal(f.objects[f.engine].State.Running,false);assert.equal(f.objects[f.transport].State.Running,false);
}
