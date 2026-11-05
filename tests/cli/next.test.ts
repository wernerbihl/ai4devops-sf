import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPrivateControl } from '../../src/service/control.ts';
import { requestNext } from '../../src/cli/next.ts';

test('next authenticates to the existing private controller exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-next-'));
  mkdirSync(join(root, 'vault'), { mode: 0o700 });
  const key = Buffer.alloc(32, 7);
  writeFileSync(join(root, 'vault', 'private-control'), key, { mode: 0o600 });
  let calls = 0;
  const control = await startPrivateControl({ root, key, async handle(method, path, input) {
    assert.equal(method, 'POST'); assert.equal(path, '/next'); assert.equal(input.key, 'stable-key'); calls++;
    return { admitted: false, reason: 'empty' };
  } });
  try { assert.deepEqual(await requestNext(root, 'stable-key'), { admitted: false, reason: 'empty' }); assert.equal(calls, 1); }
  finally { await control.close(); rmSync(root, { recursive: true }); }
});

test('durably records the original key before dispatch and only looks it up after a lost reply', async () => {
  const { dispatchNext } = await import('../../src/cli/next.ts');
  const { readFileSync } = await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'sf-next-durable-')); mkdirSync(join(root,'vault'),{mode:0o700});
  const key=Buffer.alloc(32,8); writeFileSync(join(root,'vault','private-control'),key,{mode:0o600});
  let dispatches=0;let lookups=0;let original='';let completed=false;
  const control=await startPrivateControl({root,key,async handle(_method,path,input){
    if(path==='/next') {dispatches++; original=String(input.key); const journal=JSON.parse(readFileSync(join(root,'cli-next.json'),'utf8')); assert.equal(journal.key,original); assert.equal(journal.state,'pending'); throw Error('lost reply');}
    if(path==='/dispatch-status') {lookups++;assert.equal(input.key,original);return completed?{state:'complete',body:{admitted:false,reason:'empty'}}:{state:'pending'};}
    throw Error('unexpected');
  }});
  try {
    await assert.rejects(dispatchNext(root),/not confirmed/i);
    assert.deepEqual(await dispatchNext(root),{state:'pending',key:original});
    completed=true;
    assert.deepEqual(await dispatchNext(root),{state:'complete',key:original,body:{admitted:false,reason:'empty'}});
    assert.equal(dispatches,1);assert.equal(lookups,2);
    const record=JSON.parse(readFileSync(join(root,'cli-next.json'),'utf8'));assert.equal(record.key,original);assert.equal(record.state,'complete');
  } finally {await control.close();rmSync(root,{recursive:true});}
});

test('unrecognized next journal cannot trigger a dispatch', async () => {
  const { dispatchNext } = await import('../../src/cli/next.ts');
  const root=mkdtempSync(join(tmpdir(),'sf-next-invalid-'));
  try {
    writeFileSync(join(root,'cli-next.json'),JSON.stringify({schemaVersion:1,state:'pending'}),{mode:0o600});
    await assert.rejects(dispatchNext(root),/unrecognized next journal/i);
  } finally {rmSync(root,{recursive:true});}
});

test('concurrent next commands cannot allocate separate keys while one is pending', async () => {
  const { dispatchNext } = await import('../../src/cli/next.ts');
  const root=mkdtempSync(join(tmpdir(),'sf-next-lock-'));mkdirSync(join(root,'vault'),{mode:0o700});
  const key=Buffer.alloc(32,9);writeFileSync(join(root,'vault','private-control'),key,{mode:0o600});
  let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let release!:()=>void;const held=new Promise<void>(r=>release=r);let calls=0;
  const control=await startPrivateControl({root,key,async handle(_method,path){assert.equal(path,'/next');calls++;entered();await held;return {state:'complete',body:{admitted:false,reason:'empty'}}}});
  try {
    const first=dispatchNext(root);await started;
    await assert.rejects(dispatchNext(root),/already in progress/i);
    release();assert.equal((await first).state,'complete');assert.equal(calls,1);
  } finally {release();await control.close();rmSync(root,{recursive:true});}
});
