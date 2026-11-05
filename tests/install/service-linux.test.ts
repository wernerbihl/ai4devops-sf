import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linuxUnit } from '../../src/install/service-linux.ts';

test('systemd unit uses a quoted absolute runtime entry without shell evaluation', () => {
  const unit = linuxUnit({ node: '/tmp/Node path/node', entry: '/tmp/工場/$factory/service.js', id: 'factory-1', root: '/tmp/工場/$factory' });
  assert.match(unit, /ExecStart="\/tmp\/Node path\/node" "\/tmp\/工場\/\$\$factory\/service\.js" "factory-1" "\/tmp\/工場\/\$\$factory"/);
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /npx|bash|sh -c/);
  assert.throws(() => linuxUnit({ node: 'node', entry: '/x', id: 'id', root: '/x' }));
});

test('owned Linux service installs and starts using argument arrays', async () => {
  const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {LinuxStartup}=await import('../../src/install/service-linux.ts');
  const root=mkdtempSync(join(tmpdir(),'sf systemd 工場-'));const config=join(root,'config');mkdirSync(config,{mode:0o700});const log=join(root,'calls');const systemctl=join(root,'fake systemctl');
  writeFileSync(systemctl,`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n')\n`,{mode:0o700});
  try {
    const adapter=new LinuxStartup({node:join(root,'node with space'),entry:join(root,'service.js'),id:'fixture',root,configHome:config,systemctl});
    await adapter.install();await adapter.start();
    const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(calls,[['--user','daemon-reload'],['--user','enable','ai4devops-sf-fixture.service'],['--user','start','ai4devops-sf-fixture.service']]);
    await adapter.remove();
  } finally {rmSync(root,{recursive:true});}
});

test('selected Docker executable is stored as a literal systemd environment value',()=>{
  const unit=linuxUnit({node:'/tmp/node',entry:'/tmp/service.js',id:'fixture',root:'/tmp/factory',dockerExecutable:'/tmp/Docker $x%/docker'});
  assert.match(unit,/Environment="SF_DOCKER_EXECUTABLE=\/tmp\/Docker \$x%%\/docker"/);
});
