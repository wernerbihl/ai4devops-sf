import { fingerprint } from '../storage/database.ts';
import type { CreateTaskRequest, ExecutionDefaults, RecipeRevision, RecipeMetadata, TaskTemplate, TaskSpec } from '../contracts/domain.ts';
import type { RecipeMaterializer } from '../storage/tasks.ts';
import { validateContract } from '../contracts/schemas.ts';
import { inputValues } from './validate.ts';
import { renderTemplate, requirePolicy, RecipePolicyError } from './policy.ts';

function renderTaskTemplate(metadata: RecipeMetadata, defaults: Record<string, unknown>, title: string, description: string, supplied?: Record<string, unknown>): TaskTemplate {
  const inputs = inputValues(metadata.inputSchema, defaults, supplied);
  const template = renderTemplate(metadata.taskTemplate, inputs, title, description);
  try { return validateContract('TaskTemplate', template); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const field = error.message.match(/TaskTemplate(\/[^ ]*)/)?.[1] ?? '';
    throw new RecipePolicyError(`/variables/sf/taskTemplate${field}`, error.message);
  }
}
/** Default recipes must already produce a complete task, without user input or a model inventing values. */
export function validateDefaultMaterialization(metadata: RecipeMetadata, defaults: Record<string, unknown>): void {
  const title = 'Recipe validation title'; const description = 'Recipe validation description';
  const template = renderTaskTemplate(metadata, defaults, title, description);
  validateContract('TaskSpec', { ...template, id: 'recipe-validation', repositoryId: 'recipe-validation',
    recipeId: metadata.recipeId, recipeRevision: 'recipe-validation', tagId: metadata.tagId, source: 'automatic', title, description,
    ownerId: metadata.compatibleOwners[0], providerId: metadata.defaultProviderId ?? metadata.compatibleProviders[0],
    finishPolicy: metadata.defaultFinishPolicy, required: metadata.required,
  });
}

/** Pure template expansion; never discovers work, calls a model or imposes a context budget. */
export function materializeTask(request: CreateTaskRequest, revision: RecipeRevision, repositoryId: string, defaults: ExecutionDefaults): TaskSpec {
  validateContract('CreateTaskRequest', request); validateContract('RecipeRevision', revision); validateContract('ExecutionDefaults', defaults);
  const metadata = revision.contract.variables.sf;
  requirePolicy(request.recipeId === revision.recipeId && request.repositoryIds.includes(repositoryId) && revision.repositoryIds.includes(repositoryId), '/repositoryIds', 'Task must target an assigned recipe repository');
  const ownerId = request.ownerId ?? defaults.ownerId;
  const providerId = request.providerId ?? metadata.defaultProviderId ?? defaults.providerId;
  const finishPolicy = request.finishPolicy ?? metadata.defaultFinishPolicy;
  requirePolicy(metadata.compatibleOwners.includes(ownerId) && metadata.compatibleProviders.includes(providerId), '/ownerId', 'Owner and provider must be compatible with this recipe');
  requirePolicy(metadata.required.allowedFinishPolicies.includes(finishPolicy), '/finishPolicy', 'Finish policy is outside recipe authority');
  const template = renderTaskTemplate(metadata, revision.inputDefaults, request.title, request.description, request.inputs);
  return validateContract('TaskSpec', { ...template, id: `materialized-${fingerprint({ request, recipeId: revision.recipeId, revision: revision.revision, repositoryId, ownerId, providerId, finishPolicy })}`, repositoryId, recipeId: revision.recipeId, recipeRevision: revision.revision,
    tagId: revision.tagId, source: 'manual', title: request.title, description: request.description, ownerId, providerId, finishPolicy, required: structuredClone(metadata.required) });
}
export const recipeMaterializer: RecipeMaterializer = context => ({
  ...materializeTask(context.request, context.recipe, context.repository.id, context.defaults), id: context.id, source: context.source,
  ...(context.parentId ? { parentId: context.parentId } : {}),
});
