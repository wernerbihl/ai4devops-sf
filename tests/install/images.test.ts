import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipes, nativeServerAsset, verifySha256 } from '../../src/install/images.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('image recipes clear inherited metadata and use only pinned build inputs', () => {
  const recipes=buildRecipes();
  for(const recipe of Object.values(recipes)) {
    assert.match(recipe,/^FROM node@sha256:[a-f0-9]{64} AS base\nFROM scratch\nCOPY --from=base \/ \/\n/m);
    assert.doesNotMatch(recipe,/^ENTRYPOINT/m);
    assert.match(recipe,/ENV PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
  }
  assert.match(recipes.native,/ADD vscode-server\.tar\.gz \/opt\/software-factory\/vscode\//);
  assert.match(recipes.proxy,/COPY connect\.cjs \/opt\/software-factory\/connect\.cjs/);
  assert.equal(nativeServerAsset.commit,'e576c7bbeb39772a1d1ebe472545def0d93e6d8b');
  assert.match(nativeServerAsset.sha256,/^[a-f0-9]{64}$/);
});

test('archive checksum rejects changed bytes', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sf-image-')); const file=join(dir,'archive');
  try { writeFileSync(file,'fixture'); await verifySha256(file,createHash('sha256').update('fixture').digest('hex')); await assert.rejects(verifySha256(file,'0'.repeat(64))); }
  finally {rmSync(dir,{recursive:true});}
});

test('image build refuses an unverified archive before touching Docker', async () => {
  const { buildImages } = await import('../../src/install/images.ts');
  const dir=mkdtempSync(join(tmpdir(),'sf-image-')); const file=join(dir,'archive');
  let calls=0;
  try {
    writeFileSync(file,'not the official archive');
    await assert.rejects(buildImages({installationId:'fixture',installationRoot:dir,archive:file,docker:{async command(){calls++;return ''}}}), /checksum/i);
    assert.equal(calls,0);
  } finally {rmSync(dir,{recursive:true});}
});

test('native archive download will not overwrite an existing file', async () => {
  const { downloadNativeServer } = await import('../../src/install/images.ts');
  const { readFileSync } = await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'sf-download-'));const path=join(dir,'archive');
  try {writeFileSync(path,'owned');await assert.rejects(downloadNativeServer(path));assert.equal(readFileSync(path,'utf8'),'owned');}
  finally {rmSync(dir,{recursive:true});}
});

test('owned image build intent is exclusive and survives uncertainty', async () => {
  const { createImageBuildIntent } = await import('../../src/install/images.ts');
  const { readFileSync } = await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'sf-intent-'));
  try {
    createImageBuildIntent(dir,{installationId:'fixture',sourceFingerprint:'a'.repeat(64)});
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'image-build-intent.json'),'utf8')),{schemaVersion:1,installationId:'fixture',sourceFingerprint:'a'.repeat(64)});
    assert.throws(()=>createImageBuildIntent(dir,{installationId:'fixture',sourceFingerprint:'a'.repeat(64)}));
  } finally {rmSync(dir,{recursive:true});}
});

test('owned image build fingerprint includes the installed worker dispatcher', async () => {
  const { expectedImageBuild } = await import('../../src/install/images.ts');
  const { workerProgram } = await import('../../src/owners/worker.ts');
  assert.equal(expectedImageBuild().workerProgramSha256,createHash('sha256').update(workerProgram).digest('hex'));
});

test('owned image build fingerprint binds the installed builder source', async () => {
  const { expectedImageBuild } = await import('../../src/install/images.ts');
  const { readFileSync } = await import('node:fs');
  assert.equal(expectedImageBuild().builderSha256,createHash('sha256').update(readFileSync(new URL('../../src/install/images.ts',import.meta.url))).digest('hex'));
});
