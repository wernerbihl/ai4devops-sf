import type { NativeIdentity, NativeStart, WorkerRequest } from '../contracts/domain.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { AttemptBroker } from '../broker/operations.ts';
import type { Operation } from '../broker/capabilities.ts';
import type { NativeClientTools } from './vscode.ts';
import { validateContract } from '../contracts/schemas.ts';
import { canonical, ensure } from '../storage/database.ts';
import { digest } from './journal.ts';
const allowed = ['task.create', 'task.read', 'task.update', 'task.cancel', 'finding.upsert', 'result.submit', 'artifact.register', 'artifact.read', 'attention.create'] as const;
/** Lives in trusted runner, not worker/container; capability and metadata never enter model input. */
export function createFactoryToolGate(options: {
    broker: AttemptBroker;
    store: FactoryStore;
}) {
    let bound: NativeStart | undefined;
    let bindingKey: string | undefined;
    function current(start: NativeStart) { const actual = options.broker.nativeStart(start.attemptId, start.idempotencyKey); ensure(canonical(actual) === canonical(start), 'owner_binding', 'Native binding must match actual current reservation'); return options.broker.current(start.attemptId); }
    const gate: NativeClientTools & {
        prepare(start: NativeStart, key: string): void;
        suspend(): void;
        isSuspended(): boolean;
        binding(): {
            attemptId: string;
            fence: number;
        };
        currentStart(): NativeStart;
        nativeIdentity(start?: NativeStart): NativeIdentity | undefined;
    } = {
        definitions: [{ name: 'sf_factory_operation', description: 'Execute one scoped factory operation. task.create/finding.upsert return real queued task IDs. result.submit accepts an explicit TaskResult proposal; native idle never completes a task. No host filesystem, shell, network, native start, or administration.', inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: [...allowed] }, payload: { type: 'object' } }, required: ['operation', 'payload'] } }],
        suspend() { bound = undefined; bindingKey = undefined; },
        isSuspended() { return bound === undefined; },
        prepare(start, key) {
            ensure(key.trim(), 'owner_binding', 'Binding idempotency key is required');
            current(start);
            if (bindingKey === key)
                ensure(canonical(bound) === canonical(start), 'owner_binding', 'Binding key conflict');
            if (bound) {
                ensure(bound.task.id === start.task.id && bound.task.ownerId === start.task.ownerId && bound.task.providerId === start.task.providerId && bound.workspacePath === start.workspacePath && bound.baseSha === start.baseSha, 'owner_binding', 'Native runtime cannot switch task or workspace');
                ensure(start.fence >= bound.fence, 'owner_binding', 'Native fence cannot move backwards');
            }
            bound = structuredClone(start);
            bindingKey = key;
        },
        binding() { ensure(bound, 'owner_binding', 'Native gate is not bound'); current(bound); return { attemptId: bound.attemptId, fence: bound.fence }; },
        nativeIdentity(start) { const target = start ?? bound; return target ? current(target).attempt.native : undefined; },
        currentStart() { ensure(bound, 'owner_binding', 'Native gate is not bound'); current(bound); return structuredClone(bound); },
        async invoke(identity, callId, name, input) {
            ensure(name === 'sf_factory_operation', 'owner_tool_denied', 'Unknown native client tool denied');
            ensure(bound, 'owner_binding', 'Native gate is not bound');
            const r = current(bound);
            ensure(r.attempt.native && canonical(r.attempt.native) === canonical(identity), 'owner_identity', 'Client tool must belong to the current native identity');
            ensure(input && typeof input === 'object' && !Array.isArray(input), 'owner_tool', 'Expected operation object');
            const obj = input as Record<string, unknown>;
            ensure(Object.keys(obj).sort().join(',') === 'operation,payload' && allowed.includes(obj.operation as typeof allowed[number]), 'owner_tool_denied', 'Native operation is outside the closed allowlist');
            ensure(callId.length > 0 && callId.length <= 1024, 'owner_tool', 'Invalid native call identity');
            const operation = obj.operation as Operation;
            const token = options.broker.issueAttemptCapability(bound.attemptId, options.broker.currentGrantIds(bound.attemptId), [operation]);
            const scope = options.broker.authorizeAttempt(token, operation, {});
            const key = digest([identity, callId]);
            const request = validateContract('WorkerRequest', { requestId: key, idempotencyKey: key, scope, operation, payload: obj.payload }) as WorkerRequest;
            const response = await options.broker.execute(token, request);
            return response as unknown as Record<string, unknown>;
        },
    };
    return gate;
}
export type FactoryToolGate = ReturnType<typeof createFactoryToolGate>;
