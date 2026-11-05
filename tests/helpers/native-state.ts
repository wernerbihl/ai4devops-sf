import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Owned synthetic provisioned state; production E7 creates this layout and ACLs. */
export async function nativeStateFixture(root: string, taskId = 'task', runtimeOwnerId = 'owned') {
    const parent = join(root, runtimeOwnerId);
    const source = join(parent, 'data');
    await mkdir(source, { recursive: true, mode: 0o700 });
    const markerPath = join(parent, 'owner.json');
    const state = { installationId: 'installation', runtimeOwnerId, taskId, source, target: '/var/lib/software-factory/native-state' as const, markerPath };
    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, installationId: state.installationId, runtimeOwnerId, taskId, source }), { mode: 0o600 });
    return state;
}
