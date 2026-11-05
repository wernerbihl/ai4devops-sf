import {test} from 'node:test';
import assert from 'node:assert/strict';
import {windowsPrivateInvocation} from '../../src/platform/windows-private.ts';

test('Windows protection sends fixture bytes through stdin rather than command arguments',()=>{
 const fixture=Buffer.from('fixed-nonsecret-fixture');const invocation=windowsPrivateInvocation('write-secret','C:\\Users\\Example\\factory\\vault\\entry',fixture);
 assert.ok(invocation.args.includes('-NonInteractive'));assert.ok(invocation.args.includes('-NoProfile'));
 assert.equal(invocation.args.some(arg=>arg.includes('fixed-nonsecret-fixture')),false);
 const input=JSON.parse(invocation.input);assert.equal(Buffer.from(input.data,'base64').toString(),'fixed-nonsecret-fixture');
 assert.match(invocation.args.at(-1)!,/ProtectedData/);assert.match(invocation.args.at(-1)!,/CurrentUser/);
});
