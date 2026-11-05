import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('private runtime configuration refuses secret material and permissive files', async () => {
  const m = await import('../../src/service/config.ts').catch(() => undefined);
  assert.ok(m?.loadRuntimeConfig, 'protected E7 runtime config consumer is missing');
  const root = mkdtempSync(join(tmpdir(), 'sf-config-'));
  const path = join(root, 'runtime.json');
  const config = { schemaVersion: 1, installationId: 'fixture', allowedOrigins: ['http://127.0.0.1:4000'], repositories: [], providerCredentials: [], native: [] };
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    assert.equal(m.loadRuntimeConfig(root, 'fixture').installationId, 'fixture');
    chmodSync(path, 0o644);
    assert.throws(() => m.loadRuntimeConfig(root, 'fixture'), /private|permission/i);
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ ...config, token: 'secret-in-config' }));
    assert.throws(() => m.loadRuntimeConfig(root, 'fixture'), /unknown|secret|config/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
