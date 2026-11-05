import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyPlaceholder, finalizeProxyPolicy } from '../../src/service/proxy-policy.ts';

test('proxy policy writes the owned placeholder inode once and refuses unknown content', () => {
  const root=mkdtempSync(join(tmpdir(),'sf-policy-')); const path=join(root,'proxy.json');
  try {
    createProxyPlaceholder(path);
    const inode=statSync(path).ino;
    const policy={schemaVersion:2,value:'fixture'};
    finalizeProxyPolicy(path,policy);
    assert.equal(statSync(path).ino,inode);
    finalizeProxyPolicy(path,policy);
    assert.throws(()=>finalizeProxyPolicy(path,{schemaVersion:2,value:'different'}));
    writeFileSync(path,'{"partial"');
    assert.throws(()=>finalizeProxyPolicy(path,policy));
  } finally {rmSync(root,{recursive:true});}
});
