import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {copyRuntime} from '../../src/install/runtime-copy.ts';

test('installed runtime copies Node and only production dependencies without a sibling checkout',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf runtime 工場-'));const target=join(root,'runtime');
 try {
  const installation=await copyRuntime({sourceRoot:resolve('.'),target});
  assert.equal(existsSync(join(target,'node_modules','@vscode','vsce')),false);
  assert.equal(existsSync(join(target,'package-lock.json')),true);
  assert.equal(existsSync(installation.node),true);assert.equal(existsSync(installation.serviceEntry),true);
  const result=spawnSync(installation.node,['--input-type=module','-e',`import(${JSON.stringify('file://'+join(target,'dist/service/config.js'))}).then(()=>process.stdout.write('ready'))`],{cwd:root,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:root}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'ready');
  await assert.rejects(copyRuntime({sourceRoot:resolve('.'),target}),/exist/i);
 } finally {rmSync(root,{recursive:true});}
});
test('a changed runtime can stage an immutable build-labelled copy of the same package version',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-runtime-revision-'));try{const result=await copyRuntime({sourceRoot:resolve('.'),target:join(root,'staged'),installationVersion:'0.1.0+reconfig.fixture'});assert.equal(result.version,'0.1.0+reconfig.fixture')}finally{rmSync(root,{recursive:true,force:true})}
});
