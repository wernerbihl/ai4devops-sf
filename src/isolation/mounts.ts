import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { NativeStart } from '../contracts/domain.ts';
import { ensure } from '../storage/database.ts';
export const pathContains = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
export interface NativeMountTarget {
    source: string;
    target: string;
}
/** Recipe '.' means the admitted workspace; it never changes the immutable grant or task. */
export async function resolveNativeMounts(start: NativeStart, targets: readonly NativeMountTarget[] = []): Promise<{
    source: string;
    target: string;
    writable: boolean;
}[]> {
    const mounts = new Map<string, {
        source: string;
        target: string;
        writable: boolean;
    }>();
    for (const grant of [{ root: start.workspacePath, mode: 'read' as const }, ...start.task.required.paths]) {
        const source = isAbsolute(grant.root) ? grant.root : resolve(start.workspacePath, grant.root);
        ensure(isAbsolute(source) && resolve(source) === source && await realpath(source) === source, 'profile_path', 'Canonical non-symlink native mount required');
        ensure(isAbsolute(grant.root) || pathContains(start.workspacePath, source), 'profile_path', 'Relative approved path escapes the native workspace');
        const previous = mounts.get(source);
        mounts.set(source, { source, target: source, writable: previous?.writable === true || grant.mode === 'write' });
    }
    for (const mapping of targets) {
        ensure(mounts.has(mapping.source) && mapping.target.startsWith('/workspaces/') && resolve(mapping.target) === mapping.target, 'profile_mount', 'Guest mapping must target an approved canonical root inside /workspaces');
        ensure(targets.filter(v => v.source === mapping.source).length === 1, 'profile_mount', 'Guest mapping source must be unique');
        mounts.get(mapping.source)!.target = mapping.target;
    }
    const result = [...mounts.values()];
    for (let i = 0; i < result.length; i++)
        for (let j = i + 1; j < result.length; j++) {
            const a = result[i]!, b = result[j]!;
            ensure(!pathContains(a.source, b.source) && !pathContains(b.source, a.source) && !pathContains(a.target, b.target) && !pathContains(b.target, a.target), 'profile_mount', 'Overlapping native mounts require an explicit supported read/write layering policy');
        }
    return result;
}
