import assert from 'node:assert/strict';import {test} from 'node:test';
import {execFileSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {produceReleaseProvenance} from '../../scripts/release-provenance.ts';
test('release_producer_accepts_exact_committed_input_and_rejects_dirty_missing_or_untracked_code',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-release-git-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:'pipe'});
 try{
  for(const dir of ['src','dist','bin','release'])mkdirSync(join(root,dir));
  writeFileSync(join(root,'package.json'),'{"version":"0.1.0"}');writeFileSync(join(root,'package-lock.json'),'{"packages":{}}');writeFileSync(join(root,'src/main.ts'),'source');writeFileSync(join(root,'dist/main.js'),'compiled');writeFileSync(join(root,'bin/cli.mjs'),'entry');
  git('init','-q');git('add','package.json','package-lock.json','src','bin');git('-c','user.name=Release fixture','-c','user.email=release@example.test','commit','-qm','fixture');
  const manifest=produceReleaseProvenance(root);assert.equal(manifest.sourceCommit,git('rev-parse','HEAD').toString().trim());assert.ok(manifest.artifacts['dist/main.js']);produceReleaseProvenance(root,true);
  writeFileSync(join(root,'src/main.ts'),'changed');assert.throws(()=>produceReleaseProvenance(root),/exact release input/);
  writeFileSync(join(root,'src/main.ts'),'source');writeFileSync(join(root,'src/extra.ts'),'untracked');assert.throws(()=>produceReleaseProvenance(root),/Uncommitted release input/);
  rmSync(join(root,'src/extra.ts'));rmSync(join(root,'src/main.ts'));assert.throws(()=>produceReleaseProvenance(root));
 }finally{rmSync(root,{recursive:true,force:true});}
});
