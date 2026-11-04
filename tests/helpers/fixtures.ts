import type { ActorScope, Grant, RecipeRevision, TaskSpec } from '../../src/contracts/domain.ts';
import type { MaterializationContext } from '../../src/storage/store.ts';

export function recipeFixture(tagId: string, revision = 'rev-1'): RecipeRevision {
  return {
    id: `recipe-1:${revision}`, recipeId: 'recipe-1', revision, hash: `sha256:${revision}`,
    name: 'Quality', description: 'Improve code', tagId, createdAt: '2026-11-04T10:00:00.000Z',
    yaml: 'id: quality\nnamespace: sf\ntasks: []', inputDefaults: {}, repositoryIds: ['repo-1', 'repo-2'],
    outputSchema: {}, skillVersions: {}, toolVersions: {}, contract: {
      id: 'quality', namespace: 'sf', tasks: [{ id: 'worker', type: 'controlled' }], variables: { sf: {
        schemaVersion: 1, recipeId: 'recipe-1', displayName: 'Quality', tagId, inputSchema: {},
        taskTemplate: { title: 'Quality', description: 'Improve code', goal: 'Improve code quality', acceptanceCriteria: ['Checks pass'], skills: [], tools: [], context: {} },
        required: { paths: [], tools: [], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result', 'pr'] },
        compatibleOwners: ['vscode'], compatibleProviders: ['copilot'], defaultFinishPolicy: 'result',
      } },
    },
  };
}
export function materializeFixture(context: MaterializationContext): TaskSpec {
  return { ...context.recipe.contract.variables.sf.taskTemplate,
    id: context.id, ...(context.parentId ? { parentId: context.parentId } : {}),
    repositoryId: context.repository.id, recipeId: context.recipe.recipeId, recipeRevision: context.recipe.revision,
    tagId: context.recipe.tagId, source: context.source, title: context.request.title, description: context.request.description,
    ...context.defaults, required: context.recipe.contract.variables.sf.required,
  };
}
export function scopeFixture(): ActorScope {
  return { attemptId: 'attempt-1', repositoryIds: ['repo-1', 'repo-2'], recipeId: 'recipe-1', recipeRevision: 'rev-1', grantIds: ['grant-1'], expiresAt: '2026-11-05T10:00:00.000Z', fence: 1 };
}
export function grantFixture(recipe: RecipeRevision): Grant {
  return { id: 'grant-1', recipeId: recipe.recipeId, recipeRevision: recipe.revision, repositoryIds: ['repo-1', 'repo-2'], required: recipe.contract.variables.sf.required, grantedAt: '2026-11-04T10:00:00.000Z' };
}
