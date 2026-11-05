#!/usr/bin/env node
const required=[24,22,2];
const actual=process.versions.node.split('.').map(Number);
let comparison=0;
for(let i=0;i<required.length;i++){if(actual[i]!==required[i]){comparison=actual[i]>required[i]?1:-1;break}}
if(comparison<0){
  process.stderr.write('Node.js >=24.22.2 is required. Install or select a supported Node.js version and retry.\n');process.exitCode=1;
}else{
  try{
    const {createInterface}=await import('node:readline/promises');
    const {runCli}=await import('../dist/cli/main.js');
    const rl=createInterface({input:process.stdin,output:process.stdout});
    try{process.exitCode=await runCli(process.argv.slice(2),{out:text=>process.stdout.write(text),err:text=>process.stderr.write(text),ask:prompt=>rl.question(prompt)})}finally{rl.close()}
  }catch{process.stderr.write('Factory CLI is unavailable. Build or reinstall the runtime and retry.\n');process.exitCode=1}
}
