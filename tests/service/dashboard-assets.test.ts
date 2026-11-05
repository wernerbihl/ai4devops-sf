import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApi } from '../../src/service/api.ts';
import { fakePorts } from '../helpers/fake-ports.ts';
import { createFixture } from '../helpers/store.ts';
import { createDashboardAssets } from '../../src/service/dashboard-assets.ts';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
test('standalone_serves_only_allowlisted_hash_checked_assets_under_strict_CSP',async()=>{
 const f=createFixture();const api=await startApi({...fakePorts(f.store).deps,dashboard:{root:resolve('release/dashboard')}});
 try{
  for(const path of ['/dashboard','/dashboard/11111111-1111-4111-8111-111111111111','/factory/factory-ui.css','/factory/factory-ui.js','/factory/standalone.js']){const response=await fetch(api.url+path);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy')!,/script-src 'self'; style-src 'self'/);assert.doesNotMatch(response.headers.get('content-security-policy')!,/unsafe-eval|unsafe-inline/);assert.equal(response.headers.get('set-cookie'),null)}
  for(const path of ['/dashboard/invalid','/factory/openapi.json','/factory/provenance.json','/factory/../runtime.json','/owner/v1/rpc'])assert.notEqual((await fetch(api.url+path)).status,200);
  assert.equal((await fetch(api.url+'/dashboard',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 }finally{await api.close();f.close()}
 const root=mkdtempSync(join(tmpdir(),'sf-assets-hash-'));try{cpSync('release/dashboard',root,{recursive:true});writeFileSync(join(root,'factory-ui.js'),'changed');assert.throws(()=>createDashboardAssets(root),/hash mismatch/)}finally{rmSync(root,{recursive:true,force:true})}
});
