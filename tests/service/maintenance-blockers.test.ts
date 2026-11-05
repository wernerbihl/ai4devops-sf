import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createFixture} from '../helpers/store.ts';import {fingerprint} from '../../src/storage/database.ts';import {inspectMaintenanceBlockers} from '../../src/service/maintenance-blockers.ts';
test('maintenance retains unresolved engine, API and Git writer identities',async()=>{
 const f=createFixture();try{
  const dir=join(f.directory,'kestra','journal');mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'execution-intents.sqlite');writeFileSync(path,'',{mode:0o600});const db=new DatabaseSync(path);db.exec('CREATE TABLE intents(attempt TEXT PRIMARY KEY,request_key TEXT,version INTEGER,body TEXT)');db.prepare('INSERT INTO intents VALUES(?,?,0,?)').run('engine-attempt','key',JSON.stringify({phase:'sent',start:{attemptId:'engine-attempt'}}));db.close();
  mkdirSync(join(f.directory,'.workspace-manager.lock'));f.store.claimApiRequest('uncertain-api',{method:'POST'});
  const result=await inspectMaintenanceBlockers(f.directory,f.store);assert.ok(result.some(x=>x.kind==='git'));assert.ok(result.some(x=>x.kind==='api'&&x.identity===fingerprint('uncertain-api')));assert.ok(result.some(x=>x.kind==='engine'&&x.identity==='engine-attempt'));
 }finally{f.close()}
});
test('unrecognized pending effects remain blockers while local selection audit is retained',async()=>{
 const f=createFixture();try{f.store.enqueueAction({key:'unknown',kind:'future.external',payload:{}});f.store.enqueueAction({key:'selection',kind:'dispatch.selection',payload:{}});const blockers=await inspectMaintenanceBlockers(f.directory,f.store);const actionIds=blockers.filter(x=>x.kind==='action').map(x=>x.identity);assert.equal(actionIds.length,1);assert.equal(actionIds[0],f.store.getActionByKey('unknown')!.id);assert.ok(f.store.getActionByKey('selection'))}finally{f.close()}
});
