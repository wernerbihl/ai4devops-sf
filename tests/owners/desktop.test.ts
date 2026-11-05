import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installCompanion} from '../../src/install/companion-launch.ts';
import {createDesktopNavigation} from '../../src/owners/desktop.ts';

test('admitted native open registers the exact private relay and launches a token-free session URI',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-desktop-'));const requestDir=join(root,'auth-request');mkdirSync(requestDir,{mode:0o700});const code=join(root,'fake-code');const log=join(root,'launch.json');const extension=new URL('../../runtime/vscode-companion/extension.cjs',import.meta.url).pathname;
 writeFileSync(code,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--open-url'))fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));if(process.argv.includes('--new-window')){const c=require(${JSON.stringify(extension)});const p=process.env.SF_COMPANION_REQUEST;const r=JSON.parse(fs.readFileSync(p));const values=JSON.parse(fs.readFileSync(r.settingsPath));const v={ConfigurationTarget:{Global:1},workspace:{getConfiguration(){return {inspect(k){return {globalValue:values[k]}},async update(k,x){values[k]=x;fs.writeFileSync(r.settingsPath,JSON.stringify(values))}}}}};c.runRegistration(v,p).catch(()=>process.exitCode=1)}\n`,{mode:0o700});
 await installCompanion({root,installationId:'fixture',codeExecutable:code});writeFileSync(join(root,'startup.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',codeExecutable:code,requestDir}),{mode:0o600});
 let current=true;const launcher={async ensureStarted(){return {connect:async()=>({send(){},recv:()=>new Promise<null>(()=>{}),close(){}})}}};
 try {
  const nav=await createDesktopNavigation({root,installationId:'fixture',runtimeOwnerId:'rt-fixture',identity:{ownerId:'vscode',providerId:'copilot',sessionId:'ahp-session:/fixture',chatId:'ahp-chat:/fixture'},assertCurrent(){if(!current)throw Error('revoked')},launcher});
  try {assert.match(nav.connectionAuthority,/^127\.0\.0\.1__\d+$/);const uri='vscode-insiders://agents/agent-host-session/ahp-session/fixture';await nav.launch(uri);const args=JSON.parse(readFileSync(log,'utf8')) as string[];assert.ok(args.includes('--open-url'));assert.ok(args.includes(uri));assert.doesNotMatch(args.join(' '),/tkn=|connectionToken/)}finally{current=false;await nav.close()}
 }finally{rmSync(root,{recursive:true});}
});
