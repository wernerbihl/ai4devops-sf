import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installCompanion} from '../../src/install/companion-launch.ts';

test('installs the verified companion only into its owned private VS Code profile',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf profile 工場-'));const executable=join(root,'fake code');const log=join(root,'args.json');
 writeFileSync(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});chmodSync(executable,0o700);
 try {
  const profile=await installCompanion({root,installationId:'fixture',codeExecutable:executable});
  const args=JSON.parse(readFileSync(log,'utf8')) as string[];
  assert.deepEqual(args.slice(0,4),['--user-data-dir',profile.userDataDir,'--extensions-dir',profile.extensionsDir]);
  assert.equal(args[4],'--install-extension');assert.match(args[5]!,/software-factory-auth\.vsix$/);
  assert.ok(profile.userDataDir.startsWith(root+'/vscode-profile/'));assert.ok(profile.extensionsDir.startsWith(root+'/vscode-profile/'));
  assert.match(readFileSync(join(profile.userDataDir,'User','settings.json'),'utf8'),/chat.remoteAgentHosts/);
 } finally {rmSync(root,{recursive:true});}
});

test('launch rejects profile directories outside the owned profile',async()=>{
 const {launchCompanion}=await import('../../src/install/companion-launch.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-profile-'));const executable=join(root,'fake-code');
 writeFileSync(executable,`#!${process.execPath}\n`,{mode:0o700});
 try {
  const profile=await installCompanion({root,installationId:'fixture',codeExecutable:executable});
  const requestPath=join(root,'request.json');writeFileSync(requestPath,'{}',{mode:0o600});
  await assert.rejects(launchCompanion({profile:{...profile,userDataDir:root},installationId:'fixture',codeExecutable:executable,requestPath}),/Companion profile ownership mismatch/);
 } finally {rmSync(root,{recursive:true});}
});

test('orchestrator installs a private profile and transfers the fixture session through the broker',async()=>{
 const { authenticateViaCompanion }=await import('../../src/install/companion-launch.ts');
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'sf-companion-flow-'));const requestDir=join(root,'request');const executable=join(root,'fake-code');mkdirSync(requestDir,{mode:0o700});mkdirSync(join(root,'vault'),{mode:0o700});
 const extension=new URL('../../runtime/vscode-companion/extension.cjs',import.meta.url).pathname;
 writeFileSync(executable,`#!${process.execPath}\nif(process.argv.includes('--new-window')){const c=require(${JSON.stringify(extension)});c.runAuthentication({authentication:{getSession:async()=>({accessToken:'fixed-nonsecret-fixture',account:{id:'test',label:'Test'},scopes:['read:user','user:email']})}},process.env.SF_COMPANION_REQUEST).catch(()=>process.exitCode=1)}\n`,{mode:0o700});
 try {
  const result=await authenticateViaCompanion({root,requestDir,installationId:'fixture',codeExecutable:executable,interactive:true});
  assert.equal(result.account.id,'test');assert.equal(readFileSync(join(root,'vault','native-copilot'),'utf8'),'fixed-nonsecret-fixture');
 } finally {rmSync(root,{recursive:true});}
});
