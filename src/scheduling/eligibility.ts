import type { Clock, Grant, RecipeRevision, Repository, TaskRecord, TaskSpec } from '../contracts/domain.ts';
import { canonical } from '../storage/database.ts';
import type { AdmissionState } from './admission-types.ts';

export function hasCapabilityGrants(task: TaskSpec, grants: readonly Grant[], clock: Clock): boolean {
  const valid = grants.filter(grant => grant.recipeId === task.recipeId && grant.recipeRevision === task.recipeRevision
    && grant.repositoryIds.includes(task.repositoryId) && !grant.revokedAt
    && (!grant.expiresAt || Date.parse(grant.expiresAt) > clock.wallNow().getTime()));
  const covers = <T>(items: T[], pick: (grant: Grant) => T[]) => items.every(item => valid.some(grant => pick(grant).some(value => canonical(value) === canonical(item))));
  const required = task.required;
  // A revision/repository-specific authorization is mandatory even if its declared lists are empty.
  return valid.length > 0 && covers(required.paths, g => g.required.paths) && covers(required.tools, g => g.required.tools)
    && covers(required.networkDestinations, g => g.required.networkDestinations) && covers(required.credentialRefs, g => g.required.credentialRefs)
    && covers(required.allowedFinishPolicies, g => g.required.allowedFinishPolicies);
}
export function repositoryEligible(repository: Repository, manual: boolean, state: AdmissionState): boolean {
  return repository.controlMode === 'factory' && (manual || repository.active)
    && !state.activeLeases.some(lease => lease.repositoryId === repository.id);
}
export function taskEligible(task: TaskRecord, state: AdmissionState): boolean {
  const repository = state.repositories.find(repo => repo.id === task.spec.repositoryId);
  return task.status === 'queued' && task.controlMode === 'factory' && !task.archivedAt && !!repository
    && repositoryEligible(repository, task.spec.source === 'manual', state)
    && state.tags.some(tag => tag.id === task.spec.tagId && !tag.archivedAt)
    && state.recipes.some(recipe => recipe.id === task.spec.recipeId && recipe.active)
    && state.recipeReadiness.some(readiness => readiness.recipeId === task.spec.recipeId && readiness.recipeRevision === task.spec.recipeRevision && readiness.ready);
}
export function compatibleTask(task: TaskSpec, recipe: RecipeRevision): boolean {
  const metadata = recipe.contract.variables.sf;
  return recipe.repositoryIds.includes(task.repositoryId) && metadata.compatibleOwners.includes(task.ownerId)
    && metadata.compatibleProviders.includes(task.providerId) && metadata.required.allowedFinishPolicies.includes(task.finishPolicy);
}
