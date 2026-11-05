import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDesktopRegistration} from '../../src/install/desktop-registration.ts';
const require=createRequire(import.meta.url);const companion=require('../../runtime/vscode-companion/extension.cjs');

test('desktop registration writes only an expiring relay capability to the private profile',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-registration-'));const requestDir=join(root,'request');const profileRoot=join(root,'vscode-profile');mkdirSync(profileRoot,{mode:0o700});writeFileSync(join(profileRoot,'owner.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',component:'companion-profile'}),{mode:0o600});const userData=join(profileRoot,'user-data');const user=join(userData,'User');mkdirSync(requestDir,{mode:0o700});mkdirSync(userData,{mode:0o700});mkdirSync(user,{mode:0o700});const settings=join(user,'settings.json');writeFileSync(settings,'{}',{mode:0o600});
 const capability='a'.repeat(43);const broker=await startDesktopRegistration({requestDir,profileRoot,installationId:'fixture',runtimeOwnerId:'rt-fixture',address:'127.0.0.1:32123',capability,expiresAt:Date.now()+30000});
 const values:Record<string,unknown>={'chat.remoteAgentHosts':[{address:'other.example:123',name:'Existing'}]};
 const vscode={ConfigurationTarget:{Global:1},workspace:{getConfiguration(){return {get(){return [{name:'Untrusted workspace entry'}]},inspect(key:string){return {globalValue:values[key]}},async update(key:string,value:unknown){values[key]=value}}}}};
 try {
  await companion.runRegistration(vscode,broker.requestPath);await broker.completed;
  assert.deepEqual(values['settingsSync.ignoredSettings'],['chat.remoteAgentHosts','chat.workspaceRemoteAgentHosts']);
  assert.deepEqual(values['chat.remoteAgentHosts'],[{address:'other.example:123',name:'Existing'},{address:'127.0.0.1:32123',name:'Software Factory rt-fixture',connectionToken:capability}]);
  assert.equal(statSync(settings).mode&0o077,0);
 } finally {await broker.close();rmSync(root,{recursive:true});}
});
