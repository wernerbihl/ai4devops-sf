import assert from 'node:assert/strict';
import test from 'node:test';
import { validTask } from '../fixtures/contracts.ts';
test('isolated toolkit grants only finite client tools and never native builtins', async () => {
  const m = await import('../../src/owners/isolated.ts').catch(() => undefined);
  assert.ok(m?.isolatedToolAllowlist, 'isolated native policy is missing');
  const task = validTask(); task.required.tools = ['native-files', 'native-terminal']; task.required.paths = [{ root: '.', mode: 'write' }]; task.tools = [...task.required.tools];
  assert.deepEqual(m.isolatedToolAllowlist(task), ['custom:sf_factory_operation','custom:sf_read_file','custom:sf_terminal','custom:sf_write_file']);
  assert.throws(() => m.isolatedToolAllowlist({ ...task, required: { ...task.required, tools: ['unreviewed'] } }));
});
