import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonical, ensure } from '../storage/database.ts';
export const NATIVE_STATE_TARGET = '/var/lib/software-factory/native-state' as const;
export interface NativeStateOwnership {
    installationId: string;
    root: string;
}
export interface NativeStateMount {
    installationId: string;
    runtimeOwnerId: string;
    taskId: string;
    source: string;
    target: typeof NATIVE_STATE_TARGET;
    markerPath: string;
}
/** E7 provisions this private per-task layout. Marker stays outside every writable native mount. */
export async function verifyNativeStateMount(state: NativeStateMount, taskId: string, ownership: NativeStateOwnership) {
    ensure(process.platform !== 'win32' && typeof process.getuid === 'function', 'profile_state', 'Native-state ACL verification on Windows requires an owning-OS implementation');
    const parent = dirname(state.source);
    ensure(ownership && state.installationId === ownership.installationId && parent === join(ownership.root, state.runtimeOwnerId), 'profile_state', 'Native state is outside the trusted installation root');
    ensure(state.installationId && state.taskId === taskId && /^[A-Za-z0-9_-]+$/.test(state.runtimeOwnerId) && basename(parent) === state.runtimeOwnerId && basename(state.source) === 'data' && state.target === NATIVE_STATE_TARGET && state.markerPath === join(parent, 'owner.json'), 'profile_state', 'Invalid per-task native-state binding or fixed target');
    for (const path of [ownership.root, parent, state.source, state.markerPath]) {
        ensure(resolve(path) === path && await realpath(path) === path && !path.split('/').includes('.git'), 'profile_state', 'Native-state paths must be canonical and outside Git metadata');
        const stat = await lstat(path);
        ensure(!stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (path === state.markerPath ? stat.isFile() : stat.isDirectory()), 'profile_state', 'Private owned native-state directory and marker required');
    }
    const marker = JSON.parse(await readFile(state.markerPath, 'utf8'));
    ensure(canonical(marker) === canonical({ schemaVersion: 1, installationId: state.installationId, runtimeOwnerId: state.runtimeOwnerId, taskId: state.taskId, source: state.source }), 'profile_state', 'Native-state ownership marker mismatch');
    return { source: state.source, target: state.target, writable: true };
}
