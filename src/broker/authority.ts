import { createHash } from 'node:crypto';
import type { WorkflowIdentity } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import type { KestraAuthority } from '../kestra/pause.ts';
import type { FactoryStore } from '../storage/store.ts';
import { canonical, ensure } from '../storage/database.ts';
import type { AttemptBroker } from './operations.ts';
/** Trusted E2/E6 adapter only. WorkflowStart.scopeId is the actual reservation ID. */
export function createKestraAuthority({ broker, store }: { broker: AttemptBroker; store: FactoryStore }): KestraAuthority {
  const requestId = (operation: string, key: string) => createHash('sha256').update(operation+'\0'+key).digest('hex');
  function currentWorkflow(identity: WorkflowIdentity) {
    validateContract('WorkflowIdentity', identity);
    const rows = store.getReservations().filter(r => r.lease.active && canonical(r.attempt.workflow) === canonical(identity));
    ensure(rows.length === 1, 'workflow_scope', 'Workflow must resolve to one current reservation');
    return broker.current(rows[0]!.attempt.id);
  }
  return {
    async start(input) {
      validateContract('WorkflowStart', input); const r = broker.current(input.attemptId);
      const recipe = store.getRecipeRevision(r.task.spec.recipeId, r.task.spec.recipeRevision);
      ensure(input.scopeId === r.id && input.fence === r.lease.fence && canonical(recipe) === canonical(input.recipe)
        && !Object.keys(input.inputs).some(k=>k.startsWith('sf_')), 'engine_authority', 'Workflow start must use the pinned reservation and recipe');
      const capability = broker.issueAttemptCapability(r.attempt.id, broker.currentGrantIds(r.attempt.id), ['native.start']);
      const scope = broker.authorizeAttempt(capability,'native.start',{});
      return { capability, request: { requestId: requestId('native.start',input.idempotencyKey), idempotencyKey: input.idempotencyKey, scope,
        operation:'native.start', payload: broker.nativeStart(r.attempt.id,input.idempotencyKey) } };
    },
    async result(identity,input,key) {
      validateContract('TaskResult',input); const r = currentWorkflow(identity);
      ensure(key.trim() && input.attemptId === r.attempt.id, 'result_scope','Final result requires current workflow attempt');
      const proposal = broker.getResultProposal(r.attempt.id);
      ensure(!proposal || canonical(proposal) === canonical(input), 'result_conflict', 'Final result differs from recorded proposal');
      const capability = broker.issueAttemptCapability(r.attempt.id,broker.currentGrantIds(r.attempt.id),['result.submit']);
      const scope = broker.authorizeAttempt(capability,'result.submit',{});
      for(const id of input.createdTaskIds) ensure(id !== r.task.spec.id && store.getTask(id,scope), 'result_scope','Final result IDs must be real scoped children');
      return { capability, request: { requestId:requestId('result.submit',key),idempotencyKey:key,scope,operation:'result.submit',payload:structuredClone(input) } };
    },
    async continuation(identity,key) {
      ensure(key.trim(), 'invalid_key','Continuation key required'); const r = currentWorkflow(identity);
      ensure(r.attempt.native, 'native_authority','Continuation requires actual native identity');
      const previousAttemptId = r.attempt.retryOfAttemptId ?? r.attempt.id;
      const previous = store.getLifecycle(previousAttemptId).reservation;
      ensure(previous.task.spec.id === r.task.spec.id && previous.task.spec.recipeId === r.task.spec.recipeId
        && previous.attempt.recipeRevision === r.attempt.recipeRevision && canonical(previous.attempt.workflow) === canonical(identity)
        && canonical(previous.attempt.native) === canonical(r.attempt.native) && previous.attempt.workspacePath === r.attempt.workspacePath,
        'continuation_scope','Continuation must preserve task, recipe, workflow, native identity and workspace');
      return { attemptId:r.attempt.id,previousAttemptId,fence:r.lease.fence,taskId:r.task.spec.id,recipeId:r.task.spec.recipeId,recipeRevision:r.task.spec.recipeRevision,native:r.attempt.native };
    },
  };
}
