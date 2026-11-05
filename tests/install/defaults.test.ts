import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDefaults,saveDefaults} from '../../src/install/defaults.ts';

test('setup answers are restored from private nonsecret defaults',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-defaults-'));const path=join(root,'defaults.json');
 const value={directory:join(root,'factory'),taktSeconds:60,ownerId:'vscode' as const,providers:['copilot' as const,'codex' as const],codeExecutable:'/usr/bin/code'};
 try {assert.equal(loadDefaults(path),null);saveDefaults(value,path);assert.deepEqual(loadDefaults(path),value);assert.doesNotMatch(readFileSync(path,'utf8'),/token|secret|password/)}finally{rmSync(root,{recursive:true});}
});
