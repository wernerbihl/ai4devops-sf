import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchdPlist} from '../../src/install/service-macos.ts';

test('LaunchAgent passes Unicode and shell metacharacters as literal program arguments',()=>{
 const plist=launchdPlist({node:'/Users/a/Node path/node',entry:'/Users/a/工場/$name & data/service.js',id:'fixture',root:'/Users/a/工場/$name & data',dockerExecutable:'/Applications/Docker & Tools/docker'});
 assert.match(plist,/<key>ProgramArguments<\/key>/);assert.match(plist,/<string>\/Users\/a\/工場\/\$name &amp; data\/service\.js<\/string>/);
 assert.match(plist,/<key>RunAtLoad<\/key>\s*<true\/>/);assert.doesNotMatch(plist,/npx|sh -c/);
 assert.throws(()=>launchdPlist({node:'node',entry:'/entry',id:'fixture',root:'/root'}));
});
