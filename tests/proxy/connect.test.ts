import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const proxy = require('../../runtime/model-proxy/connect.cjs');

test('allows only reviewed exact Copilot HTTPS authorities', () => {
  assert.equal(proxy.validateAuthority('api.githubcopilot.com:443', ['api.githubcopilot.com:443']), 'api.githubcopilot.com');
  for (const name of ['api.githubcopilot.com:80', 'API.githubcopilot.com:443', 'api.githubcopilot.com.:443', 'user@api.githubcopilot.com:443', '127.0.0.1:443', 'evil.example:443', 'api.githubcopilot.com:443/x']) {
    assert.throws(() => proxy.validateAuthority(name, ['api.githubcopilot.com:443']));
  }
  const policy = {schemaVersion:2,kind:'copilot-model-connect',listenPort:3128,nativeRuntimeId:'a'.repeat(64),internalNetworkId:'b'.repeat(64),listenAddress:'172.18.0.2',nativeAddress:'172.18.0.3',allowedAuthorities:['api.githubcopilot.com:443']};
  assert.deepEqual(proxy.validatePolicy(policy), policy);
  assert.throws(() => proxy.validatePolicy({...policy, allowedAuthorities:['evil.example:443']}));
  assert.throws(() => proxy.validatePolicy({...policy, schemaVersion:1}));
  assert.equal(proxy.normalizePeer('::ffff:172.18.0.3'), '172.18.0.3');
  assert.equal(proxy.normalizePeer('::ffff:172.18.0.3:5'), '');
});

test('rejects special and mixed DNS answers and pins the selected public IPv4 address', async () => {
  assert.equal(proxy.publicIPv4('8.8.8.8'), true);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', '2001:db8::1']) assert.equal(proxy.publicIPv4(address), false, address);
  assert.equal(await proxy.resolvePinned('api.githubcopilot.com', async () => [{address:'8.8.8.8', family:4}]), '8.8.8.8');
  await assert.rejects(proxy.resolvePinned('api.githubcopilot.com', async () => [{address:'8.8.8.8',family:4},{address:'169.254.1.1',family:4}]));
  await assert.rejects(proxy.resolvePinned('api.githubcopilot.com', async () => [{address:'::1',family:6}]));
});

test('bootstrap keeps the listener closed until the same-inode policy is complete', async () => {
  const { mkdtempSync, openSync, writeFileSync, closeSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const net = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(),'sf-proxy-bootstrap-')); const path = join(dir,'policy.json');
  writeFileSync(path,'{}',{mode:0o600});
  let server: import('node:http').Server | undefined;
  try {
    const pending = proxy.startFromFile(path);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await new Promise<boolean>(resolve => {const s=net.connect({host:'127.0.0.1',port:3128});s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));}), false);
    const fd=openSync(path,'r+'); try {writeFileSync(fd,JSON.stringify({schemaVersion:2,kind:'copilot-model-connect',listenPort:3128,nativeRuntimeId:'a'.repeat(64),internalNetworkId:'b'.repeat(64),nativeAddress:'127.0.0.2',listenAddress:'127.0.0.1',allowedAuthorities:['api.githubcopilot.com:443']}));} finally {closeSync(fd)}
    server = await pending;
    const response=await new Promise<string>((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:3128},()=>s.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));let data='';s.on('data',b=>data+=b);s.on('end',()=>resolve(data));s.on('error',reject)});
    assert.match(response,/^HTTP\/1\.1 405/);
    const denied=await new Promise<string>((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:3128},()=>s.write('CONNECT api.githubcopilot.com:443 HTTP/1.1\r\nHost: api.githubcopilot.com:443\r\n\r\n'));let data='';s.on('data',b=>data+=b);s.on('close',()=>resolve(data));s.on('error',reject)});
    assert.equal(denied,'');
  } finally { if(server) await new Promise<void>(resolve=>server!.close(()=>resolve())); rmSync(dir,{recursive:true}); }
});
