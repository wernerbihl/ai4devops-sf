import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planInstall} from '../../src/install/plan.ts';
import {applyInstall} from '../../src/install/install.ts';
const base='node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c';

test('preview has zero persistent changes and a failed selected-root bind publishes no installation',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'sf-plan-'));const root=join(parent,'factory');const auth=join(parent,'auth');const config=join(parent,'config');mkdirSync(auth,{mode:0o700});mkdirSync(join(auth,'vault'),{mode:0o700});mkdirSync(config,{mode:0o700});
 writeFileSync(join(auth,'vault','native-copilot'),'fixed-nonsecret-fixture',{mode:0o600});writeFileSync(join(auth,'native-copilot.json'),JSON.stringify({schemaVersion:1,resource:'https://api.github.com',scopes:['read:user','user:email'],account:{id:'one',label:'One'},ref:'native-copilot'}),{mode:0o600});
 const executable=join(parent,'code');writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});let pulled=false;
 const docker={async command(args:string[]){if(args[0]==='version')return '"29.0.0"';if(args[0]==='image'&&!pulled)throw Error('missing image');if(args[0]==='pull'){pulled=true;return ''}if(args[0]==='image')return JSON.stringify([{RepoDigests:[base],Os:'linux',Architecture:'amd64'}]);if(args[0]==='run')throw Error('bind mapping is unavailable');throw Error('unexpected')}};
 try {
  const before=readdirSync(parent).sort();const plan=await planInstall({directory:root,taktSeconds:60,ownerId:'vscode',providers:['copilot'],stagedAuthRoot:auth,codeExecutable:executable,sourceRoot:process.cwd()},{docker});
  assert.equal(plan.bindProof,'pending');assert.deepEqual(readdirSync(parent).sort(),before);assert.equal(existsSync(root),false);
  const locator=join(config,'ai4devops-sf','installation.json');await assert.rejects(applyInstall(plan,{docker,locatorPath:locator}),/selected installation root|bind/i);
  assert.equal(existsSync(root),false);assert.equal(existsSync(locator),false);
 } finally {rmSync(parent,{recursive:true});}
});

test('distinct setup IDs share one per-user lock before either can create a second installation',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'sf-concurrent-install-'));
 const auth=join(parent,'auth'),config=join(parent,'config'),firstRoot=join(parent,'first'),secondRoot=join(parent,'second');
 mkdirSync(join(auth,'vault'),{recursive:true,mode:0o700});mkdirSync(config,{mode:0o700});
 writeFileSync(join(auth,'vault','native-copilot'),'fixed-nonsecret-fixture',{mode:0o600});
 writeFileSync(join(auth,'native-copilot.json'),JSON.stringify({schemaVersion:1,resource:'https://api.github.com',scopes:['read:user','user:email'],account:{id:'one',label:'One'},ref:'native-copilot'}),{mode:0o600});
 const executable=join(parent,'code');writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
 let entered!:()=>void,enteredSecond!:()=>void,release!:()=>void;const enteredPull=new Promise<void>(r=>entered=r),secondPull=new Promise<void>(r=>enteredSecond=r),releasePull=new Promise<void>(r=>release=r);let pulls=0;
 const docker={async command(args:string[]){if(args[0]==='version')return '"29.0.0"';if(args[0]==='image')throw Error('missing image');if(args[0]==='pull'){pulls++;entered();if(pulls===2)enteredSecond();await releasePull;throw Error('fixture stops before bind')}throw Error('unexpected')}};
 try{
  const plan=await planInstall({directory:firstRoot,taktSeconds:60,ownerId:'vscode',providers:['copilot'],stagedAuthRoot:auth,codeExecutable:executable,sourceRoot:process.cwd()},{docker});
  const locator=join(config,'installation.json');const first=applyInstall({...plan,id:'first-id'},{docker,locatorPath:locator}).catch(error=>error);
  await enteredPull;const second=applyInstall({...plan,id:'second-id',directory:secondRoot},{docker,locatorPath:locator}).catch(error=>error);
  const observed=await Promise.race([second.then(error=>({kind:'rejected' as const,error})),secondPull.then(()=>({kind:'second-pull' as const})),new Promise<{kind:'timeout'}>(resolve=>{const timer=setTimeout(()=>resolve({kind:'timeout'}),2000);timer.unref()})]);
  release();await first;await second;
  assert.equal(observed.kind,'rejected','second setup must be excluded before Docker');
  if(observed.kind==='rejected')assert.match(String(observed.error),/administration/i);
  assert.equal(pulls,1,'second setup must not reach a persistent Docker operation');
  assert.equal(existsSync(secondRoot),false,'second setup must not create its root');
  const {saveInstallation}=await import('../../src/install/locator.ts');await saveInstallation({schemaVersion:1,id:'existing',root:firstRoot,node:join(firstRoot,'runtime/0.1.0/node'),serviceEntry:join(firstRoot,'runtime/0.1.0/dist/service/main.js'),version:'0.1.0'},locator);
  await assert.rejects(applyInstall({...plan,id:'second-id',directory:secondRoot},{docker,locatorPath:locator}),/already exists/i);assert.equal(existsSync(secondRoot),false);
 }finally{release();rmSync(parent,{recursive:true,force:true})}
});
