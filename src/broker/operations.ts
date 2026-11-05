import { randomUUID } from 'node:crypto';
import type { NativeIdentity, NativeInput, NativeStart, ProfileEvidence, TaskSpec, WorkerRequest, WorkerResponse } from '../contracts/domain.ts';
import { encodeWorkerResponse } from '../contracts/worker-transport.ts';
import { validateContract } from '../contracts/schemas.ts';
import { canonical, ensure, StoreError } from '../storage/database.ts';
import type { NativeWrite } from '../storage/broker.ts';
import { createCapabilityAuthority } from './capabilities.ts';
import type { CapabilityDeps, CapabilityToken } from './capabilities.ts';
export interface BrokerNativePort {
  start(start: NativeStart): Promise<NativeIdentity>;
  /** E6 must route through C4 with the persisted exact native identity, never arbitrary owner.send. */
  continue(attemptId: string, input: Record<string, unknown>, key: string): Promise<void>;
  /** Read-only reconciliation of the original durable intent, no re-dispatch on unknown/not-found. */
  reconcile(write: NativeWrite, start: NativeStart): Promise<{ state: 'unknown' } | { state: 'done'; identity?: NativeIdentity }>;
}
export interface AttemptBrokerDeps extends CapabilityDeps {
  native?: BrokerNativePort;
  /** E4/E6 actual current owner input, synchronously refreshed from trusted owner events/snapshot. */
  pendingNativeInput?(attemptId: string): { identity: NativeIdentity; input: NativeInput } | undefined;
  profiles?: { requireVerifiedProfile(start: NativeStart): Promise<ProfileEvidence> };
}
export function createAttemptBroker(deps: AttemptBrokerDeps) {
  const { store, clock } = deps; const authority = createCapabilityAuthority(deps);
  const nativeStart = (attemptId: string, key: string): NativeStart => {
    const r = authority.current(attemptId);
    return { idempotencyKey: key, attemptId, task: r.task.spec, workspacePath: r.attempt.workspacePath, baseSha: r.attempt.baseSha, fence: r.lease.fence, profileId: r.attempt.profileId };
  };
  function authorize(token: CapabilityToken, request: WorkerRequest) {
    const p = request.payload;
    const scope = authority.authorizeAttempt(token, request.operation, {
      ...('repositoryId' in p ? { repositoryId: p.repositoryId } : {}), ...('taskId' in p ? { taskId: p.taskId } : {}),
    });
    ensure(canonical(scope) === canonical(request.scope), 'scope_forged', 'Logical scope must equal authenticated server scope');
    return scope;
  }
  function generated(payload: TaskSpec, attemptId: string): TaskSpec {
    const r = authority.current(attemptId); const parent = r.task.spec;
    for (const key of ['repositoryId','recipeId','recipeRevision','tagId','finishPolicy','ownerId','providerId','required','tools','skills'] as const)
      ensure(canonical(payload[key]) === canonical(parent[key]), 'worker_authority', `Generated task cannot change ${key}`);
    ensure(payload.source === 'recipe' && (!payload.parentId || payload.parentId === parent.id), 'worker_authority', 'Generated task must be a child of this attempt');
    return { ...parent, id: randomUUID(), parentId: parent.id, source: 'recipe', title: payload.title, description: payload.description,
      goal: payload.goal, acceptanceCriteria: payload.acceptanceCriteria, context: payload.context };
  }
  async function execute(token: CapabilityToken, request: WorkerRequest): Promise<WorkerResponse> {
    validateContract('WorkerRequest', request);
    const scope = store.broker.transaction(() => authorize(token, request));
    if (request.operation === 'native.start' || request.operation === 'native.continue') {
      const start = nativeStart(scope.attemptId, request.idempotencyKey);
      if (request.operation === 'native.start') ensure(canonical(request.payload) === canonical(start), 'native_authority', 'Native start must match server reservation');
      else {
        const r = authority.current(scope.attemptId);
        ensure(r.attempt.native && canonical(r.attempt.native) === canonical(request.payload.identity), 'native_authority', 'Continuation must retain actual native identity');
      }
      const intent = { attemptId: scope.attemptId, fence: scope.fence, key: request.idempotencyKey, payload: request };
      const validateIdentity = (identity: NativeIdentity) => {
        validateContract('NativeIdentity', identity);
        const bound = authority.current(scope.attemptId).attempt.native;
        ensure(identity.ownerId === start.task.ownerId && identity.providerId === start.task.providerId
          && (!bound || canonical(bound) === canonical(identity)), 'native_authority', 'Native completion differs from the actual bound session');
      };
      const existingClaim = (): NativeWrite | undefined => {
        authorize(token, request);
        if (!store.broker.write(scope.attemptId, scope.fence)) return;
        const write = store.broker.claim(intent).write; // Exact operation/key/body match, no new effect.
        if (write.result) {
          ensure(write.result.ok && write.result.requestId === request.requestId, 'native_authority', 'Invalid native receipt');
          if (request.operation === 'native.start' || write.result.result !== null) validateIdentity(validateContract('NativeIdentity', write.result.result));
        }
        return write;
      };
      // A receipt read is not a new native write and does not require fresh-start/quiescence eligibility.
      const existing = store.broker.transaction(existingClaim);
      if (existing?.result) return existing.result;
      ensure(deps.native, 'native_unsupported', 'A trusted native operation/reconciliation port is required');
      let verifiedForDispatch = false;
      if (!existing) {
        ensure(deps.profiles, 'native_unsupported', 'An effective profile verifier is required before native dispatch');
        await deps.profiles.requireVerifiedProfile(start); verifiedForDispatch = true;
      }
      // Existing unknown outcomes only use read-only reconciliation, even if the runtime has gone away.
      const claim = store.broker.transaction(() => {
        const prior = existingClaim(); // Reauthorize and re-read after asynchronous profile work.
        if (prior) return { fresh: false, write: prior };
        ensure(verifiedForDispatch, 'native_unsupported', 'No new dispatch may follow a reconciliation-only lookup');
        const record = store.getLifecycle(scope.attemptId);
        ensure(!record.state.stopRequested && !record.state.closeout, 'native_stopped', 'Attempt stopped or closeout started');
        if (request.operation === 'native.start') ensure(!record.reservation.attempt.native && !record.reservation.attempt.retryOfAttemptId, 'second_native_writer', 'Started native sessions cannot be replaced');
        else ensure(record.state.quiescent && !record.state.effect, 'second_native_writer', 'Continuation requires C4 quiescence and a fresh fence');
        return store.broker.claim(intent);
      });
      if (claim.write.result) return claim.write.result;
      let identity: NativeIdentity | undefined;
      try {
        if (!claim.fresh) {
          const recovered = await deps.native.reconcile(claim.write, start);
          ensure(recovered.state === 'done', 'native_unknown', 'Native outcome unknown; reconcile original intent without replay');
          identity = recovered.identity;
        } else if (request.operation === 'native.start') identity = await deps.native.start(start);
        else await deps.native.continue(scope.attemptId, request.payload.input, request.idempotencyKey);
        const response: WorkerResponse = { requestId: request.requestId, ok: true, result: request.operation === 'native.start' ? identity! : null };
        store.broker.transaction(() => {
          authorize(token, request);
          if (request.operation === 'native.start') validateIdentity(validateContract('NativeIdentity', identity));
          else if (identity) validateIdentity(identity);
          store.broker.settle(scope.attemptId, scope.fence, request.idempotencyKey, response);
        });
        return response;
      } catch (error) {
        store.broker.transaction(() => { if (store.broker.write(scope.attemptId, scope.fence)?.state !== 'done') store.broker.settle(scope.attemptId, scope.fence, request.idempotencyKey); });
        throw error;
      }
    }
    return store.broker.transaction(() => {
      authorize(token, request); // Revalidation and all local effects/receipt commit together.
      return store.broker.mutation(`${scope.attemptId}:${scope.fence}:${request.idempotencyKey}`, request, () => {
        let result: Extract<WorkerResponse, { ok: true }>['result'];
        switch (request.operation) {
          case 'task.create': {
            const spec = store.createGeneratedTask(generated(request.payload, scope.attemptId), scope, request.idempotencyKey);
            result = store.getTask(spec.id, scope)!; break;
          }
          case 'task.read': result = store.getTask(request.payload.taskId, scope)!; break;
          case 'task.update': {
            const { taskId, revision, ...patch } = request.payload; result = store.patchTask(taskId, patch, revision, scope, request.idempotencyKey); break;
          }
          case 'task.cancel': result = store.patchTask(request.payload.taskId, { status: 'cancelled' }, request.payload.revision, scope, request.idempotencyKey); break;
          case 'finding.upsert': {
            const payload = request.payload;
            ensure(payload.recipeId === scope.recipeId, 'finding_scope', 'Finding recipe must match attempt');
            const spec = store.upsertFinding({ ...payload, task: generated(payload.task, scope.attemptId) }, scope, request.idempotencyKey);
            // Dedup may reference another attempt's finding. Do not disclose its content or grant ownership.
            try { result = store.getTask(spec.id, scope)!; } catch (error) { if (!(error instanceof StoreError) || error.code !== 'task_scope') throw error; result = null; } break;
          }
          case 'result.submit': {
            ensure(request.payload.attemptId === scope.attemptId, 'result_scope', 'Result must match authenticated attempt');
            const r = authority.current(scope.attemptId);
            for (const id of request.payload.createdTaskIds) ensure(id !== r.task.spec.id && store.getTask(id, scope), 'result_scope', 'Result must reference actual scoped children');
            store.broker.saveProposal(request.payload); result = request.payload; break;
          }
          case 'artifact.register': {
            ensure(request.payload.attemptId === scope.attemptId, 'artifact_scope', 'Artifact must match attempt');
            result = { ...request.payload, id: randomUUID(), attemptId: scope.attemptId, createdAt: clock.wallNow().toISOString() };
            store.broker.saveArtifact(result); break;
          }
          case 'artifact.read': result = store.broker.artifact(request.payload.artifactId, scope.attemptId) ?? null; break;
          case 'attention.create': {
            const r = authority.current(scope.attemptId); const p = request.payload;
            ensure(p.attemptId === scope.attemptId && p.taskId === r.task.spec.id && p.repositoryId === r.task.spec.repositoryId
              && p.source === 'workflow' && p.status === 'open' && !p.resolvedAt && !p.nativeInputId, 'attention_scope', 'Worker attention cannot impersonate owner input or resolved state');
            const pending = p.kind === 'input' || p.kind === 'approval' ? deps.pendingNativeInput?.(scope.attemptId) : undefined;
            if (p.kind === 'input' || p.kind === 'approval') {
              ensure(pending, 'attention_input_unsupported', 'Open the actual native owner input; a trusted pending-input correlation is required');
              validateContract('NativeInput', pending.input); store.validateLifecycleIdentity(scope.attemptId, pending.identity);
            }
            const attention = pending ? { source: 'owner' as const, kind: 'input' as const, prompt: pending.input.prompt, recovery: p.recovery,
              inputSchema: pending.input.schema, nativeInputId: pending.input.id }
              : { source: 'workflow' as const, kind: p.kind, prompt: p.prompt, recovery: p.recovery, inputSchema: p.inputSchema };
            store.updateLifecycle(scope.attemptId, scope.fence, { attention });
            result = store.snapshot().attention.find(a => a.attemptId === scope.attemptId && a.prompt === attention.prompt && a.status === 'open'
              && (!pending || a.nativeInputId === pending.input.id))!; break;
          }
          default: throw Error('Operation denied');
        }
        const response = validateContract('WorkerResponse', { requestId: request.requestId, ok: true, result });
        encodeWorkerResponse(response); // A reply that cannot fit the wire must roll back the local mutation.
        return response;
      });
    });
  }
  return { ...authority, execute, nativeStart, getResultProposal: (attemptId: string) => store.broker.proposal(attemptId) };
}
export type AttemptBroker = ReturnType<typeof createAttemptBroker>;
