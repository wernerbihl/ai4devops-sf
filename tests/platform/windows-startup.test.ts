import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { windowsServiceDefinition } from '../../src/install/service-windows.ts';

test('Windows startup binds a limited interactive logon task to exact owned runtime paths', () => {
  const definition = windowsServiceDefinition({node:'C:\\Factory Root\\node.exe',entry:'C:\\Factory Root\\main.js',root:'C:\\Factory Root',id:'install_1'});
  assert.equal(definition.taskName, 'AI4DevOps-SF-install_1');
  assert.equal(definition.executable, 'C:\\Factory Root\\node.exe');
  assert.match(definition.arguments, /"C:\\Factory Root\\main\.js"/);
  assert.match(definition.arguments, /"C:\\Factory Root"/);
  assert.throws(() => windowsServiceDefinition({node:'node.exe',entry:'C:\\main.js',root:'C:\\root',id:'bad/name'}));
});
