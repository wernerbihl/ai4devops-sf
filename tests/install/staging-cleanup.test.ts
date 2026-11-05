import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clearStagedCredential} from '../../src/install/staging-cleanup.ts';

test('cancel removes the owned staged credential while retaining an unproved live profile',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-stage-'));mkdirSync(join(root,'vault'),{mode:0o700});mkdirSync(join(root,'vscode-profile'),{mode:0o700});writeFileSync(join(root,'vault','native-copilot'),'fixed-nonsecret-fixture',{mode:0o600});
 try{clearStagedCredential(root);assert.equal(existsSync(join(root,'vault','native-copilot')),false);assert.equal(existsSync(join(root,'vscode-profile')),true);assert.equal(existsSync(root),true)}finally{rmSync(root,{recursive:true});}
});
