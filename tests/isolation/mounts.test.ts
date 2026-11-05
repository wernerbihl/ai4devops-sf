import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validTask } from '../fixtures/contracts.ts';
import { nativeStateFixture } from '../helpers/native-state.ts';
import { resolveNativeMounts } from '../../src/isolation/mounts.ts';
import type { NativeStart } from '../../src/contracts/domain.ts';
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'sf-owned-mount-')); const workspace = join(root, 'workspace'); await mkdir(workspace); const start: NativeStart = { idempotencyKey: 'start', attemptId: 'a', fence: 1, workspacePath: workspace, baseSha: 'base', profileId: 'native', task: { ...validTask(), id: 'task', required: { ...validTask().required, paths: [{ root: '.', mode: 'read' }] } } }; return { root, workspace, start }; }
test('read-only workspace authority cannot be upgraded by implicit workspace mount', async () => { const f = await fixture(); try {
    assert.deepEqual(await resolveNativeMounts(f.start), [{ source: f.workspace, target: f.workspace, writable: false }]);
    assert.equal((await resolveNativeMounts({ ...f.start, task: { ...f.start.task, required: { ...f.start.task.required, paths: [] } } }))[0]!.writable, false);
}
finally {
    await rm(f.root, { recursive: true, force: true });
} });
test('trusted guest mapping only maps granted roots and rejects native system targets', async () => { const f = await fixture(); try {
    const result = await resolveNativeMounts(f.start, [{ source: f.workspace, target: '/workspaces/task' }]);
    assert.equal(result[0]?.target, '/workspaces/task');
    await assert.rejects(resolveNativeMounts(f.start, [{ source: f.root, target: '/workspaces/task' }]));
    await assert.rejects(resolveNativeMounts(f.start, [{ source: f.workspace, target: '/etc' }]));
    await assert.rejects(resolveNativeMounts({ ...f.start, task: { ...f.start.task, required: { ...f.start.task.required, paths: [{ root: '..', mode: 'write' }] } } }));
}
finally {
    await rm(f.root, { recursive: true, force: true });
} });
test('persistent native state requires exact private ownership marker outside the writable mount', async () => { const f = await fixture(); try {
    const m = await import('../../src/isolation/native-state.ts').catch(() => undefined);
    assert.ok(m?.verifyNativeStateMount, 'typed persistent native state verifier required');
    const state = await nativeStateFixture(f.root, f.start.task.id);
    assert.deepEqual(await m.verifyNativeStateMount(state, f.start.task.id, { installationId: 'installation', root: f.root }), { source: state.source, target: state.target, writable: true });
    await assert.rejects(m.verifyNativeStateMount(state, 'other', { installationId: 'installation', root: f.root }));
    await writeFile(state.markerPath, JSON.stringify({ schemaVersion: 1, installationId: 'other', runtimeOwnerId: 'owned', taskId: 'task', source: state.source }));
    await assert.rejects(m.verifyNativeStateMount(state, 'task', { installationId: 'installation', root: f.root }));
}
finally {
    await rm(f.root, { recursive: true, force: true });
} });
