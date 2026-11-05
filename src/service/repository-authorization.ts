import { createHash } from 'node:crypto';
import type { Clock, TaskSpec } from '../contracts/domain.ts';
import type { GitHubOperation, RepositoryAccess } from '../github/capabilities.ts';
import { hasCapabilityGrants } from '../scheduling/eligibility.ts';
import type { FactoryStore } from '../storage/store.ts';

/** Runtime's current repository, recipe, grant, lease and finish-policy checks for C6. */
export function createRepositoryOperationAuthorizer(store: FactoryStore, repositories: readonly RepositoryAccess[], preparingTasks: Map<string, TaskSpec>, clock: Clock) {
  return async (repositoryId: string, operation: GitHubOperation, key?: string): Promise<boolean> => {
    if (!repositories.some(r => r.id === repositoryId && r.operations.includes(operation))) return false;
    const state = store.getAdmissionState();
    const candidates = [...preparingTasks.values(), ...state.tasks.map(t => t.spec)].filter(t => t.repositoryId === repositoryId);
    const target = key?.startsWith('workspace-') ? candidates.find(t => key.endsWith(':' + createHash('sha256').update(t.id).digest('hex'))) : undefined;
    const current = (task: TaskSpec) => !state.settings.paused && state.repositories.some(r => r.id === repositoryId && r.controlMode === 'factory' && (task.source === 'manual' || r.active))
      && state.recipes.some(r => r.id === task.recipeId && r.active) && state.recipeReadiness.some(r => r.recipeId === task.recipeId && r.recipeRevision === task.recipeRevision && r.ready)
      && hasCapabilityGrants(task, state.grants, clock);
    if (operation === 'read' && target) return current(target);
    const task = state.tasks.find(t => t.spec.repositoryId === repositoryId && t.attemptIds.some(id => { const r = store.getLifecycle(id); return r.reservation.lease.active || r.state.closeout?.phase === 'monitoring'; }));
    if (operation === 'read') return !!task && (current(task.spec) || task.attemptIds.some(id => !!store.getActionByKey('closeout:' + id + ':metadata')));
    if (!task || !current(task.spec)) return false;
    return operation === 'contents_write' ? task.spec.finishPolicy !== 'result' : operation === 'pull_requests_write' ? task.spec.finishPolicy !== 'result' : task.spec.finishPolicy === 'merge_ci' || task.spec.finishPolicy === 'merge_bypass';
  };
}
