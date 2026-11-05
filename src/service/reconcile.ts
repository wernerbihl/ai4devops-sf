import type { FactoryStore } from '../storage/store.ts';
import type { KestraClient } from '../kestra/client.ts';
import type { Lifecycle } from '../scheduling/lifecycle.ts';
import type { Closeout } from '../github/closeout.ts';
import type { AttemptBroker } from '../broker/operations.ts';
import type { Reservation } from '../scheduling/admission-types.ts';
import type { WorkflowStart } from '../contracts/domain.ts';
import { canonical } from '../storage/database.ts';
export interface ReconcileReport { confirmed: string[]; completed: string[]; retained: string[]; }
export interface ReconcileRuntime {
  store: FactoryStore; engine?: KestraClient; lifecycle: Lifecycle; closeout: Closeout; broker: AttemptBroker;
  workflowStart(reservation: Reservation): WorkflowStart;
  /** Trusted read-only native journal/snapshot recovery, including after grant revocation. */
  recoverNativeWrites?(): Promise<void>;
}
/** Original immutable keys/identities only. An unknown observation never releases a writer or creates replacement history. */
export async function reconcileInstallation(runtime: ReconcileRuntime): Promise<ReconcileReport> {
  const report: ReconcileReport = { confirmed: [], completed: [], retained: [] };
  const {store,engine,lifecycle,broker,closeout}=runtime;
  await runtime.recoverNativeWrites?.();
  if (!engine) return {...report,retained:store.getReservations().filter(r=>r.lease.active).map(r=>r.attempt.id)};
  for(const reservation of store.getReservations()) {
    const task=store.getTask(reservation.attempt.taskId)!;
    if (reservation.status==='released'||task.attemptIds.at(-1)!==reservation.attempt.id) continue;
    if (reservation.status==='pending'&&!reservation.attempt.retryOfAttemptId) {
      const intent=store.getActionByKey(`runtime:start:${reservation.id}`);
      if (!intent) {report.retained.push(reservation.attempt.id);continue;}
      try {
        // E2 has its own durable prepared/sent journal. Sent effects reconcile by exact lookup, never POST twice.
        const workflow=reservation.externalIdentity?.workflow??await engine.ensureExecution(runtime.workflowStart(reservation));
        store.confirmStart(reservation.id,{workflow,...(reservation.externalIdentity?.native?{native:reservation.externalIdentity.native}:{})});
        store.completeAction(intent.id);report.confirmed.push(reservation.attempt.id);
      } catch {report.retained.push(reservation.attempt.id);continue;}
    }
    const current=store.getLifecycle(reservation.attempt.id).reservation;
    if (task.status==='completed'&&task.closeout?.kind==='completed') {
      const action=store.getActionByKey(`runtime:closeout:${current.attempt.id}`);if(action&&!action.completedAt)store.completeAction(action.id);
      continue;
    }
    if (!current.attempt.workflow||['failed','cancelled'].includes(task.status)) continue;
    try {
      const proposal=broker.getResultProposal(current.attempt.id);
      let snapshot=await engine.snapshot(current.attempt.workflow);
      if(proposal&&snapshot.state==='paused') {
        await engine.resumeInput(current.attempt.workflow,proposal,`runtime:result:${current.attempt.id}`);
        snapshot=await engine.snapshot(current.attempt.workflow);
      }
      if(snapshot.state==='completed'&&snapshot.result) {
        if(proposal&&canonical(proposal)!==canonical(snapshot.result)) throw new Error('Engine result differs from native proposal');
        const action=store.enqueueAction({key:`runtime:closeout:${current.attempt.id}`,kind:'runtime.closeout',payload:{result:snapshot.result}});
        const outcome=await closeout.finishTask(store.getTask(task.spec.id)!.spec,snapshot.result);
        if(outcome.kind==='completed') {store.completeAction(action.id);report.completed.push(current.attempt.id);}
        else report.retained.push(current.attempt.id);
      } else if(snapshot.state==='unknown') report.retained.push(current.attempt.id);
    } catch {report.retained.push(current.attempt.id);}
  }
  // C4 recovers persisted pauses/continuations after exact original snapshot checks.
  try {await lifecycle.reconnect()} catch { /* Each unresolved lease remains authoritative. */ }
  return report;
}
