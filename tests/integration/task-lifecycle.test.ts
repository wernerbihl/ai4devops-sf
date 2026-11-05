import assert from 'node:assert/strict';
import test from 'node:test';
import {fork,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
function start(file:string,args:string[]){const child=fork(fileURLToPath(new URL(file,import.meta.url)),args,{detached:true,stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr!.on('data',b=>stderr+=b);const next=()=>new Promise<any>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('fixture timeout '+stderr)),20000);const message=(value:any)=>{clearTimeout(timeout);child.off('exit',exit);resolve(value)};const exit=(code:number|null)=>{clearTimeout(timeout);child.off('message',message);reject(Error('fixture exited '+code+' '+stderr))};child.once('message',message);child.once('exit',exit)});return{child,next}}
async function kill(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;process.kill(-child.pid!,'SIGCONT');process.kill(-child.pid!,'SIGKILL');await new Promise(resolve=>child.once('exit',resolve))}
for(const boundary of ['none','reservation','native','native-create','result','closeout','tools'])test(boundary==='none'?'runs_recipe_to_native_result_without_parallel_writer':boundary==='tools'?'approved v2 starter uses registered AHP worker route and proves composite physical quiet':`recovers_each_external_effect_boundary: ${boundary}`,{timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sf-rf3-'));const source=join(root,'source');const factory=join(root,'factory');mkdirSync(source);mkdirSync(factory,{mode:0o700});
  const env={PATH:process.env.PATH!,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  const git=(args:string[])=>execFileSync('git',args,{cwd:source,env,stdio:'pipe'});git(['init','--initial-branch=main']);writeFileSync(join(source,'file.txt'),'base\n');git(['add','.']);git(['commit','-m','base']);
  const native=start('./fixtures/services.ts',['native',...(boundary==='native-create'?['drop-create']:[])]);const engine=start('./fixtures/services.ts',['engine']);let controller:ChildProcess|undefined;
  try{
    const n=await native.next();const e=await engine.next();writeFileSync(join(factory,'fixture.json'),JSON.stringify({source,native:n.url,nativePid:n.pid,engine:e.url}),{mode:0o600});writeFileSync(join(factory,'fixture-token'),'x'.repeat(32),{mode:0o600});
    let before:any;let run=start('./fixtures/controller.ts',[factory,boundary]);controller=run.child;
    if(boundary!=='none'&&boundary!=='tools'){
      const stopped=await (boundary==='native-create'?native.next():run.next());before=stopped;assert.equal(stopped.phase,boundary);
      if(boundary==='native-create'){
        const db=new DatabaseSync(join(factory,'factory.sqlite'),{readOnly:true});
        const reservation=JSON.parse(String(db.prepare('SELECT payload FROM admission_reservations').get()!.payload));db.close();
        assert.equal(reservation.attempt.native,undefined,'external create accepted before factory identity receipt');
        const journal=new DatabaseSync(join(factory,'native.sqlite'),{readOnly:true});
        const intent=JSON.parse(String(journal.prepare('SELECT body FROM sessions').get()!.body));journal.close();
        assert.equal(intent.identity,undefined,'ensureSession has not durably bound its create reply');
        assert.equal(intent.sessionId,stopped.identity.sessionId);before.workspace=reservation.attempt.workspacePath;before.workflow=reservation.attempt.workflow;
      }
      await kill(run.child);process.kill(n.pid,'SIGCONT');run=start('./fixtures/controller.ts',[factory,'none']);controller=run.child;
    }
    const done=await run.next();assert.equal(done.status,'completed');assert.equal(done.leases,0);assert.ok(done.identity.sessionId);assert.equal(done.workflow.executionId,'execution-original');if(before){assert.equal(done.workspace,before.workspace);if(before.identity)assert.deepEqual(done.identity,before.identity);if(before.workflow)assert.deepEqual(done.workflow,before.workflow);}
    if(boundary==='tools')assert.deepEqual(done.toolEvidence,{edited:true,nativeControlDenied:true,protectedPathDenied:true,nativeQuiet:true,workerQuiet:true,backgroundWriterQuiet:true});
    if(run.child.exitCode===null)await new Promise(resolve=>run.child.once('exit',resolve));process.kill(n.pid,'SIGCONT');
    const nativeStats=await(await fetch(n.url+'/stats')).json();const engineStats=await(await fetch(e.url+'/stats')).json();
    assert.equal(nativeStats.creates,1);assert.equal(engineStats.starts,1);assert.equal(engineStats.resumes,1);
  }finally{if(controller)await kill(controller);await kill(native.child);await kill(engine.child);rmSync(root,{recursive:true,force:true})}
});
