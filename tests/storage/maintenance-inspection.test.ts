import test from 'node:test';import assert from 'node:assert/strict';import {createFixture} from '../helpers/store.ts';
test('maintenance inspection includes unresolved API and historical broker effects',()=>{
 const f=createFixture();try{
  f.store.claimApiRequest('unknown-api',{method:'POST'});f.store.claimApiRequest('finished-api',{method:'POST'});f.store.finishApiRequest('finished-api',{method:'POST'},{status:200,body:{}});
  f.store.broker.claim({attemptId:'old-attempt',fence:7,key:'unknown-native',payload:{operation:'native.start'}});
  const result=f.store.pendingExternalEffects();assert.deepEqual(result.apiKeys,['unknown-api']);assert.deepEqual(result.nativeWrites,[{attemptId:'old-attempt',fence:7,key:'unknown-native',state:'pending'}]);
 }finally{f.close()}
});
