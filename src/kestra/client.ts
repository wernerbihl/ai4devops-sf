import { parse } from 'yaml';
import type { TaskResult, WorkflowIdentity, WorkflowSnapshot, WorkflowStart } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { decodeWorkerResponse } from '../contracts/worker-transport.ts';
import { canonical, fingerprint } from '../storage/database.ts';
import { validateRecipe } from '../recipes/validate.ts';
import { isBrokerFlow } from '../recipes/policy.ts';
import { check, checked, ExecutionJournal, verifyExecution } from './executions.ts';
import type { EngineExecution, EngineTransport, ExecutionIntent } from './executions.ts';
import { authorizedWire } from './pause.ts';
import type { KestraAuthority } from './pause.ts';
export interface KestraPort {
  ensureExecution(start: WorkflowStart): Promise<WorkflowIdentity>;
  snapshot(identity: WorkflowIdentity): Promise<WorkflowSnapshot>;
  resumeInput(identity: WorkflowIdentity, input: TaskResult, key: string): Promise<void>;
  stop(identity: WorkflowIdentity): Promise<void>;
}
export interface KestraClientOptions { journalDirectory: string; request: EngineTransport; authority: KestraAuthority; }
export class KestraClient implements KestraPort {
  private journal: ExecutionJournal; private request: EngineTransport; private authority: KestraAuthority;
  constructor(options: KestraClientOptions) { this.journal = new ExecutionJournal(options.journalDirectory); this.request = options.request; this.authority = options.authority; }
  close(): void { this.journal.close(); }
  private async importFlow(record: ExecutionIntent): Promise<void> {
    const expected = { ...parse(record.start.recipe.yaml), id: record.flowId, namespace: record.namespace };
    const path = `/flows/${record.namespace}/${record.flowId}?source=true&revision=${record.engineRevision}`;
    let r = await this.request({ method: 'GET', path });
    if (r.status === 404) {
      try { await checked(this.request, { method: 'POST', path: '/flows', body: JSON.stringify(expected) }); } catch { /* reconcile import by immutable name/content */ }
      r = await this.request({ method: 'GET', path });
    }
    check(r.status === 200 && r.body?.revision === record.engineRevision, 'Immutable engine flow unavailable or revision mismatch');
    const { revision: _revision, source, ...actual } = r.body;
    check(canonical(source ? parse(source) : actual) === canonical(expected), 'Immutable engine flow content mismatch');
  }
  private async find(record: ExecutionIntent): Promise<WorkflowIdentity | undefined> {
    const query = new URLSearchParams({ size: '2', 'filters[namespace][EQUALS]': record.namespace, 'filters[flowId][EQUALS]': record.flowId, 'filters[labels][EQUALS][sf_attempt]': fingerprint(record.start.attemptId) });
    const found = await checked(this.request, { method: 'GET', path: '/executions/search?' + query });
    check(Number.isInteger(found.total) && found.total <= 1 && Array.isArray(found.results) && found.results.length === found.total, 'Ambiguous execution lookup');
    return found.results[0] ? verifyExecution(found.results[0], record) : undefined;
  }
  async ensureExecution(start: WorkflowStart): Promise<WorkflowIdentity> {
    validateContract('WorkflowStart', start); check(!Object.keys(start.inputs).some(k => k.startsWith('sf_')), 'Reserved sf_ input override');
    const validated = validateRecipe(start.recipe.yaml, []);
    check(validated.hash === start.recipe.hash && canonical(validated.contract) === canonical(start.recipe.contract) && isBrokerFlow(validated.contract), 'Invalid immutable broker recipe');
    let record = this.journal.create({ start: structuredClone(start), hash: fingerprint(start), namespace: 'sf.managed', flowId: 'r_' + fingerprint({ revision: start.recipe.revision, hash: start.recipe.hash }).slice(0, 40), engineRevision: 1, phase: 'prepared' });
    if (record.phase === 'known') { const e = await this.get(record); return verifyExecution(e, record); }
    if (record.phase === 'sent') { const found = await this.find(record); check(found, 'Unknown start outcome; reconciliation required, no resubmission'); return this.remember(record, found); }
    await this.importFlow(record);
    const authorized = await this.authority.start(start); const wire = authorizedWire(authorized, start, 'native.start');
    let claimed = false;
    record = this.journal.update(start.attemptId, v => { if (v.phase === 'prepared') { v.phase = 'sent'; v.nativeRequestId = authorized.request.requestId; v.nativeTaskId = authorized.request.operation === 'native.start' ? authorized.request.payload.task.id : ''; claimed = true; } });
    if (!claimed) return this.ensureExecution(start);
    const query = new URLSearchParams({ revision: String(record.engineRevision) });
    query.append('labels', 'sf_attempt:' + fingerprint(start.attemptId)); query.append('labels', 'sf_revision:' + fingerprint(start.recipe.revision));
    try {
      const e = await checked(this.request, { method: 'POST', path: `/executions/${record.namespace}/${record.flowId}?${query}`, body: { sf_capability: authorized.capability, sf_native_start: wire } });
      return this.remember(record, verifyExecution(e, record));
    } catch { const found = await this.find(record); check(found, 'Unknown start outcome; reconciliation required, no resubmission'); return this.remember(record, found); }
  }
  private remember(record: ExecutionIntent, identity: WorkflowIdentity): WorkflowIdentity { this.journal.update(record.start.attemptId, v => { v.identity = identity; v.phase = 'known'; }); return identity; }
  private async get(record: ExecutionIntent): Promise<EngineExecution> {
    check(record.identity, 'Execution identity is not reconciled');
    const e = await checked(this.request, { method: 'GET', path: '/executions/' + record.identity.executionId });
    check(verifyExecution(e, record).executionId === record.identity.executionId, 'Execution identity mismatch'); return e;
  }
  /** E6 lifecycle bookkeeping only: does not resume the Pause or send to the native owner. */
  async rebindContinuation(identity: WorkflowIdentity, key: string): Promise<void> {
    check(key.length > 0 && this.authority.continuation, 'Trusted continuation authority is required');
    const record = this.journal.identity(identity);
    if (record.continuationKeys?.[key]) return;
    const binding = await this.authority.continuation(identity, key);
    validateContract('NativeIdentity', binding.native);
    const current = record.binding ?? { attemptId: record.start.attemptId, fence: record.start.fence };
    check(binding.previousAttemptId === current.attemptId && binding.fence > current.fence && binding.taskId === record.nativeTaskId && binding.recipeId === record.start.recipe.recipeId && binding.recipeRevision === record.start.recipe.revision, 'Continuation authority identity/fence mismatch');
    // The original broker acknowledgement pins the native session across retries/takeovers.
    const output = await checked(this.request, { method: 'POST', path: `/executions/${identity.executionId}/actions/eval`, body: '{{ outputs.native_start.body }}' });
    const reply = decodeWorkerResponse(output.result); check(reply.ok && reply.requestId === record.nativeRequestId, 'Native start acknowledgement unavailable or uncorrelated');
    const native = validateContract('NativeIdentity', reply.result);
    check(canonical(native) === canonical(binding.native), 'Continuation native identity mismatch');
    this.journal.update(record.start.attemptId, v => {
      check((v.bindingGeneration ?? 0) === (record.bindingGeneration ?? 0), 'Continuation binding changed; reconcile');
      check(!v.resume || v.resume.phase === 'pending', 'Issued result resume prevents continuation rebinding');
      delete v.resume; v.binding = structuredClone(binding); v.bindingGeneration = (v.bindingGeneration ?? 0) + 1;
      v.continuationKeys ??= {}; v.continuationKeys[key] = fingerprint(binding);
    });
  }
  private effectiveStart(record: ExecutionIntent): WorkflowStart {
    return record.binding ? { ...record.start, attemptId: record.binding.attemptId, fence: record.binding.fence } : record.start;
  }
  async resumeInput(identity: WorkflowIdentity, input: TaskResult, key: string): Promise<void> {
    validateContract('TaskResult', input); check(key.length > 0, 'Resume key required');
    const record = this.journal.identity(identity); check(input.attemptId === this.effectiveStart(record).attemptId, 'Resume attempt mismatch');
    this.journal.update(record.start.attemptId, v => {
      check((v.bindingGeneration ?? 0) === (record.bindingGeneration ?? 0), 'Continuation binding changed; reconcile');
      if (v.resume) check(v.resume.key === key && v.resume.hash === fingerprint(input), 'Resume key/input conflict');
      else v.resume = { key, hash: fingerprint(input), input: structuredClone(input), phase: 'pending' };
    });
    await this.reconcileResume(this.journal.identity(identity), await this.get(record));
  }
  private async reconcileResume(record: ExecutionIntent, e: EngineExecution): Promise<void> {
    const resume = record.resume; if (!resume || resume.phase === 'done') return;
    const task = e.taskRunList?.find(t => t.taskId === 'await_result');
    if (resume.phase === 'sent') {
      check(task && task.id === resume.taskRunId, 'Resume taskrun identity mismatch');
      if (task.state.current === 'PAUSED') return; // Unknown reply is never resent while commands may still be queued.
      const output = await checked(this.request, { method: 'POST', path: `/executions/${e.id}/actions/eval`, body: '{{ outputs.await_result.onResume.sf_result }}' });
      check(output?.result === resume.wire, 'Resume output mismatch or still unknown');
      this.journal.update(record.start.attemptId, v => { v.resume!.phase = 'done'; }); return;
    }
    if (e.state.current !== 'PAUSED' || task?.state.current !== 'PAUSED') return;
    const authorized = await this.authority.result(record.identity!, resume.input, resume.key);
    const wire = authorizedWire(authorized, this.effectiveStart(record), 'result.submit');
    check(authorized.request.operation === 'result.submit' && canonical(authorized.request.payload) === canonical(resume.input), 'Result authority input mismatch');
    let claimed = false;
    this.journal.update(record.start.attemptId, v => { check((v.bindingGeneration ?? 0) === (record.bindingGeneration ?? 0) && v.resume?.key === resume.key && v.resume.hash === resume.hash, 'Continuation binding changed before result send'); if (v.resume.phase === 'pending') { Object.assign(v.resume!, { phase: 'sent', taskRunId: task.id, wire, requestId: authorized.request.requestId }); claimed = true; } });
    if (!claimed) return;
    try { await checked(this.request, { method: 'POST', path: `/executions/${e.id}/actions/resume`, body: { sf_result: wire, sf_result_capability: authorized.capability } }); }
    catch { /* pending/unknown survives restart; fixed output reconciliation below */ }
    await this.reconcileResume(this.journal.identity(record.identity!), await this.get(record));
  }
  async snapshot(identity: WorkflowIdentity): Promise<WorkflowSnapshot> {
    let record = this.journal.identity(identity);
    try {
      let e = await this.get(record); await this.reconcileResume(record, e); record = this.journal.identity(identity); e = await this.get(record);
      const states: Record<string, WorkflowSnapshot['state']> = { CREATED: 'pending', QUEUED: 'pending', RUNNING: 'running', RESTARTED: 'running', PAUSED: 'paused', FAILED: 'failed', KILLED: 'cancelled', CANCELLED: 'cancelled' };
      if (e.state.current !== 'SUCCESS') return { identity, state: states[e.state.current] ?? 'unknown', inputs: [] };
      check(record.resume?.phase === 'done', 'Engine success lacks a correlated structured result');
      const value = await checked(this.request, { method: 'POST', path: `/executions/${e.id}/actions/eval`, body: '{{ outputs.submit_result.body }}' });
      const reply = decodeWorkerResponse(value.result); check(reply.ok && reply.requestId === record.resume.requestId, 'Broker result rejected or uncorrelated');
      const result = validateContract('TaskResult', reply.result); check(result.attemptId === this.effectiveStart(record).attemptId && canonical(result) === canonical(record.resume.input), 'Broker result attempt/content mismatch');
      return { identity, state: 'completed', inputs: [], result };
    } catch { return { identity, state: 'unknown', inputs: [], reason: 'Engine/result observation uncertain; reconcile the durable intent' }; }
  }
  /** Read-only proof for ordinary native waits; never kills the retained workflow. */
  async quiescence(identity: WorkflowIdentity): Promise<'waiting' | 'stopped' | 'unknown'> {
    try {
      const record = this.journal.identity(identity); const execution = await this.get(record);
      if (['SUCCESS', 'FAILED', 'KILLED', 'CANCELLED'].includes(execution.state.current)) return 'stopped';
      const runs = execution.taskRunList ?? [];
      if (record.resume?.phase === 'sent' || execution.state.current !== 'PAUSED'
        || !runs.some(run => run.taskId === 'await_result' && run.state.current === 'PAUSED')
        || !runs.some(run => run.taskId === 'native_start' && run.state.current === 'SUCCESS')
        || runs.some(run => run.taskId !== 'await_result' && !['SUCCESS', 'SKIPPED'].includes(run.state.current))) return 'unknown';
      return 'waiting';
    } catch { return 'unknown'; }
  }
  async stop(identity: WorkflowIdentity): Promise<void> {
    const record = this.journal.identity(identity); const e = await this.get(record);
    if (['SUCCESS', 'FAILED', 'KILLED', 'CANCELLED'].includes(e.state.current)) return;
    this.journal.update(record.start.attemptId, v => { v.stopRequested = true; });
    await checked(this.request, { method: 'DELETE', path: `/executions/${identity.executionId}/actions/kill` });
  }
}
