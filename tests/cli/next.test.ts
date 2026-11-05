import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPrivateControl } from '../../src/service/control.ts';
import { requestNext } from '../../src/cli/next.ts';

test('next authenticates to the existing private controller exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-next-'));
  mkdirSync(join(root, 'vault'), { mode: 0o700 });
  const key = Buffer.alloc(32, 7);
  writeFileSync(join(root, 'vault', 'private-control'), key, { mode: 0o600 });
  let calls = 0;
  const control = await startPrivateControl({ root, key, async handle(method, path, input) {
    assert.equal(method, 'POST'); assert.equal(path, '/next'); assert.equal(input.key, 'stable-key'); calls++;
    return { admitted: false, reason: 'empty' };
  } });
  try { assert.deepEqual(await requestNext(root, 'stable-key'), { admitted: false, reason: 'empty' }); assert.equal(calls, 1); }
  finally { await control.close(); rmSync(root, { recursive: true }); }
});
