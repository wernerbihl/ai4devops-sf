import {createRequire} from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Attempt, Clock, CloseoutResult, NativeIdentity, OwnerEvent, TaskResult, TaskSpec, NativeStart } from '../contracts/domain.ts';
import type { NativeOwner } from '../contracts/owner.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreError, ensure, fingerprint } from '../storage/database.ts';
import type { FactoryStore, OutboxAction } from '../storage/store.ts';
import type { LifecycleUpdate } from '../storage/lifecycle.ts';
import type { PreparedStart, UnavailableStart } from './admission-types.ts';
import { accountActive } from './leases.ts';
import type { Quiescence } from './leases.ts';
import { hasCapabilityGrants } from './eligibility.ts';
import { lifecycleActionKinds, verifySnapshot } from './recovery.ts';

const answerValidator=new Ajv2020({strict:false});(createRequire(import.meta.url)('ajv-formats') as typeof import('ajv-formats').default)(answerValidator);

export interface TransientFailure { transient: boolean; reason: string }
export interface HumanOpenContext { readonly start:NativeStart; assertCurrent():void }
export interface LifecycleDeps {
  store: FactoryStore; clock: Clock;
  owner(identity: NativeIdentity): NativeOwner;
  readiness(task: TaskSpec, attempt: Attempt): Promise<PreparedStart | UnavailableStart>;
  workspace(attempt: Attempt): Promise<boolean>;
  /** Trusted managed-owner stopped receipts only. Preflight never starts a process or claims live history.
   * prepare runs under the acquired writer fence and active effect accounting; it must restore only the
   * original runtime/state, authenticate, rebind tools, verify containment and reconcile original history. */
  managedHumanOpen?: {prepare(attempt:Attempt,key:string,context:HumanOpenContext):Promise<void>};
  managedContinuation?: {
    preflight(attempt: Attempt): Promise<PreparedStart | UnavailableStart | undefined>;
    prepare(attempt: Attempt, key: string): Promise<void>;
  };
  workflow: {
    /** Reconcile this exact execution; never create an execution during recovery. */
    snapshot(attempt: Attempt): Promise<'present' | 'absent' | 'unknown'>;
    quiesce(attempt: Attempt, key: string): Promise<Quiescence>;
    /** Resume workflow bookkeeping only. NativeOwner.send is the sole native turn driver. */
    resume(attempt: Attempt, key: string): Promise<void>;
  };
}
export interface Lifecycle {
  applyOwnerEvent(attemptId: string, event: OwnerEvent): Promise<void>;
  requestTakeover(taskId: string, key?: string): Promise<void>;
  /** Existing C5 OwnerPort.open delegates here, including already-human focus. */
  openNative(identity:NativeIdentity,key:string):Promise<{uri?:string}>;
  returnControl(repositoryId: string, key?: string): Promise<void>;
  resumeInput(requestId: string, value: unknown, key: string): Promise<void>;
  retryTransient(attemptId: string, failure: TransientFailure): Promise<Attempt | null>;
  checkBudgets(): Promise<void>;
  dispatchPending(): Promise<{ kind: 'started'; attemptId: string } | null>;
  reconnect(): Promise<void>;
  waitForCI(attemptId: string): Promise<void>;
  /** Trusted C8 handoff: quiesce but retain writer lease for protected metadata operations. */
  prepareCloseout(attemptId: string, result: TaskResult): Promise<void>;
  finishCloseout(attemptId: string, result: TaskResult, outcome: CloseoutResult): Promise<void>;
  rejectCloseout(attemptId: string, outcome: CloseoutResult): Promise<void>;
}

/** Trusted source controller. HTTP/worker callers receive none of its persistence capabilities. */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { store, clock } = deps; const epoch = store.getLifecycleEpoch();
  // SQLite transitions coordinate effects; external promises never own a controller-wide lane.
  const operation = <T>(fn: () => Promise<T>): Promise<T> => fn();
  const record = (id: string) => store.getLifecycle(id);
  const budget = () => store.getSettings().config.limits.activeMinutes * 60000;
  function account(id: string, stop: boolean): Pick<LifecycleUpdate, 'state' | 'activeDurationMs'> {
    const r = record(id); const value = accountActive(r.reservation.attempt, r.state, clock, epoch, stop, budget());
    return { state: value.state, activeDurationMs: value.duration };
  }
  async function quiet(id: string, closeout = false): Promise<Quiescence> {
    const r = record(id).reservation;
    ensure(closeout || record(id).state.closeout?.phase !== 'metadata', 'closeout_inflight', 'Trusted Git closeout must finish before releasing ownership');
    ensure(r.attempt.native && r.attempt.workflow, 'identity_missing', 'Reconnect original native and workflow identities');
    const effectAtRequest = record(id).state.effect;
    const generation = effectAtRequest ? `${effectAtRequest.token}:${effectAtRequest.phase}` : 'none';
    const action = store.enqueueAction({ key: `lifecycle:quiesce:${id}:${r.lease.fence}:${generation}`, kind: 'lifecycle.quiesce', payload: { attemptId: id, fence: r.lease.fence, generation } });
    let native: Quiescence = 'unknown'; let workflow: Quiescence = 'unknown';
    try { [native, workflow] = await Promise.all([deps.owner(r.attempt.native).quiesce(r.attempt.native), deps.workflow.quiesce(r.attempt, action.key)]); } catch { /* Unknown preserves the writer lease. */ }
    if (native === 'unknown' || workflow === 'unknown') throw new StoreError('quiescence_unknown', 'Prove both native and workflow execution stopped or waiting before release');
    const current = record(id);
    ensure(closeout || current.state.closeout?.phase !== 'metadata', 'closeout_inflight', 'Trusted Git closeout began while proving quiescence; retain ownership');
    ensure(current.reservation.lease.fence === r.lease.fence, 'stale_fence', 'Quiescence belongs to an obsolete repository fence');
    ensure(!effectAtRequest || effectAtRequest.phase === 'accepted', 'effect_unresolved', 'Quiescence raced an external effect that may still accept');
    ensure(!current.state.effect || (current.state.effect.phase === 'accepted' && current.state.effect.token === effectAtRequest?.token), 'effect_unresolved', 'Execution changed while proving quiescence');
    const nativeWrite = store.broker.write(id, r.lease.fence);
    ensure(!nativeWrite || nativeWrite.state === 'done', 'effect_unresolved', 'Broker native write may still accept; retain the fence until its original response is proven');
    store.completeAction(action.id); return native;
  }
  async function pause(id: string, status: NonNullable<LifecycleUpdate['status']>, attention?: LifecycleUpdate['attention'], human = false): Promise<void> {
    const r = record(id).reservation;
    const action = store.enqueueAction({ key: `lifecycle:pause:${id}:${r.lease.fence}:${fingerprint({ status, attention, human })}`, kind: 'lifecycle.pause', payload: { attemptId: id, fence: r.lease.fence, status, ...(attention ? { attention } : {}), human } });
    const accounted = account(id, !record(id).state.active);
    // Persist accounting and the stop request before awaiting external quiescence proof.
    store.updateLifecycle(id, r.lease.fence, { ...accounted, state: { ...accounted.state!, stopRequested: true }, status: 'needs_attention', ...(attention ? { attention } : {}) });
    const proof = await quiet(id);
    const stopped = account(id, true);
    store.updateLifecycle(id, r.lease.fence, { ...stopped, state: { ...stopped.state!, uncertain: stopped.activeDurationMs! >= budget() }, status, release: proof, human, ...(attention ? { attention } : {}) });
    store.completeAction(action.id);
  }

  async function reconcile(attempt: Attempt): Promise<boolean> {
    if (!attempt.native || !attempt.workflow) return false;
    try {
      const snapshot = await deps.owner(attempt.native).snapshot(attempt.native);
      if (!verifySnapshot(attempt, snapshot)) return false;
      return await deps.workflow.snapshot(attempt) === 'present';
    } catch { return false; }
  }
  async function preflight(id: string): Promise<string> {
    const attempt = record(id).reservation.attempt; const task = store.getTask(attempt.taskId)!;
    const state = store.getAdmissionState();
    ensure(hasCapabilityGrants(task.spec, state.grants, clock)
      && state.recipes.some(recipe => recipe.id === task.spec.recipeId && recipe.active)
      && state.recipeReadiness.some(r => r.recipeId === task.spec.recipeId && r.recipeRevision === task.spec.recipeRevision && r.ready)
      && state.tags.some(tag => tag.id === task.spec.tagId && !tag.archivedAt), 'capability_blocked', 'Revalidate the pinned recipe and explicit capability grants');
    const stopped = await deps.managedContinuation?.preflight(attempt);
    const prepared = stopped ?? await deps.readiness(task.spec, attempt);
    ensure(prepared.ready, prepared.ready ? 'unavailable' : prepared.code, prepared.ready ? 'Unavailable' : prepared.recovery);
    ensure(prepared.baseSha === attempt.baseSha && prepared.workspacePath === attempt.workspacePath && prepared.profileId === attempt.profileId
      && await deps.workspace(attempt), 'workspace_changed', 'Revalidate the original isolated workspace; do not allocate a replacement');
    ensure(stopped ? !!attempt.native && await deps.workflow.snapshot(attempt) === 'present' : await reconcile(attempt), 'identity_missing', 'Reconnect original native and workflow history');
    return state.token;
  }
  async function runAction(action: OutboxAction): Promise<Attempt | null> {
    if (!lifecycleActionKinds.has(action.kind) || action.completedAt) return null;
    const sourceId = String(action.payload.attemptId);
    let binding = store.getLifecycleActionBinding(action.id);
    if (!binding) {
      const token = await preflight(sourceId);
      const r = store.acquireLifecycle(sourceId, token, action.kind === 'lifecycle.retry', action.id); binding = { attemptId: r.attempt.id, fence: r.lease.fence };
    }
    const r = record(binding.attemptId).reservation;
    ensure(r.lease.active && r.lease.fence === binding.fence, 'stale_fence', 'Pending action has an obsolete lease');
    if (await enforceBudget(r.attempt.id)) throw new StoreError('active_time_limit', 'Attempt active execution budget is exhausted');
    store.assertLifecycleAuthority(r.attempt.id, binding.fence);
    // Snapshot before every replay; actions retain their original external idempotency key.
    const stopped = await deps.managedContinuation?.preflight(r.attempt);
    if (!stopped) ensure(await reconcile(r.attempt), 'identity_missing', 'Reconcile snapshots before replaying native actions');
    const token = store.assertLifecycleAuthority(r.attempt.id, binding.fence);
    const prepared = stopped ?? await deps.readiness(store.getTask(r.attempt.taskId)!.spec, r.attempt);
    ensure(prepared.ready && prepared.workspacePath === r.attempt.workspacePath && prepared.baseSha === r.attempt.baseSha && prepared.profileId === r.attempt.profileId && await deps.workspace(r.attempt), 'unavailable', 'Revalidate original workspace before sending');
    ensure(store.assertLifecycleAuthority(r.attempt.id, binding.fence) === token, 'admission_changed', 'Policy changed before native send');
    // External preflight can itself consume the remaining active budget.
    if (await enforceBudget(r.attempt.id)) throw new StoreError('active_time_limit', 'Attempt active execution budget is exhausted');
    const lifecycleState = record(r.attempt.id).state;
    ensure(!lifecycleState.uncertain, 'active_time_uncertain', 'Interrupted active execution requires explicit reconciliation');
    const effectToken = store.beginLifecycleAction(r.attempt.id, binding.fence, epoch, action.id);
    let accepted = false;
    try {
      if (stopped) {
        await deps.managedContinuation!.prepare(r.attempt, action.key);
        assertEffect(r.attempt.id, binding.fence, effectToken);
        ensure(store.assertLifecycleAuthority(r.attempt.id, binding.fence) === token, 'admission_changed', 'Policy changed during managed restart');
        ensure(await reconcile(r.attempt), 'identity_missing', 'Original native history missing after managed restart');
        const live = await deps.readiness(store.getTask(r.attempt.taskId)!.spec, r.attempt);
        ensure(live.ready && live.workspacePath === r.attempt.workspacePath && live.baseSha === r.attempt.baseSha && live.profileId === r.attempt.profileId && await deps.workspace(r.attempt), 'unavailable', 'Fresh managed runtime proof required after restart');
        assertEffect(r.attempt.id, binding.fence, effectToken);
        ensure(store.assertLifecycleAuthority(r.attempt.id, binding.fence) === token, 'admission_changed', 'Policy changed after managed restart verification');
        if (await enforceBudget(r.attempt.id)) throw new StoreError('active_time_limit', 'Attempt active execution budget is exhausted');
      }
      await deps.workflow.resume(r.attempt, action.key);
      assertEffect(r.attempt.id, binding.fence, effectToken);
      ensure(store.assertLifecycleAuthority(r.attempt.id, binding.fence) === token, 'admission_changed', 'Policy changed during workflow resume');
      if (await enforceBudget(r.attempt.id)) throw new StoreError('active_time_limit', 'Attempt active execution budget is exhausted');
      assertEffect(r.attempt.id, binding.fence, effectToken);
      await deps.owner(r.attempt.native!).send(r.attempt.native!, action.payload.input as object, action.key);
      accepted = true; store.settleLifecycleEffect(r.attempt.id, binding.fence, effectToken, 'accepted');
      assertEffect(r.attempt.id, binding.fence, effectToken);
      const accrued = account(r.attempt.id, false);
      store.finishLifecycleAction(action.id, r.attempt.id, binding.fence, accrued.state!, accrued.activeDurationMs!, effectToken);
    } catch (error) {
      if (!accepted) store.settleLifecycleEffect(r.attempt.id, binding.fence, effectToken, 'unknown');
      throw error;
    }
    await checkBudgets();
    return record(r.attempt.id).reservation.attempt;
  }
  async function dispatchPending(): Promise<{ kind: 'started'; attemptId: string } | null> {
    for (const action of store.pendingActions().filter(a => lifecycleActionKinds.has(a.kind))) {
      try { const attempt = await runAction(action); if (attempt) return { kind: 'started', attemptId: attempt.id }; }
      catch (error) { if (!(error instanceof StoreError)) throw error; }
    }
    return null;
  }
  async function openNative(identity:NativeIdentity,key:string):Promise<{uri?:string}> {
    const matches=store.getReservations().filter(r=>r.attempt.native&&fingerprint(r.attempt.native)===fingerprint(identity)&&store.getTask(r.attempt.taskId)?.attemptIds.at(-1)===r.attempt.id);
    ensure(matches.length===1,'identity_missing','Native identity must match one current reservation');
    const r=matches[0]!;
    const task=store.getTask(r.attempt.taskId)!;const repo=store.getRepository(task.spec.repositoryId)!;
    const assertCurrent=()=>{const current=store.getTask(task.spec.id);const repository=store.getRepository(repo.id);const actual=record(r.attempt.id).reservation;
      ensure(repository?.controlMode==='human'&&repository.revision===repo.revision&&current?.revision===task.revision&&current.status!=='cancelled'&&current.attemptIds.at(-1)===r.attempt.id&&fingerprint(actual.attempt.native)===fingerprint(identity)&&!store.getAdmissionState().activeLeases.some(l=>l.repositoryId===repo.id),'human_open_unadmitted','Human navigation admission changed; retain original runtime');};
    assertCurrent();
    const prior=store.getActionByKey(`lifecycle:human-open:${key}`);
    if(prior){const receipt=store.getActionByKey(`lifecycle:human-open-result:${key}`);ensure(receipt?.payload.intentId===prior.id,'effect_unresolved','Original native open is pending or unknown; never repeat navigation');return receipt.payload.result as {uri?:string}}
    const action=store.enqueueAction({key:`lifecycle:human-open:${key}`,kind:'lifecycle.human_open',payload:{attemptId:r.attempt.id,repositoryId:repo.id,identity}});
    const start:NativeStart={idempotencyKey:key,attemptId:r.attempt.id,task:task.spec,workspacePath:r.attempt.workspacePath,baseSha:r.attempt.baseSha,fence:r.lease.fence,profileId:r.attempt.profileId};
    try {
      await deps.managedHumanOpen?.prepare(r.attempt,key,{start,assertCurrent});assertCurrent();
      const result=await deps.owner(identity).open(identity);assertCurrent();const receipt=store.enqueueAction({key:`lifecycle:human-open-result:${key}`,kind:'lifecycle.human_open_result',payload:{intentId:action.id,result}});store.completeAction(receipt.id);store.completeAction(action.id);return result;
    } catch(error) {
      // An unknown/late restart must keep repository control excluded from automatic admission.
      try {await deps.owner(identity).quiesce(identity);}catch{}
      throw error;
    }
  }
  async function takeover(taskId: string): Promise<void> {
    const task = store.getTask(taskId); ensure(task, 'not_found', 'Task not found');
    const repo = store.getRepository(task.spec.repositoryId)!;
    if (repo.controlMode !== 'human') store.setRepositoryControl(repo.id, 'human', repo.revision);
    const id = task.attemptIds.at(-1); ensure(id, 'identity_missing', 'No started native identity to open');
    const r = record(id).reservation;
    const humanRevision=store.getRepository(repo.id)!.revision;
    const action = store.enqueueAction({ key: `lifecycle:takeover:${taskId}:${id}:${humanRevision}`, kind: 'lifecycle.takeover', payload: { taskId, attemptId: id, humanRevision } });
    if(action.completedAt)return;
    // Repository ownership applies to every native writer, including a different task than the one opened.
    for (const current of store.getReservations().filter(value => value.lease.repositoryId === repo.id && value.lease.active)) {
      await pause(current.attempt.id, 'needs_attention', undefined, true);
    }
    await quiet(id);
    ensure(store.getRepository(repo.id)?.controlMode === 'human', 'control_mode', 'Native handoff requires paused repository control');
    await openNative(r.attempt.native!,action.key); store.completeAction(action.id);
  }
  const api: Lifecycle = {
    prepareCloseout: async (id, result) => {
      validateContract('TaskResult', result);
      ensure(result.attemptId === id, 'invalid_result', 'Result attempt identity changed');
      const r = record(id).reservation;
      store.enqueueAction({ key: `closeout:${id}:input`, kind: 'closeout.input', payload: { result } });
      if (!r.lease.active) {
        ensure(record(id).state.closeout?.phase === 'monitoring', 'stale_fence', 'Closeout requires the current frozen attempt'); return;
      }
      store.assertLifecycleAuthority(id, r.lease.fence);
      const state = record(id).state;
      store.updateLifecycle(id, r.lease.fence, { state: { ...state, stopRequested: true, closeout: { phase: 'metadata', fence: r.lease.fence } } });
      await quiet(id, true);
      const stopped = account(id, true);
      store.updateLifecycle(id, r.lease.fence, { ...stopped, state: { ...stopped.state!, quiescent: true } });
    },
    finishCloseout: async (id, result, outcome) => {
      const r = record(id).reservation;
      if (r.lease.active) {
        await quiet(id, true);
        const stopped = account(id, true);
        store.updateLifecycle(id, r.lease.fence, { ...stopped, state: { ...stopped.state!, quiescent: true } });
      }
      store.saveCloseout(id, result, outcome, true);
    },
    rejectCloseout: async (id, outcome) => {
      ensure(outcome.kind === 'needs_attention', 'invalid_closeout', 'Rejected closeout cannot report completion');
      store.saveCloseout(id, undefined, outcome, false);
    },
    applyOwnerEvent: (id, event) => operation(async () => {
      validateContract('OwnerEvent', event);
      if (event.type === 'identity') store.bindLifecycleIdentity(id, event.identity);
      else store.validateLifecycleIdentity(id, event.identity);
      const r = record(id).reservation;
      if (event.type === 'snapshot') store.validateLifecycleIdentity(id, event.snapshot.identity);
      // Retained human sessions and late events after explicit return are observational only.
      // A fresh factory lease is required before events may drive factory budgets or input pauses.
      const task=store.getTask(r.attempt.taskId)!;
      if(store.getRepository(task.spec.repositoryId)?.controlMode==='human'||task.controlMode==='human'||!r.lease.active)return;
      const pendingInput = event.type === 'input' ? event.input : event.type === 'snapshot' && event.snapshot.state === 'waiting' ? event.snapshot.inputs[0] : undefined;
      if (pendingInput) {
        // Fresh snapshots during an admitted reply may still contain that exact unanswered request.
        // Its persisted, validated response is already queued; do not freeze it again before send.
        const sameOpen=store.snapshot().attention.find(a=>a.taskId===r.attempt.taskId&&a.nativeInputId===pendingInput.id&&a.status==='open');
        if(sameOpen&&record(id).state.stopRequested)return;
        const answered=store.snapshot().attention.find(a=>a.taskId===r.attempt.taskId&&a.nativeInputId===pendingInput.id&&a.status==='responded');
        if(answered&&store.pendingActions().some(a=>a.kind==='lifecycle.send'&&a.payload.attemptId===id&&a.payload.requestId===answered.id))return;
        await pause(id, 'waiting_input', { kind: 'input', prompt: pendingInput.prompt, recovery: 'Answer this request to continue the original native session', inputSchema: pendingInput.schema, nativeInputId: pendingInput.id }); return;
      }
      if (event.type === 'connection_lost' || (event.type === 'snapshot' && event.snapshot.state === 'lost')) {
        store.updateLifecycle(id, r.lease.fence, { ...account(id, !record(id).state.active), status: 'needs_attention', state: { ...account(id, !record(id).state.active).state!, uncertain: true }, attention: { kind: 'blocked', prompt: 'Native connection lost', recovery: 'Reconnect original session and prove quiescence; lease expiry does not release ownership' } }); return;
      }
      const active = event.type === 'activity' ? event.active : event.type === 'snapshot' ? event.snapshot.state === 'active' : undefined;
      store.updateLifecycle(id, r.lease.fence, { ...(active !== undefined ? account(id, false) : {}), ...(event.type === 'usage' ? { usage: event.usage } : event.type === 'snapshot' && event.snapshot.usage ? { usage: event.snapshot.usage } : {}) });
      // Native idle is observational: detached tools may still write. Only proven
      // quiescence/input/CI/closeout may end an admitted active segment.
      await checkBudgets();
    }),
    requestTakeover: taskId => operation(() => takeover(taskId)),
    openNative: (identity,key)=>operation(()=>openNative(identity,key)),
    returnControl: repositoryId => operation(async () => {
      const repo = store.getRepository(repositoryId); ensure(repo, 'not_found', 'Repository not found');
      ensure(repo.controlMode === 'human', 'control_mode', 'Repository is not under human control');
      ensure(!store.pendingActions().some(a=>a.kind==='lifecycle.human_open'&&a.payload.repositoryId===repositoryId),'human_open_pending','Human native control start/open is pending or unknown; reconcile before return');
      const attempts = store.getReservations().filter(r => r.lease.repositoryId === repositoryId && r.status === 'confirmed');
      // Terminal history can still own a human/background writer after an explicit native open.
      // Stop every latest owned runtime before restoring repository automation.
      for (const r of attempts.filter(r => store.getTask(r.attempt.taskId)!.attemptIds.at(-1) === r.attempt.id)) {
        if (r.lease.active) await pause(r.attempt.id, 'needs_attention', undefined, true);
        else await quiet(r.attempt.id);
        if (['completed', 'failed', 'cancelled'].includes(store.getTask(r.attempt.taskId)!.status)) continue;
        const token = await preflight(r.attempt.id);
        ensure(store.getAdmissionState().token === token, 'admission_changed', 'Policy changed while returning control');
      }
      ensure(!store.pendingActions().some(a=>a.kind==='lifecycle.human_open'&&a.payload.repositoryId===repositoryId),'human_open_pending','Human native control start/open began during return; reconcile before release');
      store.returnLifecycleControl(repositoryId, repo.revision, store.getAdmissionState().token);
      for (const r of attempts.filter(r => store.getTask(r.attempt.taskId)?.attemptIds.at(-1) === r.attempt.id)) {
        const task = store.getTask(r.attempt.taskId)!;
        if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        // An original unanswered native question remains frozen for its exact typed answer.
        if (store.snapshot().attention.some(a => a.attemptId === r.attempt.id && a.nativeInputId && a.status === 'open')) continue;
        store.enqueueAction({ key: `lifecycle:return:${repositoryId}:${repo.revision}:${r.attempt.id}`, kind: 'lifecycle.send', payload: { attemptId: r.attempt.id, input: { text: 'Human control has explicitly returned to the factory. Continue the original task and report its explicit result.' } } });
      }
      // An explicit return cancels an unfinished open request; reconnect must not take control back.
      for (const action of store.pendingActions().filter(a => a.kind === 'lifecycle.takeover' && store.getTask(String(a.payload.taskId))?.spec.repositoryId === repositoryId)) store.completeAction(action.id);
    }),
    resumeInput: (requestId, value, key) => operation(async () => {
      const request = store.snapshot().attention.find(a => a.id === requestId);
      ensure(request, 'not_found', 'Attention request not found');
      let valid = false;
      try { valid = answerValidator.compile(request.inputSchema)(value) as boolean; } catch { /* Malformed schemas cannot admit input. */ }
      ensure(valid, 'invalid_answer', 'Answer does not match the trusted native input schema');
      const action = store.queueLifecycleReply(requestId, value, key);
      if (!action.completedAt) { try { await runAction(action); } catch (error) { if (!(error instanceof StoreError)) throw error; } }
    }),
    retryTransient: (id, failure) => operation(async () => {
      const r = record(id).reservation; const task = store.getTask(r.attempt.taskId)!;
      ensure(task.attemptIds.at(-1) === id, 'stale_attempt', 'Retry requires the current attempt');
      const attempts = store.snapshot().attempts.filter(a => a.taskId === task.spec.id && a.retryOfAttemptId);
      const allowed = failure.transient && attempts.length < store.getSettings().config.limits.transientRetries;
      if (r.lease.active) await pause(id, allowed ? 'failed' : 'needs_attention', { kind: 'error', prompt: failure.reason, recovery: allowed ? 'Retry original native session' : 'Inspect failure; automatic retries exhausted' });
      if (!allowed) return null;
      const action = store.enqueueAction({ key: `lifecycle:retry:${id}`, kind: 'lifecycle.retry', payload: { attemptId: id, input: { retryOfAttemptId: id, reason: failure.reason } } });
      try { return await runAction(action); } catch (error) { if (!(error instanceof StoreError)) throw error; return null; }
    }),
    checkBudgets: () => operation(checkBudgets),
    dispatchPending: () => operation(dispatchPending),
    reconnect: () => operation(async () => {
      for (const r of store.getReservations()) {
        if (r.status === 'pending' && !r.attempt.retryOfAttemptId && r.externalIdentity) store.confirmStart(r.id, r.externalIdentity);
        if (r.lease.active && r.status === 'confirmed' && r.attempt.native) {
          if (!await reconcile(r.attempt)) continue;
          const active = record(r.attempt.id).state.active;
          if (active && active.epoch !== epoch) await pause(r.attempt.id, 'needs_attention', { kind: 'blocked', prompt: 'Active time uncertain after restart', recovery: 'Inspect original execution before explicit continuation' });
        }
      }
      for (const action of store.pendingActions().filter(a => a.kind === 'lifecycle.pause')) {
        const id = String(action.payload.attemptId); const r = record(id).reservation;
        if (!r.lease.active || r.lease.fence !== action.payload.fence) { store.completeAction(action.id); continue; }
        if (!await reconcile(r.attempt)) continue;
        try { await pause(id, action.payload.status as NonNullable<LifecycleUpdate['status']>, action.payload.attention as LifecycleUpdate['attention'], Boolean(action.payload.human)); }
        catch (error) { if (!(error instanceof StoreError)) throw error; }
      }
      for (const action of store.pendingActions().filter(a => a.kind === 'lifecycle.takeover')) {
        const r = record(String(action.payload.attemptId)).reservation;
        if (!await reconcile(r.attempt)) continue;
        try { await takeover(String(action.payload.taskId)); } catch (error) { if (!(error instanceof StoreError)) throw error; }
      }
      await dispatchPending();
    }),
    waitForCI: id => operation(() => pause(id, 'waiting_ci')),
  };
  function assertEffect(id: string, fence: number, token: string): void {
    const current = record(id);
    ensure(current.reservation.lease.active && current.reservation.lease.fence === fence, 'stale_fence', 'External completion belongs to an obsolete lease');
    ensure(current.state.effect?.token === token && !current.state.stopRequested, 'effect_interrupted', 'An interrupted external effect cannot drive or finalize execution');
    store.assertLifecycleAuthority(id, fence);
  }
  async function enforceBudget(id: string): Promise<boolean> {
    const r = record(id).reservation;
    if (!r.lease.active || (r.status !== 'confirmed' && !r.attempt.retryOfAttemptId)) return false;
    const accrued = account(id, !record(id).state.active);
    store.updateLifecycle(id, r.lease.fence, accrued);
    if (accrued.activeDurationMs! < budget()) return false;
    try { await pause(id, 'needs_attention', { kind: 'blocked', prompt: 'Active execution time limit reached', recovery: 'Inspect the stopped native execution and reconcile unresolved action keys' }); }
    catch (error) {
      if (!(error instanceof StoreError) || !['effect_unresolved', 'unconfirmed_start', 'quiescence_unknown', 'stale_fence'].includes(error.code)) throw error;
    }
    return true;
  }
  async function checkBudgets(): Promise<void> {
    await Promise.all(store.getReservations().filter(r => r.lease.active && (r.status === 'confirmed' || !!r.attempt.retryOfAttemptId)).map(r => enforceBudget(r.attempt.id)));
  }
  return api;
}
