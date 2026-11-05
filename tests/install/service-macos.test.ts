import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchdPlist} from '../../src/install/service-macos.ts';

test('LaunchAgent passes Unicode and shell metacharacters as literal program arguments',()=>{
 const plist=launchdPlist({node:'/Users/a/Node path/node',entry:'/Users/a/工場/$name & data/service.js',id:'fixture',root:'/Users/a/工場/$name & data',dockerExecutable:'/Applications/Docker & Tools/docker'});
 assert.match(plist,/<key>ProgramArguments<\/key>/);assert.match(plist,/<string>\/Users\/a\/工場\/\$name &amp; data\/service\.js<\/string>/);
 assert.match(plist,/<key>RunAtLoad<\/key>\s*<true\/>/);assert.doesNotMatch(plist,/npx|sh -c/);
 assert.throws(()=>launchdPlist({node:'node',entry:'/entry',id:'fixture',root:'/root'}));
});

async function launchAgentFixture(initial:'loaded'|'absent'|'unknown'|'sticky') {
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join,dirname}=await import('node:path');const {MacOSStartup}=await import('../../src/install/service-macos.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-launchagent-')),home=join(root,'home'),state=join(root,'state'),calls=join(root,'calls'),launchctl=join(root,'launchctl');
 mkdirSync(home,{mode:0o700});writeFileSync(state,initial);writeFileSync(calls,'');
 writeFileSync(launchctl,`#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2),s=${JSON.stringify(state)},c=${JSON.stringify(calls)};fs.appendFileSync(c,a[0]+'\\n');const v=fs.readFileSync(s,'utf8');if(a[0]==='print'){if(v==='absent')process.exit(113);if(v==='unknown')process.exit(1);process.stdout.write('state = waiting\\n');process.exit(0)}if(a[0]==='bootout'){if(v==='sticky')process.exit(0);if(v!=='loaded')process.exit(1);fs.writeFileSync(s,'absent');process.exit(0)}process.exit(1);\n`,{mode:0o700});
 const spec={node:join(root,'node'),entry:join(root,'service.js'),id:'fixture',root};const service=new MacOSStartup({...spec,home,uid:1000,launchctl});mkdirSync(dirname(service.plistPath),{recursive:true,mode:0o700});writeFileSync(service.plistPath,launchdPlist(spec),{mode:0o600});
 return {service,state:()=>readFileSync(state,'utf8'),calls:()=>readFileSync(calls,'utf8').trim().split('\n').filter(Boolean),exists:()=>existsSync(service.plistPath),close:()=>rmSync(root,{recursive:true,force:true})};
}

test('removing a loaded idle KeepAlive agent boots it out and verifies absence',async()=>{
 const f=await launchAgentFixture('loaded');try{await f.service.remove();assert.equal(f.state(),'absent');assert.equal(f.exists(),false);assert.deepEqual(f.calls(),['print','bootout','print'])}finally{f.close()}
});
test('removing an already absent agent retains no job and removes its verified plist',async()=>{
 const f=await launchAgentFixture('absent');try{await f.service.remove();assert.equal(f.exists(),false);assert.deepEqual(f.calls(),['print'])}finally{f.close()}
});
test('unknown launchd state retains the plist and does not claim removal',async()=>{
 const f=await launchAgentFixture('unknown');try{await assert.rejects(f.service.remove());assert.equal(f.exists(),true);assert.deepEqual(f.calls(),['print'])}finally{f.close()}
});

test('an acknowledged bootout without verified absence retains the plist',async()=>{
 const f=await launchAgentFixture('sticky');try{await assert.rejects(f.service.remove(),/unconfirmed/i);assert.equal(f.exists(),true);assert.deepEqual(f.calls(),['print','bootout','print'])}finally{f.close()}
});
