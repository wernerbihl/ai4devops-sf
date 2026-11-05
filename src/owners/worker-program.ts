/** Executed only inside the isolated worker with controller-owned input. */
export const workerProgram = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
let raw='';process.stdin.on('data',b=>{raw+=b;if(Buffer.byteLength(raw)>262144)process.exit(1)});
process.stdin.on('end',()=>{try{const p=JSON.parse(raw),o=p.operation;const within=(r,f)=>f===r||f.startsWith(r+'/');
const target=(name,write)=>{if(typeof name!=='string'||!path.isAbsolute(name))throw Error();const full=path.resolve(name);let real;try{real=fs.realpathSync(full)}catch(e){if(e.code!=='ENOENT'||!write)throw e;real=path.join(fs.realpathSync(path.dirname(full)),path.basename(full))}if(!p.roots.some(r=>within(r.target,real)&&(!write||r.writable)))throw Error();return real};
let result;if(o.kind==='read'){const f=target(o.path,false);if(fs.statSync(f).size>131072)throw Error();result={content:fs.readFileSync(f,'utf8')}}
else if(o.kind==='write'){if(typeof o.content!=='string'||Buffer.byteLength(o.content)>131072)throw Error();fs.writeFileSync(target(o.path,true),o.content,{flag:'w'});result={written:true}}
else if(o.kind==='terminal'){if(typeof o.command!=='string'||o.command.length>32768)throw Error();const r=cp.spawnSync('/bin/sh',['-c',o.command],{cwd:p.cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8'},encoding:'utf8',timeout:60000,maxBuffer:131072});if(r.error)throw Error();result={exitCode:r.status,stdout:r.stdout,stderr:r.stderr}}
else throw Error();process.stdout.write(JSON.stringify(result))}catch{process.exitCode=1}});`;
