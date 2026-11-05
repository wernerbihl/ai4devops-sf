import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ActorScope, Clock, WorkerRequest } from '../contracts/domain.ts';
import type { FactoryStore } from '../storage/store.ts';
import { canonical, ensure } from '../storage/database.ts';
import { hasCapabilityGrants } from '../scheduling/eligibility.ts';
export type CapabilityToken = string;
export type Operation = WorkerRequest['operation'];
export const operations: readonly Operation[] = ['task.create','task.read','task.update','task.cancel','finding.upsert','native.start','native.continue','result.submit','artifact.register','artifact.read','attention.create'];
export interface AuthorizationTarget { repositoryId?: string; taskId?: string }
export interface CapabilityDeps { store: FactoryStore; clock: Clock; signingKey: Uint8Array; ttlMs?: number }
export function createCapabilityAuthority(deps: CapabilityDeps) {
  const { store, clock } = deps; const secret = Buffer.from(deps.signingKey); const ttl = deps.ttlMs ?? 300_000;
  ensure(secret.length >= 32 && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 1_800_000, 'invalid_signing_config', 'Protected signing key and bounded lifetime required');
  const sign = (id: Buffer) => createHmac('sha256', secret).update('sf-attempt-v1\0').update(id).digest();
  function current(attemptId: string) {
    return store.broker.transaction(() => {
    ensure(!store.broker.isRevoked(attemptId), 'attempt_revoked', 'Attempt authority has been permanently revoked');
    const r = store.getLifecycle(attemptId).reservation; const state = store.getAdmissionState(); const task = store.getTask(r.attempt.taskId);
    ensure(r.status !== 'released' && r.lease.active && r.lease.fence === r.attempt.fence
      && task?.attemptIds.at(-1) === attemptId && task.controlMode === 'factory' && !task.archivedAt
      && !['completed','failed','cancelled'].includes(task.status), 'stale_attempt', 'Current active attempt required');
    ensure(!state.settings.paused && state.repositories.find(v => v.id === task.spec.repositoryId)?.controlMode === 'factory'
      && state.activeLeases.filter(v => v.repositoryId === task.spec.repositoryId).length === 1
      && !store.getReservations().some(v => v.lease.repositoryId === task.spec.repositoryId && v.lease.fence > r.lease.fence), 'stale_fence', 'Latest exclusive repository fence required');
    const revision = store.getRecipeRevision(task.spec.recipeId, task.spec.recipeRevision);
    ensure(revision && state.recipeReadiness.some(v => v.recipeId === revision.recipeId && v.recipeRevision === revision.revision && v.hash === revision.hash && v.ready)
      && state.recipes.some(v => v.id === revision.recipeId && v.active) && state.tags.some(v => v.id === task.spec.tagId && !v.archivedAt), 'recipe_blocked', 'Pinned recipe readiness required');
    return r;
    });
  }
  function issueAttemptCapability(attemptId: string, grantIds: string[], allowed: readonly Operation[] = operations): CapabilityToken {
    return store.broker.transaction(() => {
      const r = current(attemptId); ensure(allowed.length > 0 && allowed.every(v => operations.includes(v)), 'operation_denied', 'Positive operation allowlist required');
      const ids = [...new Set(grantIds)].sort(); const grants = store.getAdmissionState().grants.filter(g => ids.includes(g.id));
      ensure(ids.length === grants.length && hasCapabilityGrants(r.task.spec, grants, clock), 'invalid_grant', 'Current exact-revision grants required');
      let scope = store.broker.scope(attemptId);
      if (!scope || scope.fence !== r.lease.fence) {
        scope = { attemptId, repositoryIds: [r.task.spec.repositoryId], recipeId: r.task.spec.recipeId, recipeRevision: r.task.spec.recipeRevision, grantIds: ids,
          expiresAt: new Date(clock.wallNow().getTime() + 86_400_000).toISOString(), fence: r.lease.fence };
        store.registerActor(scope, r.task.spec.id);
      }
      ensure(canonical(scope.grantIds) === canonical(ids), 'scope_changed', 'Grant changes require trusted attempt reauthorization');
      store.getTask(r.task.spec.id, scope);
      const id = randomBytes(32); store.broker.saveCapability({ id: id.toString('base64url'), scope, taskId: r.task.spec.id, reservationId: r.id,
        expiresAt: new Date(Math.min(Date.parse(scope.expiresAt), clock.wallNow().getTime() + ttl)).toISOString(), operations: [...allowed] });
      return Buffer.concat([id, sign(id)]).toString('base64url');
    });
  }
  function authorizeAttempt(token: CapabilityToken, operation: Operation, target: AuthorizationTarget = {}): ActorScope {
    return store.broker.transaction(() => {
    ensure(typeof token === 'string' && /^[A-Za-z0-9_-]{86}$/.test(token), 'invalid_capability', 'Invalid attempt capability');
    const bytes = Buffer.from(token, 'base64url'); ensure(bytes.toString('base64url') === token && timingSafeEqual(sign(bytes.subarray(0,32)), bytes.subarray(32)), 'invalid_capability', 'Invalid attempt capability');
    const cap = store.broker.capability(bytes.subarray(0,32).toString('base64url'));
    ensure(cap && Date.parse(cap.expiresAt) > clock.wallNow().getTime() && cap.operations.includes(operation) && operations.includes(operation), 'capability_denied', 'Capability expired, revoked or operation denied');
    const r = current(cap.scope.attemptId);
    ensure(r.id === cap.reservationId && r.lease.fence === cap.scope.fence && r.task.spec.id === cap.taskId, 'stale_fence', 'Capability no longer owns this reservation');
    ensure(!target.repositoryId || cap.scope.repositoryIds.includes(target.repositoryId), 'repository_scope', 'Repository outside attempt scope');
    ensure(store.getTask(target.taskId ?? cap.taskId, cap.scope), 'task_scope', 'Task outside attempt scope');
    return structuredClone(cap.scope);
    });
  }
  function currentGrantIds(attemptId: string): string[] {
    const r = current(attemptId);
    return store.getAdmissionState().grants.filter(g => g.recipeId === r.task.spec.recipeId && g.recipeRevision === r.task.spec.recipeRevision
      && g.repositoryIds.includes(r.task.spec.repositoryId) && !g.revokedAt && (!g.expiresAt || Date.parse(g.expiresAt) > clock.wallNow().getTime())).map(g => g.id).sort();
  }
  return { issueAttemptCapability, authorizeAttempt, current, currentGrantIds, revokeAttempt: (id: string) => store.broker.transaction(() => store.broker.revoke(id)) };
}
