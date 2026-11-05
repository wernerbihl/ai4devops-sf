import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyCompanionPackage} from '../../src/install/companion-package.ts';

test('bundled VSIX and source must match the recorded packaging provenance',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sf-vsix-'));
 try {
  cpSync(fileURLToPath(new URL('../../runtime/vscode-companion/',import.meta.url)),dir,{recursive:true});
  assert.match(verifyCompanionPackage(dir),/software-factory-auth\.vsix$/);
  writeFileSync(join(dir,'extension.cjs'),'tampered');assert.throws(()=>verifyCompanionPackage(dir),/mismatch/i);
 } finally {rmSync(dir,{recursive:true});}
});
