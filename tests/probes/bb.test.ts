import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeBb, inspectBb, summarizeBbInspection } from '../../probes/bb.ts';

test('fixture is explicitly diagnostic and cannot grant live isolation', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'sf-bb-fixture-'));
  const result = await probeBb({ mode: 'fixture', allowLive: false, scratchRepo: '/fixture', outputDir });
  assert.equal(result.name, 'bb-codex-isolated'); assert.equal(result.mode, 'fixture'); assert.equal(result.status, 'blocked');
  assert.equal(result.assertions.some(a => a.name === 'verified-native-isolation' && a.passed), false);
  assert.match(await readFile(result.artifacts[1]!, 'utf8'), /fixture|isolat/i);
});

test('live cannot run without explicit authorization', async () => {
  const result = await probeBb({ mode: 'live', allowLive: false, scratchRepo: '/not-real', outputDir: await mkdtemp(join(tmpdir(), 'sf-bb-denied-')) } as never);
  assert.equal(result.status, 'blocked');
});

test('live refuses unsupported provider and never treats a host connection as isolation', async () => {
  const result = await probeBb({ mode: 'live', allowLive: true, provider: 'copilot', scratchRepo: '/not-real', outputDir: await mkdtemp(join(tmpdir(), 'sf-bb-provider-')) });
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.every(a => !a.passed));
});


test('RPC inspection whitelists facts and discards private/forged attestation payloads', () => {
  const result = summarizeBbInspection({ sdkVersion: '0.6.104', providers: ['codex'], machines: [{ id: 'host_fixture' }], machineProviders: ['manual'], access: { selectedProvider: 'connect', configuredOrigin: null, availableProviders: ['connect'], headers: { secret: 'private-material' } }, privateBundle: 'private-material', liveNativeLifecycle: true, verifiedProfileIds: ['fabricated'] });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private-material'), false); assert.equal(serialized.includes('fabricated'), false);
  assert.match(serialized, /"liveNativeLifecycle":false/);
});

test('RPC bridge refuses shell-like plugin ids before launching the authenticated CLI', async () => {
  await assert.rejects(inspectBb('invalid;plugin'), /plugin ID/);
  assert.throws(() => summarizeBbInspection({ sdkVersion: 'incompatible' }), /Incompatible/);
});
