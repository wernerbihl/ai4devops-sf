import type { RecipeCreate, RecipePatch, RecipeValidationInput, RecipeValidationBinding } from '../../src/contracts/domain.ts';
import type { RecipeRegistry } from '../../src/recipes/registry.ts';

export const fixtureExecutionProfile = () => ({ available: true, kind: 'owned-test-fixture', isolatedProfileId: 'test-v2' });
export function recipeBinding(registry: RecipeRegistry, input: RecipeValidationInput): RecipeValidationBinding {
  const result = registry.validate({ yaml: input.yaml, ...(input.inputDefaults === undefined ? {} : { inputDefaults: input.inputDefaults }), ...(input.repositoryIds === undefined ? {} : { repositoryIds: input.repositoryIds }) });
  return { recipeHash: result.hash ?? 'invalid', payloadHash: result.payloadHash ?? 'invalid', executionProfileHash: result.executionProfileHash ?? 'invalid' };
}
export function boundRecipe(registry: RecipeRegistry, input: RecipeValidationInput): RecipeCreate {
  return { ...input, validation: recipeBinding(registry, input) };
}
export function boundPatch(registry: RecipeRegistry, id: string, input: RecipePatch): RecipePatch {
  return { ...input, validation: recipeBinding(registry, registry.store.getRecipe(id)!) };
}
