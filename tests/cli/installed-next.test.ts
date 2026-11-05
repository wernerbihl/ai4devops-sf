import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LinuxStartup} from '../../src/install/service-linux.ts';
import {startPrivateControl} from '../../src/service/control.ts';
import {nextInstallation} from '../../src/cli/installed-next.ts';

test('next starts the owned login service and dispatches to its protected controller',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-next-installed-'));const config=join(root,'config');mkdirSync(config,{mode:0o700});mkdirSync(join(root,'vault'),{mode:0o700});const runtime=join(root,'runtime','0.1.0');mkdirSync(runtime,{recursive:true,mode:0o700});mkdirSync(join(runtime,'dist','service'),{recursive:true,mode:0o700});
 const node=join(runtime,'node');const entry=join(runtime,'dist','service','main.js');writeFileSync(node,'node-fixture',{mode:0o700});writeFileSync(entry,'entry',{mode:0o600});const key=Buffer.alloc(32,7);writeFileSync(join(root,'vault','private-control'),key,{mode:0o600});
 const systemctl=join(root,'fake-systemctl');writeFileSync(systemctl,`#!${process.execPath}\nif(process.argv.includes('is-active'))process.exit(3)\n`,{mode:0o700});
 const service=new LinuxStartup({node,entry,id:'fixture',root,configHome:config,systemctl});await service.install();
 writeFileSync(join(root,'install-owner.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',root}),{mode:0o600});
 writeFileSync(join(runtime,'runtime-owned.json'),JSON.stringify({schemaVersion:1,state:'ready',version:'0.1.0',nodeSha256:createHash('sha256').update('node-fixture').digest('hex'),packages:[]}),{mode:0o600});
 writeFileSync(join(root,'startup.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',kind:'systemd-user',unitPath:service.unitPath,codeExecutable:'/usr/bin/code',requestDir:join(root,'auth-request')}),{mode:0o600});
 let calls=0;const control=await startPrivateControl({root,key,async handle(_method,path){if(path==='/health')return {ready:false};if(path==='/next'){calls++;return {state:'complete',body:{admitted:false,reason:'empty'}}}throw Error('unexpected')}});
 try {const result=await nextInstallation({schemaVersion:1,id:'fixture',root,node,serviceEntry:entry,version:'0.1.0'},{systemctl});assert.equal(result.state,'complete');assert.equal(calls,1)}
 finally {await control.close();rmSync(root,{recursive:true});}
});
