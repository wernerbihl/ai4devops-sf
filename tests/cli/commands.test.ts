import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS, parseCommand } from '../../src/cli/main.ts';

test('only the three public commands are accepted and help is a flag', () => {
  assert.deepEqual(PUBLIC_COMMANDS, ['setup', 'next', 'uninstall']);
  assert.deepEqual(parseCommand(['setup', '--help']), { command: 'setup', help: true });
  assert.deepEqual(parseCommand(['--help']), { command: undefined, help: true });
  assert.throws(() => parseCommand(['daemon']));
  assert.throws(() => parseCommand(['setup', 'next']));
  assert.throws(() => parseCommand(['help']));
});

test('public help is side-effect free and uninstall reports retained cleanup as incomplete',async()=>{
 const {runCli}=await import('../../src/cli/main.ts');const out:string[]=[];const err:string[]=[];let effects=0;
 const io={out:(s:string)=>out.push(s),err:(s:string)=>err.push(s),ask:async()=>''};
 const installation={schemaVersion:1 as const,id:'fixture',root:'/tmp/factory',node:'/tmp/factory/runtime/0.1.0/node',serviceEntry:'/tmp/factory/runtime/0.1.0/dist/service/main.js',version:'0.1.0'};
 const deps={locate:async()=>installation,uninstall:async()=>{effects++}};
 assert.equal(await runCli(['--help'],io,deps),0);assert.equal(effects,0);assert.match(out.join(''),/setup.*next.*uninstall/);
 assert.equal(await runCli(['daemon'],io,deps),2);
 assert.equal(await runCli(['uninstall'],io,deps),1);assert.equal(effects,1);assert.match(err.join(''),/retained|remain/i);
});

test('old Node receives the minimum runtime diagnostic before importing backend modules',async t=>{
 const {spawnSync}=await import('node:child_process');const version=spawnSync('/usr/bin/node',['--version'],{encoding:'utf8'});
 if(version.status!==0){t.skip('No system Node available');return}
 const parts=version.stdout.trim().replace(/^v/,'').split('.').map(Number);const required=[24,22,2];let comparison=0;for(let i=0;i<3;i++)if(parts[i]!==required[i]){comparison=parts[i]!>required[i]!?1:-1;break}
 if(comparison>=0){t.skip('System Node is not older than the minimum');return}
 const result=spawnSync('/usr/bin/node',['bin/ai4devops-sf.mjs','--help'],{encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/Node\.js >=24\.22\.2/);assert.doesNotMatch(result.stderr,/sqlite|ERR_MODULE|stack/i);
});
