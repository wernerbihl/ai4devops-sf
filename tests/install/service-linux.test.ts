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
