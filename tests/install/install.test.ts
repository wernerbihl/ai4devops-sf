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
