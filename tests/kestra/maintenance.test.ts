import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../../src/storage/database.ts';
import { inspectOwnedKestra, stopOwnedKestra } from '../../src/kestra/maintenance.ts';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'sf-engine-maint-')); const id='fixture'; const owner=fingerprint({id,root}); const prefix='sf-'+owner.slice(0,24);
 mkdirSync(join(root,'kestra'),{mode:0o700});
 const engine='a'.repeat(64), transport='b'.repeat(64), network='c'.repeat(64);
 writeFileSync(join(root,'kestra','owned-resources.json'),JSON.stringify({installationId:id,owner,networkId:network,containerId:engine,transportContainerId:transport,images:['shared-engine','shared-worker']}),{mode:0o600});
 const labels={'sf.installation':id,'sf.owner':owner,'sf.component':'kestra'};
 const objects:any={
  [network]:{Id:network,Name:prefix+'-engine',Internal:true,Driver:'bridge',Labels:labels},
  [engine]:{Id:engine,Name:'/'+prefix+'-kestra',Config:{Labels:labels},HostConfig:{RestartPolicy:{Name:'no'}},State:{Running:true,Paused:false,Pid:12,Status:'running'},Mounts:[{Type:'bind',Source:join(root,'kestra','data'),Destination:'/app/data',RW:true},{Type:'bind',Source:join(root,'kestra','config'),Destination:'/app/confs',RW:false}]},
  [transport]:{Id:transport,Name:'/'+prefix+'-transport',Config:{Labels:labels},HostConfig:{RestartPolicy:{Name:'no'},NetworkMode:'container:'+engine},State:{Running:true,Paused:false,Pid:13,Status:'running'},Mounts:[]}
 };
 const calls:string[][]=[];
 const docker={async command(args:string[]){calls.push(args);if(args[0]==='container'&&args[1]==='inspect'||args[0]==='network'&&args[1]==='inspect')return JSON.stringify([objects[args[2]!]??null]);if(args[0]==='container'&&args[1]==='stop'){objects[args.at(-1)!].State={Running:false,Paused:false,Pid:0,Status:'exited'};return ''}throw Error('unexpected operation')}};
 return {root,id,engine,transport,objects,calls,docker,close(){rmSync(root,{recursive:true,force:true})}};
}
test('maintenance inspects exact owned engine resources without starting and stops only the verified containers',async()=>{
 const f=fixture();try {const inspection=await inspectOwnedKestra({id:f.id,root:f.root,docker:f.docker});assert.deepEqual(f.calls.map(x=>x[1]),['inspect','inspect','inspect']);await stopOwnedKestra({id:f.id,root:f.root,docker:f.docker},inspection);assert.equal(f.objects[f.engine].State.Running,false);assert.equal(f.objects[f.transport].State.Running,false);assert.equal(f.calls.some(x=>x.includes('start')||x.includes('rm')),false)}finally{f.close()}
});
test('changed ownership prevents any engine stop',async()=>{
 const f=fixture();try {f.objects[f.engine].Config.Labels={};await assert.rejects(inspectOwnedKestra({id:f.id,root:f.root,docker:f.docker}));assert.equal(f.calls.some(x=>x[1]==='stop'),false)}finally{f.close()}
});
test('uncertain transport stop does not stop the engine or claim success',async()=>{
 const f=fixture();try {const proof=await inspectOwnedKestra({id:f.id,root:f.root,docker:f.docker});const docker={async command(args:string[]){if(args[1]==='stop')throw Error('uncertain');return f.docker.command(args)}};await assert.rejects(stopOwnedKestra({id:f.id,root:f.root,docker},proof));assert.equal(f.objects[f.engine].State.Running,true)}finally{f.close()}
});
