import { randomUUID } from 'node:crypto';
import type { Grant, RecipeCreate, RecipeMetadata, RecipePatch, RecipeRevision, RecipeSummary, RecipeValidation, RecipeValidationInput, RecipeValidationBinding } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { canonical, fingerprint, StoreError } from '../storage/database.ts';
import type { FactoryStore } from '../storage/store.ts';
import { DefinitiveNoEffect } from '../service/api.ts';
import type { ApiFailureStatus, PendingRequest, RecipePort, Reconciliation, RequestContext } from '../service/api.ts';
import { RecipeValidationError, validateRecipe } from './validate.ts';
import type { ValidatedRecipe } from './validate.ts';
import { validateDefaultMaterialization } from './materialize.ts';
import { RecipePolicyError, requirePolicy, isBrokerFlow } from './policy.ts';

export interface RecipeExecutionProfile extends Record<string, unknown> { available: boolean }
export interface RecipeResolvers {
  resolveReference?(kind: 'skill' | 'tool', id: string, version: string): boolean;
  /** Pure, synchronous evidence lookup. E3/E4 supplies verified owner/provider/profile evidence, not metadata claims. */
  executionReadiness?(metadata: RecipeMetadata, scope: Pick<RecipeRevision, 'repositoryIds' | 'inputDefaults'>): string[];
  /** Pure synchronous descriptor of the captured trusted provisioning policy and current availability.
   * No per-attempt isolation claim, credential values, browser state or volatile timestamps. */
  executionProfile?(): RecipeExecutionProfile | undefined;
  now?(): Date;
}
type Outcome = { method: string; path: string; result: Reconciliation };
export function recipePayloadHash(input: Pick<RecipeCreate, 'yaml' | 'inputDefaults' | 'repositoryIds'>): string {
  return `sha256:${fingerprint({ yaml: input.yaml, inputDefaults: input.inputDefaults ?? {}, repositoryIds: input.repositoryIds ?? [] })}`;
}
function approvalCovers(grant: Grant, recipe: RecipeRevision, now: Date, executionProfileHash: string): boolean {
  return grant.executionProfileHash === executionProfileHash && grant.recipeId === recipe.recipeId && grant.recipeRevision === recipe.revision && !grant.revokedAt &&
    (!grant.expiresAt || Date.parse(grant.expiresAt) > now.getTime()) && recipe.repositoryIds.every(id => grant.repositoryIds.includes(id)) &&
    Object.entries(recipe.contract.variables.sf.required).every(([field, items]) => (items as unknown[]).every(item =>
      (grant.required[field as keyof Grant['required']] as unknown[]).some(allowed => canonical(allowed) === canonical(item))));
}
/** Registry owns validation/explicit approval only. E2 imports its exact validated revisions into Kestra. */
export class RecipeRegistry {
  readonly store: FactoryStore;
  private resolvers: RecipeResolvers;
  constructor(store: FactoryStore, resolvers: RecipeResolvers = {}) { this.store = store; this.resolvers = resolvers; }
  private now(): Date { return this.resolvers.now?.() ?? new Date(); }
  private summary(id: string): RecipeSummary {
    const summary = this.store.snapshot().recipes.find(recipe => recipe.id === id);
    requirePolicy(summary, '/recipeId', 'Recipe not found'); return summary;
  }
  private profileHash(): string {
    return `sha256:${fingerprint(this.resolvers.executionProfile?.() ?? { configured: false })}`;
  }
  private requireBinding(binding: RecipeValidationBinding | undefined, recipeHash: string, payloadHash: string): void {
    requirePolicy(binding && binding.recipeHash === recipeHash && binding.payloadHash === payloadHash && binding.executionProfileHash === this.profileHash(),
      '/validation', 'Validation must match the exact recipe content, effective payload and current execution profile');
  }
  private references(input: ValidatedRecipe, scope: Pick<RecipeRevision, 'repositoryIds' | 'inputDefaults'>): string[] {
    const reasons: string[] = [];
    if (!isBrokerFlow(input.contract)) reasons.push('Probe-only Pause/Return flow cannot orchestrate a native result');
    for (const [kind, versions] of [['skill', input.skillVersions], ['tool', input.toolVersions]] as const) {
      for (const [id, version] of Object.entries(versions)) if (!this.resolvers.resolveReference?.(kind, id, version)) reasons.push(`Missing ${kind} reference ${id}@${version}`);
    }
    const profile = this.resolvers.executionProfile?.();
    if (!profile) reasons.push('Trusted execution profile descriptor is unavailable');
    else if (!profile.available) reasons.push('Current execution profile is not provisionable');
    reasons.push(...(this.resolvers.executionReadiness?.(input.contract.variables.sf, scope) ?? ['Verified owner/provider/isolation readiness is unavailable']));
    return reasons;
  }
  readiness(recipe: RecipeRevision): NonNullable<RecipeValidation['readiness']> {
    const validated = validateRecipe(recipe.yaml, []);
    requirePolicy(validated.hash === recipe.hash && canonical(validated.contract) === canonical(recipe.contract), '/hash', 'Stored recipe does not match validated content');
    const grants = this.store.getAdmissionState().grants;
    const approved = recipe.repositoryIds.length > 0 && grants.some(grant => approvalCovers(grant, recipe, this.now(), this.profileHash()));
    const reasons = this.references(validated, recipe);
    try { validateDefaultMaterialization(validated.contract.variables.sf, recipe.inputDefaults); }
    catch (error) {
      if (!(error instanceof RecipePolicyError || error instanceof TypeError)) throw error;
      reasons.push(`Default task cannot be materialized: ${error.message}`);
    }
    if (!recipe.repositoryIds.length) reasons.push('Assign at least one repository');
    if (!approved) reasons.push('Explicit capability approval is required for this exact revision and repository scope');
    return { ready: reasons.length === 0, reasons, requested: recipe.contract.variables.sf.required, approved };
  }
  validate(input: RecipeValidationInput): RecipeValidation {
    try {
      validateContract('RecipeValidationInput', input);
      const validated = validateRecipe(input.yaml, []);
      const current = this.store.getRecipe(validated.contract.variables.sf.recipeId);
      const effective = { yaml: input.yaml, inputDefaults: input.inputDefaults ?? current?.inputDefaults ?? {}, repositoryIds: input.repositoryIds ?? current?.repositoryIds ?? [] };
      validateDefaultMaterialization(validated.contract.variables.sf, effective.inputDefaults);
      const same = current && current.hash === validated.hash && recipePayloadHash(current) === recipePayloadHash(effective);
      const readiness = same ? this.readiness(current) : {
        ready: false, reasons: [...this.references(validated, effective), 'Explicit capability approval is required for this exact revision and repository scope'], requested: validated.contract.variables.sf.required, approved: false,
      };
      return validateContract('RecipeValidation', { valid: true, errors: [], issues: [], hash: validated.hash, payloadHash: recipePayloadHash(effective), executionProfileHash: this.profileHash(), contract: validated.contract, readiness });
    } catch (error) {
      if (!(error instanceof RecipeValidationError || error instanceof RecipePolicyError || error instanceof TypeError)) throw error;
      const issues = error instanceof RecipeValidationError ? error.issues : [{ field: error instanceof RecipePolicyError ? error.field : '', line: 1, column: 1, message: error.message }];
      return { valid: false, errors: issues.map(issue => issue.message), issues };
    }
  }
  /** Revalidates and saves atomically; no caller-provided IDs or grants are trusted. */
  saveRecipeRevision(input: ValidatedRecipe, options: { repositoryIds: string[]; inputDefaults: Record<string, unknown>; expectedRevision?: number }): RecipeRevision {
    const validated = validateRecipe(input.yaml, []);
    requirePolicy(validated.hash === input.hash && canonical(validated.contract) === canonical(input.contract), '/hash', 'Validated recipe has been modified');
    validateDefaultMaterialization(validated.contract.variables.sf, options.inputDefaults);
    const metadata = validated.contract.variables.sf;
    const recipe = validateContract('RecipeRevision', { id: randomUUID(), recipeId: metadata.recipeId, revision: randomUUID(), hash: validated.hash,
      name: metadata.displayName, description: validated.contract.description ?? metadata.taskTemplate.description, tagId: metadata.tagId,
      createdAt: this.now().toISOString(), yaml: validated.yaml, contract: validated.contract, repositoryIds: options.repositoryIds,
      inputDefaults: structuredClone(options.inputDefaults), skillVersions: validated.skillVersions, toolVersions: validated.toolVersions, outputSchema: {},
    });
    return this.store.runRecipeMutation(`revision:${recipe.id}`, { hash: recipe.hash, options }, () => {
      const saved = this.store.saveRecipeRevision(recipe, options.expectedRevision);
      const inactive = this.store.patchRecipe(recipe.recipeId, { active: false }, saved.revision);
      const readiness = this.readiness(recipe);
      this.store.setRecipeReadiness(recipe.recipeId, recipe.revision, { hash: recipe.hash, ready: readiness.ready, reasons: readiness.reasons }, inactive.revision);
      return recipe;
    });
  }
  private create(input: RecipeCreate, id?: string, expectedRevision?: number): RecipeRevision {
    validateContract('RecipeCreate', input);
    const validated = validateRecipe(input.yaml, []);
    if (id) {
      requirePolicy(validated.contract.variables.sf.recipeId === id, '/variables/sf/recipeId', 'Edited recipe identity must not change');
      requirePolicy(this.summary(id).revision === expectedRevision, '/revision', 'Recipe revision conflict');
    } else requirePolicy(!this.store.getRecipe(validated.contract.variables.sf.recipeId), '/recipeId', 'Recipe already exists');
    const prior = id ? this.store.getRecipe(id)! : undefined;
    const effective = { yaml: input.yaml, repositoryIds: input.repositoryIds ?? prior?.repositoryIds ?? [], inputDefaults: input.inputDefaults ?? prior?.inputDefaults ?? {} };
    this.requireBinding(input.validation, validated.hash, recipePayloadHash(effective));
    return this.saveRecipeRevision(validated, { repositoryIds: effective.repositoryIds, inputDefaults: effective.inputDefaults, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  }
  private patch(id: string, input: RecipePatch, expectedRevision?: number): RecipeSummary {
    validateContract('RecipePatch', input);
    let summary = this.summary(id);
    requirePolicy(summary.revision === expectedRevision, '/revision', 'Recipe revision conflict');
    const recipe = this.store.getRecipe(id)!;
    // Revalidate exact content before approving even if another trusted producer created this revision.
    const validated = validateRecipe(recipe.yaml, []);
    requirePolicy(validated.hash === recipe.hash && canonical(validated.contract) === canonical(recipe.contract), '/hash', 'Stored recipe content does not match hash');
    if (input.active === true || input.approval) this.requireBinding(input.validation, recipe.hash, recipePayloadHash(recipe));
    if (input.approval) {
      const approval = input.approval;
      requirePolicy(approval.recipeHash === recipe.hash && approval.payloadHash === recipePayloadHash(recipe), '/approval', 'Approval must match the exact content and payload hashes');
      requirePolicy(canonical([...approval.repositoryIds].sort()) === canonical([...recipe.repositoryIds].sort()) && recipe.repositoryIds.length > 0, '/approval/repositoryIds', 'Approval must match assigned repositories');
      requirePolicy(canonical(approval.capabilities) === canonical(recipe.contract.variables.sf.required), '/approval/capabilities', 'Approval must exactly match requested capabilities and finish policies');
      this.store.saveGrant({ id: randomUUID(), recipeId: id, recipeRevision: recipe.revision, repositoryIds: recipe.repositoryIds,
        required: structuredClone(approval.capabilities), executionProfileHash: this.profileHash(), grantedAt: this.now().toISOString() });
    }
    const readiness = this.readiness(recipe);
    requirePolicy(input.active !== true || readiness.ready, '/active', readiness.reasons.join('; ') || 'Recipe is not ready');
    summary = this.store.setRecipeReadiness(id, recipe.revision, { hash: recipe.hash, ready: readiness.ready, reasons: readiness.reasons }, summary.revision);
    const { approval: _approval, validation: _validation, ...patch } = input;
    return this.store.patchRecipe(id, patch, summary.revision);
  }
  /** All writes and the exact returned outcome commit together. Replays never execute a callback. */
  command(method: string, path: string, input: unknown, context: RequestContext, action: () => unknown): unknown {
    const identity = { method, path, input, expectedRevision: context.expectedRevision ?? null };
    let outcome: Outcome;
    try {
      outcome = this.store.runRecipeMutation(context.key, identity, () => ({ method, path, result: { state: 'complete', body: action() } }));
    } catch (error) {
      // This seam has only synchronous local SQLite writes; outer transaction rollback proves no effect.
      if (!(error instanceof RecipePolicyError || error instanceof RecipeValidationError || error instanceof TypeError || error instanceof StoreError)) throw error;
      if (error instanceof StoreError && error.code === 'idempotency_conflict') throw new DefinitiveNoEffect(409, { code: 'RECIPE_KEY_CONFLICT', message: 'Recipe request key conflicts', recovery: 'Use a new key for a new intentional request', retryable: false });
      const status: ApiFailureStatus = error instanceof RecipePolicyError && error.field === '/revision' || error instanceof StoreError && error.code === 'revision_conflict' ? 409 : 400;
      const failure: Reconciliation = { state: 'failed', status, error: { code: 'RECIPE_REJECTED', message: error.message, recovery: 'Correct the recipe or approval and submit with a new key', retryable: false } };
      outcome = this.store.runRecipeMutation(context.key, identity, () => ({ method, path, result: failure }));
    }
    if (outcome.result.state === 'failed') throw new DefinitiveNoEffect(outcome.result.status, outcome.result.error);
    requirePolicy(outcome.result.state === 'complete', '', 'Recipe outcome is incomplete'); return outcome.result.body;
  }
  createCommand(input: RecipeCreate, context: RequestContext): RecipeRevision {
    return this.command('POST', '/v1/recipes', input, context, () => this.create(input)) as RecipeRevision;
  }
  reviseCommand(id: string, input: RecipeCreate, context: RequestContext): RecipeRevision {
    return this.command('POST', `/v1/recipes/${id}/revisions`, input, context, () => this.create(input, id, context.expectedRevision)) as RecipeRevision;
  }
  patchCommand(id: string, input: RecipePatch, context: RequestContext): RecipeSummary {
    return this.command('PATCH', `/v1/recipes/${id}`, input, context, () => this.patch(id, input, context.expectedRevision)) as RecipeSummary;
  }
  reconcile(request: PendingRequest): Reconciliation {
    const outcome = this.store.readRecipeMutation<Outcome>(request.key);
    return outcome && outcome.method === request.method && outcome.path === request.path ? outcome.result : { state: 'pending' };
  }
  /** Trusted E3/E4/E6 refresh after evidence changes; historical pins remain independent of current edits. */
  refreshReadiness(recipeId: string, revision: string, key: string): RecipeSummary {
    return this.store.runRecipeMutation(key, { refreshReadiness: { recipeId, revision } }, () => {
      const recipe = this.store.getRecipeRevision(recipeId, revision);
      requirePolicy(recipe, '/recipeRevision', 'Recipe revision not found');
      const readiness = this.readiness(recipe); const summary = this.summary(recipeId);
      return this.store.setRecipeReadiness(recipeId, revision, { hash: recipe.hash, ready: readiness.ready, reasons: readiness.reasons }, summary.revision);
    });
  }
  revokeGrant(id: string, key: string): void {
    this.store.runRecipeMutation(key, { revokeGrant: id }, () => {
      const grant = this.store.getAdmissionState().grants.find(item => item.id === id);
      requirePolicy(grant, '/grantId', 'Grant not found'); this.store.revokeGrant(id);
      const recipe = this.store.getRecipeRevision(grant.recipeId, grant.recipeRevision)!;
      const readiness = this.readiness(recipe); const summary = this.summary(recipe.recipeId);
      this.store.setRecipeReadiness(recipe.recipeId, recipe.revision, { hash: recipe.hash, ready: readiness.ready, reasons: readiness.reasons }, summary.revision);
      return { revoked: true };
    });
  }
}
/** Implements the real C5 port. Reconciliation reads only the recorded stable-key outcome. */
export class C5RecipePort implements RecipePort {
  readonly registry: RecipeRegistry;
  constructor(registry: RecipeRegistry) { this.registry = registry; }
  async create(input: RecipeCreate, context: RequestContext): Promise<RecipeRevision> { return this.registry.createCommand(input, context); }
  async revise(id: string, input: RecipeCreate, context: RequestContext): Promise<RecipeRevision> { return this.registry.reviseCommand(id, input, context); }
  async patch(id: string, input: RecipePatch, context: RequestContext): Promise<RecipeSummary> { return this.registry.patchCommand(id, input, context); }
  async validate(input: RecipeValidationInput, context: RequestContext): Promise<RecipeValidation> {
    return this.registry.command('POST', '/v1/recipes/validate', input, context, () => this.registry.validate(input)) as RecipeValidation;
  }
  async reconcile(request: PendingRequest): Promise<Reconciliation> { return this.registry.reconcile(request); }
}
