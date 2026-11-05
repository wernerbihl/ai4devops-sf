import test from 'node:test';
import assert from 'node:assert/strict';
import { MaintenanceGate } from '../../src/service/maintenance-gate.ts';

test('maintenance closes admission synchronously and waits for all admitted operations', async () => {
  const gate = new MaintenanceGate();
  const first = gate.enter(); const second = gate.enter();
  let drained = false;
  const closing = gate.close().then(() => { drained = true; });
  assert.throws(() => gate.enter());
  first(); await Promise.resolve(); assert.equal(drained, false);
  second(); await closing; assert.equal(drained, true);
  assert.throws(() => gate.enter());
});
