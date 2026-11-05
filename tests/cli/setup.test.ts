import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveDefaults} from '../../src/install/defaults.ts';
import {runSetup} from '../../src/cli/setup.ts';

test('setup restores answers, previews, and cancellation retains only the protected GUI profile',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'sf-setup-cli-'));const code=join(parent,'code');writeFileSync(code,'#!/bin/sh\nexit 0\n',{mode:0o700});const config=join(parent,'config');mkdirSync(config,{mode:0o700});const defaults=join(config,'defaults.json');
 const old={directory:join(parent,'factory'),taktSeconds:60,ownerId:'vscode' as const,providers:['copilot' as const,'codex' as const],codeExecutable:code};saveDefaults(old,defaults);const original=readFileSync(defaults,'utf8');
 const docker={async command(args:string[]){if(args[0]==='version')return '"29.0.0"';throw Error('base missing')}};
 const prompts:string[]=[];const output:string[]=[];const replies=['','','','','','n'];
 try {
  const result=await runSetup({out:s=>output.push(s),err:s=>output.push(s),ask:async prompt=>{prompts.push(prompt);return replies.shift()!}},{docker,defaultsPath:defaults,sourceRoot:process.cwd(),tempParent:parent,authenticate:async input=>{
   writeFileSync(join(input.root,'vault','native-copilot'),'fixed-nonsecret-fixture',{mode:0o600});writeFileSync(join(input.root,'native-copilot.json'),JSON.stringify({schemaVersion:1,resource:'https://api.github.com',scopes:['read:user','user:email'],account:{id:'one',label:'One'},ref:'native-copilot'}),{mode:0o600});return {account:{id:'one',label:'One'},launcher:{stop(){}}} as any;
  }});
  assert.equal(result,0);assert.ok(prompts.some(p=>p.includes('Install (Y/n)')));assert.ok(prompts.some(p=>p.includes('copilot,codex')));assert.equal(readFileSync(defaults,'utf8'),original);assert.equal(existsSync(old.directory),false);
  const staged=readdirSync(parent).find(name=>name.startsWith('sf-setup-'))!;assert.ok(staged);assert.equal(existsSync(join(parent,staged,'vault','native-copilot')),false);assert.ok(output.some(line=>line.includes(join(parent,staged))));
 } finally {rmSync(parent,{recursive:true});}
});
test('setup previews an existing installation without reauthentication or persistent changes on cancellation',async()=>{
 const {saveInstallation}=await import('../../src/install/locator.ts');const parent=mkdtempSync(join(tmpdir(),'sf-reconfigure-preview-'));const config=join(parent,'config');mkdirSync(config,{mode:0o700});const root=join(parent,'factory');mkdirSync(root,{mode:0o700});const locator=join(config,'installation.json');const installation={schemaVersion:1 as const,id:'fixture',root,node:join(root,'runtime','0.1.0','node'),serviceEntry:join(root,'runtime','0.1.0','dist','service','main.js'),version:'0.1.0'};await saveInstallation(installation,locator);const output:string[]=[],answers=['','60','n'];let authenticated=false;try{const result=await runSetup({out:s=>output.push(s),err:s=>output.push(s),ask:async()=>answers.shift()!},{locatorPath:locator,defaultsPath:join(config,'defaults.json'),sourceRoot:process.cwd(),tempParent:parent,authenticate:async()=>{authenticated=true;throw Error('unexpected sign in')}});assert.equal(result,0);assert.equal(authenticated,false);assert.ok(output.some(s=>/reconfigur/i.test(s)));assert.deepEqual(readdirSync(config),['installation.json'])}finally{rmSync(parent,{recursive:true,force:true})}
});
