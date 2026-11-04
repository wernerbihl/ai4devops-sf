import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeKestra, checkKestraLifecycle, makeProbeFlow, validateRecipePolicy, recoverExecution } from '../../probes/kestra.ts';
import type { KestraApi } from '../../probes/kestra.ts';

// Pinned OSS v2 API responses are simulated only at the transport boundary.
function fixtureApi(breakage = ''): KestraApi {
  const revisions: Record<string, unknown>[] = [];
  let execution: any;
  return {
    async request(method, path, body) {
      if (path === '/flows' && method === 'POST' || path === '/flows/sf.p4/restricted' && method === 'PUT') {
        const flow = JSON.parse(body!); revisions.push({ ...flow, revision: revisions.length + 1 }); return revisions.at(-1);
      }
      if (path.startsWith('/flows/sf.p4/restricted?')) return revisions[breakage === 'mutable-revision' ? 1 : 0];
      if (path.startsWith('/executions/sf.p4/restricted?') && method === 'POST') {
        if (execution) throw new Error('duplicate start');
        execution = { id: 'execution-original', namespace: 'sf.p4', flowId: 'restricted', flowRevision: 1, state: { current: 'PAUSED' }, labels: [{ key: 'sf_attempt', value: 'p4-attempt' }] };
        throw new Error('intentionally lost start reply');
      }
      if (path.startsWith('/executions/search?')) return { total: execution ? 1 : 0, results: execution ? [execution] : [] };
      if (path.endsWith('/actions/resume')) {
        if (body !== 'approved=true&count=7') return { status: 422 };
        execution = { ...execution, state: { current: 'SUCCESS' }, outputs: { approved: true, count: breakage === 'untyped-resume' ? '7' : 7 } };
        return execution;
      }
      if (path.endsWith('/actions/eval')) return { result: JSON.stringify(execution.outputs) };
      if (path === '/executions/execution-original') return execution;
      throw new Error(`unexpected fixture request: ${method} ${path}`);
    },
    async restart() { if (breakage === 'lost-h2') execution = undefined; },
  };
}

test('RF3 reconciles a lost start reply without issuing a duplicate execution and preserves typed resume/revision after restart (fixture)', async () => {
  const result = await checkKestraLifecycle(fixtureApi(), 'p4-attempt', 1);
  assert.equal(result.originalExecutionId, 'execution-original');
  assert.equal(result.resumedExecutionId, result.originalExecutionId);
  assert.equal(result.metadataAcceptedByPinnedKestra, true);
  assert.ok(result.assertions.every(a => a.passed));
});
for (const breakage of ['lost-h2', 'mutable-revision', 'untyped-resume']) {
  test(`lifecycle gate refuses ${breakage} instead of reporting passed`, async () => {
    await assert.rejects(checkKestraLifecycle(fixtureApi(breakage), 'p4-attempt', 1));
  });
}
test('an ambiguous/missing RF3 lookup never authorizes another start', async () => {
  for (const results of [[], [{ id: 'a' }, { id: 'b' }]]) {
    await assert.rejects(recoverExecution({ request: async () => ({ total: results.length, results }), restart: async () => {} }, 'key', 1));
  }
});
test('metadata stays under standard variables.sf and the restricted probe flow passes policy', () => {
  const flow = makeProbeFlow();
  assert.equal(flow.variables.sf.tagId, 'p4');
  validateRecipePolicy(flow);
});
test('fixture mode cannot create live connectors or satisfy the release gate', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'sf-p4-test-'));
  const evidence = await probeKestra({ mode: 'fixture', allowLive: true, scratchRepo: '/unused', outputDir });
  assert.equal(evidence.mode, 'fixture');
  assert.equal(evidence.versions.docker, undefined);
});
test('explicit live permission is required before any connector', async () => {
  await assert.rejects(probeKestra({ mode: 'live', allowLive: false, scratchRepo: '/unused', outputDir: '/unused' } as any));
});
test('RF3 verifies the returned namespace/flow/attempt label instead of trusting a search match', async () => {
  for (const entry of [
    { id: 'x', namespace: 'other', flowId: 'restricted', labels: [{ key: 'sf_attempt', value: 'key' }] },
    { id: 'x', namespace: 'sf.p4', flowId: 'restricted', labels: [{ key: 'sf_attempt', value: 'wrong' }] },
  ]) {
    await assert.rejects(recoverExecution({ request: async () => ({ total: 1, results: [entry] }), restart: async () => {} }, 'key', 1));
  }
});
