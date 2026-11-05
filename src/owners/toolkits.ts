import type { TaskSpec } from '../contracts/domain.ts';
import { ensure } from '../storage/database.ts';
/** Reviewed against VS Code e576c7bbeb39772a1d1ebe472545def0d93e6d8b copilotBuiltinToolAllowlist.ts.
 * Exact Linux managed-runtime names only. SDK additions, MCP, subagents and web_fetch are not granted.
 * Changes require a new toolkit version and new recipe approval; stored revisions remain immutable. */
export const nativeToolkits = Object.freeze({
    'native-files': Object.freeze({ version: '1', providerId: 'copilot', read: Object.freeze(['view', 'grep', 'rg', 'glob']), write: Object.freeze(['create', 'edit', 'apply_patch']) }),
    'native-terminal': Object.freeze({ version: '1', providerId: 'copilot', read: Object.freeze(['bash', 'read_bash', 'stop_bash', 'list_bash', 'local_shell']), write: Object.freeze([] as string[]) }),
});
export function resolveNativeToolReference(kind: 'skill' | 'tool', id: string, version: string): boolean {
    return kind === 'tool' && Object.hasOwn(nativeToolkits, id) && nativeToolkits[id as keyof typeof nativeToolkits].version === version;
}
export function nativeToolAllowlist(task: TaskSpec): string[] {
    ensure(task.providerId === 'copilot', 'owner_tools', 'No pinned native toolkit mapping for this provider');
    ensure(task.tools.every(id => task.required.tools.includes(id)), 'owner_tools', 'Task tool requests require explicit authority');
    const names = new Set(['custom:sf_factory_operation']);
    for (const id of task.required.tools) {
        ensure(Object.hasOwn(nativeToolkits, id), 'owner_tools', 'Unknown or unversioned native toolkit authority');
        const toolkit = nativeToolkits[id as keyof typeof nativeToolkits];
        for (const name of toolkit.read)
            names.add(`builtin:${name}`);
        if (task.required.paths.some(path => path.mode === 'write'))
            for (const name of toolkit.write)
                names.add(`builtin:${name}`);
    }
    return [...names].sort();
}
