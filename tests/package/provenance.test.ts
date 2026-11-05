import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
test('offline_release_verifier_rejects_changed_artifact_source_digest_and_extra_payload', async () => {
  const module=await import('../../src/release/provenance.ts').catch(()=>undefined);
  assert.ok(module,'Offline release verifier is missing');
  const root=mkdtempSync(join(tmpdir(),'sf-release-'));mkdirSync(join(root,'dist'),{recursive:true});mkdirSync(join(root,'bin'));
  const artifacts={'dist/service.js':sha('verified service')};
  const core={schemaVersion:1,version:'0.1.0',sourceCommit:'a'.repeat(40),sourceFiles:{'src/service.ts':sha('source')},artifacts};
  const manifest={...core,releaseDigest:sha(JSON.stringify(core))};
  mkdirSync(join(root,'release'));writeFileSync(join(root,'dist/service.js'),'verified service');
  const save=(value:any)=>writeFileSync(join(root,'release/provenance.json'),JSON.stringify(value));
  try {
    save(manifest);assert.equal(module.verifyReleaseProvenance(root).sourceCommit,'a'.repeat(40));
    writeFileSync(join(root,'dist/service.js'),'tampered');assert.throws(()=>module.verifyReleaseProvenance(root),/artifact/i);
    writeFileSync(join(root,'dist/service.js'),'verified service');save({...manifest,sourceCommit:'b'.repeat(40)});assert.throws(()=>module.verifyReleaseProvenance(root),/digest/i);
    save({...manifest,releaseDigest:'0'.repeat(64)});assert.throws(()=>module.verifyReleaseProvenance(root),/digest/i);
    save(manifest);writeFileSync(join(root,'dist/extra.js'),'unrecorded');assert.throws(()=>module.verifyReleaseProvenance(root),/inventory/i);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('owned_image_label_verification_requires_commit_and_release_digest', async()=>{
  const module=await import('../../src/release/provenance.ts').catch(()=>undefined);assert.ok(module,'Offline release verifier is missing');
  const expected={sourceCommit:'a'.repeat(40),releaseDigest:'b'.repeat(64)};
  assert.equal(module.imageReleaseMatches({'sf.source':expected.sourceCommit,'sf.release':expected.releaseDigest},expected),true);
  for(const labels of [{},{'sf.source':'c'.repeat(40),'sf.release':expected.releaseDigest},{'sf.source':expected.sourceCommit,'sf.release':'c'.repeat(64)}])assert.equal(module.imageReleaseMatches(labels,expected),false);
});
