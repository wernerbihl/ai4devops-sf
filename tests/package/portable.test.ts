import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('installs_from_tarballs_without_sibling_or_cache',async(t)=>{
  const module=await import('../../scripts/verify-package.ts').catch(()=>undefined);
  assert.ok(module,'Portable package verifier is missing');
  if(!process.env.SF_RELEASE_TARBALL){t.skip('Run with SF_RELEASE_TARBALL or npm run verify:package for actual cold install');return;}
  const root=mkdtempSync(join(tmpdir(),'sf cold 工場 '));
  try{const report=await module.verifyPackage(process.env.SF_RELEASE_TARBALL,root);
    assert.equal(report.requiresSiblingCheckout,false);assert.equal(report.requiresBun,false);
    assert.deepEqual(report.commands,['setup','next','uninstall']);assert.equal(report.privateDaemon,'passed');
  }finally{rmSync(root,{recursive:true,force:true});}
});
