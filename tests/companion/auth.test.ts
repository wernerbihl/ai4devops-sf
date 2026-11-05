import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCompanionAuth} from '../../src/install/companion-auth.ts';
const require=createRequire(import.meta.url);
const companion=require('../../runtime/vscode-companion/extension.cjs');

test('VS Code session reaches only the protected native vault with exact Copilot scopes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-companion-'));const requestDir=join(root,'request');mkdirSync(requestDir,{mode:0o700});mkdirSync(join(root,'vault'),{mode:0o700});
 const broker=await startCompanionAuth({root,requestDir,interactive:true});
 try {
  const vscode={authentication:{async getSession(provider:string,scopes:string[],options:unknown){assert.equal(provider,'github');assert.deepEqual(scopes,['read:user','user:email']);assert.deepEqual(options,{createIfNone:true});return {accessToken:'fixed-nonsecret-fixture',account:{id:'user-1',label:'Fixture'},scopes}}}};
  await companion.runAuthentication(vscode,broker.requestPath);const result=await broker.completed;
  assert.equal(result.account.id,'user-1');assert.equal(result.ref,'native-copilot');
  assert.equal(readFileSync(join(root,'vault','native-copilot'),'utf8'),'fixed-nonsecret-fixture');
  assert.doesNotMatch(readFileSync(join(root,'native-copilot.json'),'utf8'),/fixed-nonsecret-fixture/);
 } finally {await broker.close();rmSync(root,{recursive:true});}
});

test('companion refuses broad scopes or a changed selected account before sending credentials',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-companion-'));const requestDir=join(root,'request');mkdirSync(requestDir,{mode:0o700});mkdirSync(join(root,'vault'),{mode:0o700});
 const broker=await startCompanionAuth({root,requestDir,interactive:false,account:{id:'selected',label:'Selected'}});
 try {
  const vscode={authentication:{async getSession(){return {accessToken:'fixed-nonsecret-fixture',account:{id:'other',label:'Other'},scopes:['read:user','user:email','repo']}}}};
  await assert.rejects(companion.runAuthentication(vscode,broker.requestPath));assert.equal(existsSync(join(root,'vault','native-copilot')),false);
 } finally {await broker.close();rmSync(root,{recursive:true});}
});

test('broker rejects browser origins and replay of its one-use credential',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-companion-'));const requestDir=join(root,'request');mkdirSync(requestDir,{mode:0o700});mkdirSync(join(root,'vault'),{mode:0o700});
 const broker=await startCompanionAuth({root,requestDir,interactive:true});
 try {
  const request=JSON.parse(readFileSync(broker.requestPath,'utf8'));
  const body=JSON.stringify({nonce:request.nonce,resource:'https://api.github.com',scopes:['read:user','user:email'],account:{id:'fixture',label:'Fixture'},token:'fixed-nonsecret-fixture'});
  const headers={authorization:'Bearer '+request.bearer,'content-type':'application/json'};
  assert.equal((await fetch(request.url,{method:'POST',headers:{...headers,origin:'http://127.0.0.1'},body})).status,401);
  assert.equal((await fetch(request.url,{method:'POST',headers,body})).status,200);await broker.completed;
  assert.equal((await fetch(request.url,{method:'POST',headers,body})).status,401);
 } finally {await broker.close();rmSync(root,{recursive:true});}
});

test('runtime credential reader requires the exact protected Copilot metadata',async()=>{
 const {loadCompanionCredential}=await import('../../src/install/companion-auth.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-companion-'));const requestDir=join(root,'request');mkdirSync(requestDir,{mode:0o700});mkdirSync(join(root,'vault'),{mode:0o700});
 const broker=await startCompanionAuth({root,requestDir,interactive:true});
 try {
  const vscode={authentication:{async getSession(){return {accessToken:'fixed-nonsecret-fixture',account:{id:'one',label:'One'},scopes:['read:user','user:email']}}}};
  await companion.runAuthentication(vscode,broker.requestPath);await broker.completed;
  const value=loadCompanionCredential(root,{ref:'native-copilot',resource:'https://api.github.com',scopes:['read:user','user:email']});
  assert.equal(value.account.id,'one');assert.equal(value.token,'fixed-nonsecret-fixture');
  assert.throws(()=>loadCompanionCredential(root,{ref:'other',resource:'https://api.github.com',scopes:['read:user','user:email']}));
  assert.throws(()=>loadCompanionCredential(root,{ref:'native-copilot',resource:'https://api.github.com',scopes:['repo']}));
 } finally {await broker.close();rmSync(root,{recursive:true});}
});
