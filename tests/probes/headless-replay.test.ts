import assert from 'node:assert/strict';import {test} from 'node:test';
test('consumed_headless_volumes_cannot_be_recreated_by_replay_and_foreign_volumes_are_refused',async()=>{
 const module=await import('../../probes/docker.ts');let calls=0;
 const guard=(module as any).verifyReusableVolumes;assert.ok(guard,'Reusable volume guard missing');
 const manifest={owner:'sf-p4-fixture',resources:[{kind:'volume',name:'sf-p4-fixture-assets',removed:false}]};
 const docker={owner:manifest.owner,async command(){calls++;return JSON.stringify([{Name:'sf-p4-fixture-assets',Labels:{'sf.p4.owner':manifest.owner}}]);}};
 await guard(docker,manifest,['sf-p4-fixture-assets']);assert.equal(calls,1);
 await assert.rejects(guard(docker,{...manifest,resources:[{...manifest.resources[0],removed:true}]},['sf-p4-fixture-assets']),/consumed/);assert.equal(calls,1);
 await assert.rejects(guard({...docker,async command(){throw Error('absent');}},manifest,['sf-p4-fixture-assets']),/absent/);
 await assert.rejects(guard({...docker,async command(){return JSON.stringify([{Name:'sf-p4-fixture-assets',Labels:{'sf.p4.owner':'foreign'}}]);}},manifest,['sf-p4-fixture-assets']),/ownership/);
});
