import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkDockerPreflight,probeSelectedRoot} from '../../src/install/docker-preflight.ts';
const base='node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c';

test('preview keeps a missing root untouched and reports pending bind proof when the pinned base is absent',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'sf-preflight-'));const root=join(parent,'factory');const calls:string[][]=[];
 const docker={async command(args:string[]){calls.push(args);if(args[0]==='version')return '"29.0.0"';throw Error('missing image')}};
 try {const result=await checkDockerPreflight(root,docker,'fixture');assert.equal(result.bindProof,'pending');assert.deepEqual(readdirSync(parent),[]);assert.deepEqual(calls.map(a=>a[0]),['version','image']);}
 finally {rmSync(parent,{recursive:true});}
});

test('owned sentinel confirms the exact selected root and is removed on success or failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-bind-'));let fail=false;
 const docker={async command(args:string[]){if(fail)throw Error('daemon cannot mount selected root');const spec=args[args.indexOf('--mount')+1]!;const match=/src=([^,]+),dst=/.exec(spec);assert.ok(match);return readFileSync(match[1]!.replace(/^"|"$/g,''),'utf8')}};
 try {await probeSelectedRoot(root,docker,'fixture');assert.deepEqual(readdirSync(root),[]);fail=true;await assert.rejects(probeSelectedRoot(root,docker,'fixture'),/bind|selected/i);assert.deepEqual(readdirSync(root),[]);}
 finally {rmSync(root,{recursive:true});}
});

test('preflight rejects an unpatched Docker daemon before any install work',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-docker-version-'));let calls=0;
 try {await assert.rejects(checkDockerPreflight(root,{async command(){calls++;return '"25.0.4"'}},'fixture'),/version|dns/i);assert.equal(calls,1);}
 finally {rmSync(root,{recursive:true});}
});
