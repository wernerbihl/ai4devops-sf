import assert from 'node:assert/strict';import {test} from 'node:test';
import {execFileSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
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
  rmSync(join(root,'src/extra.ts'));writeFileSync(join(root,'.gitignore'),'src/ignored.ts\n');writeFileSync(join(root,'src/ignored.ts'),'ignored code still consumed by tsc');assert.throws(()=>produceReleaseProvenance(root),/Uncommitted release input/);rmSync(join(root,'src/ignored.ts'));rmSync(join(root,'src/main.ts'));assert.throws(()=>produceReleaseProvenance(root));
 }finally{rmSync(root,{recursive:true,force:true});}
});

function stagedFixture() {
 const root=mkdtempSync(join(tmpdir(),'sf-release-index-'));
 const git=(args:string[],input?:string)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe'],...(input===undefined?{}:{input})});
 for(const dir of ['src','dist','bin','release'])mkdirSync(join(root,dir));
 writeFileSync(join(root,'package.json'),'{"version":"0.1.0"}');writeFileSync(join(root,'package-lock.json'),'{"packages":{}}');writeFileSync(join(root,'src/main.ts'),'source');writeFileSync(join(root,'dist/main.js'),'compiled');writeFileSync(join(root,'bin/cli.mjs'),'entry');
 writeFileSync(join(root,'src/keep.ts'),'keep');
 git(['init','-q']);git(['add','package.json','package-lock.json','src','bin']);git(['-c','user.name=Release fixture','-c','user.email=release@example.test','commit','-qm','fixture']);
 return {root,git,close(){rmSync(root,{recursive:true,force:true});}};
}
for(const change of ['content','add','delete','mode','conflict'] as const)test('release_producer_rejects_staged_'+change+'_even_with_restored_working_bytes',()=>{
 const f=stagedFixture();
 try{
  produceReleaseProvenance(f.root);
  if(change==='content'){writeFileSync(join(f.root,'src/main.ts'),'staged change');f.git(['add','src/main.ts']);writeFileSync(join(f.root,'src/main.ts'),'source');}
  if(change==='add'){writeFileSync(join(f.root,'src/extra.ts'),'staged extra');f.git(['add','src/extra.ts']);rmSync(join(f.root,'src/extra.ts'));}
  if(change==='delete')f.git(['rm','--cached','src/main.ts']);
  if(change==='mode')f.git(['update-index','--chmod=+x','src/main.ts']);
  if(change==='conflict'){
   const base=f.git(['rev-parse','HEAD:src/main.ts']).trim();const ours=f.git(['hash-object','-w','--stdin'],'ours').trim();const theirs=f.git(['hash-object','-w','--stdin'],'theirs').trim();
   f.git(['update-index','--index-info'],`0 ${'0'.repeat(40)}\tsrc/main.ts\n100644 ${base} 1\tsrc/main.ts\n100644 ${ours} 2\tsrc/main.ts\n100644 ${theirs} 3\tsrc/main.ts\n`);
  }
  assert.throws(()=>produceReleaseProvenance(f.root),/index|inventory/i);
  assert.throws(()=>produceReleaseProvenance(f.root,true),/index|inventory/i);
 }finally{f.close();}
});
test('release_producer_allows_staged_generated_metadata_and_nonproduction_docs',()=>{
 const f=stagedFixture();try{
  const release=produceReleaseProvenance(f.root);writeFileSync(join(f.root,'README.md'),'outside production inventory');f.git(['add','README.md','release/provenance.json','release/runtime-lock.json']);
  assert.equal(produceReleaseProvenance(f.root,true).releaseDigest,release.releaseDigest);
 }finally{f.close();}
});


test('release_producer_accepts_committed_production_deletion',()=>{
 const f=stagedFixture();try{f.git(['rm','src/main.ts']);f.git(['-c','user.name=Release fixture','-c','user.email=release@example.test','commit','-qm','remove input']);assert.equal(produceReleaseProvenance(f.root).sourceCommit,f.git(['rev-parse','HEAD']).trim());}finally{f.close();}
});
test('release_producer_accepts_autocrlf_true_clean_clone_with_tracked_LF_policy_and_binary_preservation',()=>{
 const f=stagedFixture(),clone=mkdtempSync(join(tmpdir(),'sf-release-eol-'));
 try{
  const attributes=new URL('../../.gitattributes',import.meta.url);writeFileSync(join(f.root,'.gitattributes'),existsSync(attributes)?readFileSync(attributes):'');
  writeFileSync(join(f.root,'src/main.ts'),'source\n');writeFileSync(join(f.root,'bin/cli.mjs'),'entry\n');mkdirSync(join(f.root,'runtime'));const binary=Buffer.from([0x50,0x4b,0x03,0x04,0x00,0x0d,0x0a,0xff]);writeFileSync(join(f.root,'runtime/companion.vsix'),binary);
  f.git(['add','.gitattributes','src','bin','runtime']);f.git(['-c','user.name=Release fixture','-c','user.email=release@example.test','commit','-qm','LF and binary inputs']);
  execFileSync('git',['clone','--config','core.autocrlf=true','--no-local',f.root,clone],{stdio:'pipe'});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:clone,encoding:'utf8'});assert.equal(git('status','--porcelain'),'');
  mkdirSync(join(clone,'dist'));mkdirSync(join(clone,'release'));writeFileSync(join(clone,'dist/main.js'),'compiled');
  const source=produceReleaseProvenance(clone);assert.ok(source.sourceFiles['.gitattributes']);assert.equal(readFileSync(join(clone,'src/main.ts'),'utf8'),'source\n');assert.deepEqual(readFileSync(join(clone,'runtime/companion.vsix')),binary);
 }finally{f.close();rmSync(clone,{recursive:true,force:true});}
});
