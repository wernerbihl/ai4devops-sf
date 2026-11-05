import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture } from '../helpers/store.ts';
import { fakePorts } from '../helpers/fake-ports.ts';
import { startApi } from '../../src/service/api.ts';
import { createDashboardBackend } from '../../src/install/dashboard-host.ts';
const origin = 'http://127.0.0.1:5173';
test('trusted_proxy_recovery_preserves_valid_pairing_and_canonical_owner_choice', async () => {
  const f = createFixture(); const ports = fakePorts(f.store); const api = await startApi(ports.deps);
  let fail = false; let pairs = 0;
  const backend = createDashboardBackend({ document: JSON.parse(readFileSync('protocol/openapi.json', 'utf8')), async pair() { pairs++; if (fail) return { apiUrl: api.url, origin, token: 'a'.repeat(43), expiresAt: new Date(Date.now()+60_000).toISOString() }; return { apiUrl: api.url, origin, ...api.sessions.issuePairing(origin) }; } });
  try {
    await backend.repair(); const snapshot = await backend.request('get_v1_snapshot', {}) as any; assert.equal(snapshot.schemaVersion, 1);
    fail = true; await assert.rejects(backend.repair());
    assert.equal((await backend.request('get_v1_snapshot', {}) as any).schemaVersion, 1);
    assert.equal(pairs, 2); await assert.rejects(backend.request('GET http://evil.test', {}));
    await assert.rejects(backend.request('post_private_pair', {}));
    await assert.rejects(backend.request('get_v1_snapshot', { headers: { authorization: 'forged' } }));
    const key = 'adapter-native-once'; const result = await backend.request('post_v1_tasks', { body: f.request, key }) as any[];
    assert.equal(result[0].spec.ownerId, 'vscode'); assert.equal(ports.dispatches, 1);
    await backend.request('post_v1_tasks', { body: f.request, key }); assert.equal(ports.dispatches, 1);
    api.sessions.revokeAll(); await assert.rejects(backend.request('get_v1_snapshot', {}), /UNPAIRED/);
    fail = false; await backend.repair(); assert.equal((await backend.request('get_v1_snapshot', {}) as any).schemaVersion, 1);
  } finally { backend.close(); await api.close(); f.close(); }
});
test('trusted_proxy_never_retries_unknown_mutation_and_explicit_same_key_reads_original_receipt', async () => {
 const f=createFixture();const ports=fakePorts(f.store);const api=await startApi(ports.deps);let dropped=false,calls=0;
 const backend=createDashboardBackend({document:JSON.parse(readFileSync('protocol/openapi.json','utf8')),pair:async()=>({apiUrl:api.url,origin,...api.sessions.issuePairing(origin)}),fetch:async(input,init)=>{
  const response=await fetch(input,init);if(String(input).endsWith('/v1/tasks')&&init?.method==='POST'){calls++;if(!dropped){dropped=true;await response.text();throw Error('lost accepted response')}}return response;
 }});
 try{await backend.repair();const before=f.store.snapshot().tasks.length;await assert.rejects(backend.request('post_v1_tasks',{body:f.request,key:'unknown-original'}),/lost/);assert.equal(calls,1);assert.equal(f.store.snapshot().tasks.length,before+1);assert.equal(ports.dispatches,1);await backend.request('post_v1_tasks',{body:f.request,key:'unknown-original'});assert.equal(calls,2);assert.equal(f.store.snapshot().tasks.length,before+1);assert.equal(ports.dispatches,1)}finally{backend.close();await api.close();f.close()}
});
