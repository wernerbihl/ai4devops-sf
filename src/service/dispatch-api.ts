import type { FactoryStore } from '../storage/store.ts';
import type { Scheduler, DispatchResult } from '../scheduling/admission.ts';
import type { PendingRequest, Reconciliation } from './api.ts';
import { ensure } from '../storage/database.ts';

/** Public dispatch keys bind to an original reservation/continuation, never a latest attempt. */
export function createDispatchApi(store: FactoryStore, scheduler: Scheduler) {
  function read(key: string): DispatchResult | undefined {
    if (!store.getActionByKey('dispatch:request:' + key)) return;
    const outcome = store.getActionByKey('dispatch:outcome:' + key);
    if (outcome) return outcome.payload.result as DispatchResult;
    const binding = store.getActionByKey('dispatch:reservation:' + key);
    if (binding) {
      const reservation = store.getReservations().find(r => r.id === binding.payload.reservationId
        && r.attempt.id === binding.payload.attemptId && r.task.spec.id === binding.payload.taskId);
      if (reservation && (reservation.status === 'confirmed' || reservation.status === 'released') && reservation.attempt.workflow) {
        return { kind: 'started', attemptId: reservation.attempt.id };
      }
      return;
    }
    for (let index = 0; ; index++) {
      const selected = store.getActionByKey(`dispatch:continuation:${key}:${index}`);
      if (!selected) break;
      const action = store.getAction(String(selected.payload.actionId));
      const bound = action && store.getLifecycleActionBinding(action.id);
      if (action?.completedAt && bound) return { kind: 'started', attemptId: bound.attemptId };
    }
  }
  const apiScheduler: Scheduler = {
    async dispatch(trigger, key) {
      if (!key) return scheduler.dispatch(trigger);
      if (store.getActionByKey('dispatch:request:' + key)) {
        const result = read(key);
        ensure(result, 'request_pending', 'Original dispatch is unresolved; never redispatch it');
        return result;
      }
      store.enqueueAction({ key: 'dispatch:request:' + key, kind: 'dispatch.request', payload: { method: 'POST', path: '/v1/dispatch' } });
      const result = await scheduler.dispatch(trigger, key);
      ensure(result.kind !== 'noop' || !result.reservationId, 'request_pending', 'Original external dispatch is unresolved');
      const receipt = store.enqueueAction({ key: 'dispatch:outcome:' + key, kind: 'dispatch.outcome', payload: { result } });
      store.completeAction(receipt.id);
      return result;
    },
  };
  return {
    scheduler: apiScheduler,
    async reconcile(request: PendingRequest): Promise<Reconciliation> {
      if (request.method !== 'POST' || request.path !== '/v1/dispatch') return { state: 'pending' };
      const result = read(request.key);
      if (!result) return { state: 'pending' };
      if (result.kind === 'noop') return { state: 'complete', body: { admitted: false, reason: result.code } };
      const attempt = store.snapshot().attempts.find(a => a.id === result.attemptId);
      if (!attempt) return { state: 'pending' };
      return { state: 'complete', body: { admitted: true, attemptId: attempt.id, taskId: attempt.taskId } };
    },
  };
}
