import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installationLocatorPath,locateInstallation,saveInstallation} from '../../src/install/locator.ts';

test('locator keeps only nonsecret installation identity in private user configuration',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-locator-'));const config=join(root,'config');mkdirSync(config,{mode:0o700});
 const path=installationLocatorPath({platform:'linux',home:root,xdgConfigHome:config});
 const installation={schemaVersion:1 as const,id:'fixture',root:join(root,'factory'),node:join(root,'factory/runtime/node'),serviceEntry:join(root,'factory/runtime/dist/service/main.js'),version:'0.1.0'};
 try {
  assert.equal(await locateInstallation(path),null);await saveInstallation(installation,path);
  assert.deepEqual(await locateInstallation(path),installation);assert.equal(statSync(path).mode&0o077,0);
  assert.doesNotMatch(readFileSync(path,'utf8'),/token|secret|password/i);
  await assert.rejects(saveInstallation({...installation,id:'other'},path),/exist|owned/i);
 } finally {rmSync(root,{recursive:true});}
});
