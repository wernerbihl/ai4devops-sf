import type { TaskResult, WorkerRequest, WorkflowIdentity, WorkflowStart } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { encodeWorkerRequest } from '../contracts/worker-transport.ts';
import type { ContinuationBinding } from './executions.ts';
import { check } from './executions.ts';
export interface AuthorizedRequest { request: WorkerRequest; capability: string; }
/** E3/E6 reconstruct these from live scope/grant/fence state; never from browser-reserved inputs. */
export interface KestraAuthority {
  /** Must read authoritative lifecycle/native records and validate the retry chain. No worker/browser supplied binding. */
  continuation?(identity: WorkflowIdentity, key: string): Promise<ContinuationBinding>;
  start(start: WorkflowStart): Promise<AuthorizedRequest>;
  result(identity: WorkflowIdentity, input: TaskResult, key: string): Promise<AuthorizedRequest>;
}
export function authorizedWire(value: AuthorizedRequest, start: WorkflowStart, operation: 'native.start' | 'result.submit'): string {
  validateContract('WorkerRequest', value.request);
  check(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value.capability), 'Unsafe authority capability');
  const r = value.request;
  check(r.operation === operation && r.scope.attemptId === start.attemptId && r.scope.recipeId === start.recipe.recipeId && r.scope.recipeRevision === start.recipe.revision && r.scope.grantIds.length > 0 && r.scope.repositoryIds.length > 0 && r.scope.repositoryIds.every(id => start.recipe.repositoryIds.includes(id)), 'Worker authority scope mismatch');
  if (r.operation === 'native.start') check(r.scope.fence === start.fence && r.payload.fence === start.fence && r.payload.attemptId === start.attemptId && r.payload.task.recipeId === start.recipe.recipeId && r.payload.task.recipeRevision === start.recipe.revision && r.scope.repositoryIds.includes(r.payload.task.repositoryId) && start.recipe.contract.variables.sf.compatibleOwners.includes(r.payload.task.ownerId) && start.recipe.contract.variables.sf.compatibleProviders.includes(r.payload.task.providerId), 'Native authority mismatch');
  // A current trusted fence may advance after takeover; never permit an older one.
  if (r.operation === 'result.submit') check(r.scope.fence >= start.fence && r.payload.attemptId === start.attemptId, 'Result authority mismatch');
  return encodeWorkerRequest(r);
}
