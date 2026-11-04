import { randomUUID } from 'node:crypto';
import type { Clock, Repository, TaskRecord, TaskSpec } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreError } from '../storage/store.ts';
import type { FactoryStore, RecipeMaterializer } from '../storage/store.ts';
import type { AdmissionCandidate, AdmissionState, ExternalStartIdentity, PreparedStart, Reservation, UnavailableStart } from './admission-types.ts';
import { hasCapabilityGrants, repositoryEligible, taskEligible } from './eligibility.ts';
import { quotaAvailable } from './quotas.ts';
import { selectAutomaticTag } from './rotation.ts';

export type { AdmissionCandidate, ExternalStartIdentity, PreparedStart, Reservation } from './admission-types.ts';
export type StartOutcome = { kind: 'started'; identity: ExternalStartIdentity }
  | { kind: 'not_started'; code: string; recovery: string }
  | { kind: 'unknown'; code: string; recovery: string };
export interface SchedulerDeps {
  store: FactoryStore;
  clock: Clock;
  materialize: RecipeMaterializer;
  /** E1/E2/E4 verify the exact assigned owner/provider, capability and isolation before returning prepared paths. */
  readiness(task: TaskSpec): Promise<PreparedStart | UnavailableStart>;
  /** This port must return started only after proving the external execution exists, never on an accepted request alone. */
  /** Explicit user continuations run before new task admission and are not a new daily/weighted start. */
  continuations?(): Promise<{ kind: 'started'; attemptId: string } | null>;
  start(reservation: Reservation): Promise<StartOutcome>;
}
export type DispatchResult = { kind: 'started'; attemptId: string }
  | { kind: 'noop'; code: string; recovery: string; reservationId?: string };
export interface Scheduler { dispatch(trigger: 'takt' | 'manual' | 'resume' | 'lease_released'): Promise<DispatchResult> }
interface Selection { task: TaskSpec; record?: TaskRecord; repository: Repository; candidate: Omit<AdmissionCandidate, 'prepared'> }
const noop = (code: string, recovery: string, reservationId?: string): DispatchResult => ({ kind: 'noop', code, recovery, ...(reservationId ? { reservationId } : {}) });

/** One call represents one present dispatch opportunity. No tick history, timer, external creation retry, or work queue lives here. */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  function orderedRepositories(state: AdmissionState): Repository[] {
    // Stable insertion order breaks never-serviced/equal-time ties. Durable sequence orders starts even at identical wall times.
    return [...state.repositories].sort((a, b) => (state.repositoryService[a.id] ?? 0) - (state.repositoryService[b.id] ?? 0));
  }
  function basis(state: AdmissionState, repository: Repository, task: TaskSpec, record?: TaskRecord): Omit<AdmissionCandidate, 'prepared'> {
    return { task, taskRevision: record?.revision ?? null, repositoryRevision: repository.revision,
      recipeSummaryRevision: state.recipes.find(recipe => recipe.id === task.recipeId)!.revision,
      settingsRevision: state.settings.revision, stateToken: state.token,
      proposedRotation: null };
  }
  function choose(state: AdmissionState, excluded: Set<string>): Selection | null {
    const repos = orderedRepositories(state);
    const queued = state.tasks.filter(task => taskEligible(task, state) && hasCapabilityGrants(task.spec, state.grants, deps.clock)
      && !excluded.has(task.spec.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const repository of repos) {
      const record = queued.find(task => task.spec.repositoryId === repository.id && task.spec.source === 'manual');
      if (record) return { task: record.spec, record, repository, candidate: basis(state, repository, record.spec, record) };
    }
    for (const repository of repos) {
      if (!repositoryEligible(repository, false, state)) continue;
      const automatic = queued.filter(task => task.spec.repositoryId === repository.id && task.spec.source !== 'manual');
      const choices: Selection[] = automatic.map(record => ({ task: record.spec, record, repository, candidate: basis(state, repository, record.spec, record) }));
      const recipes = state.recipes.filter(recipe => recipe.active && recipe.ready && state.tags.some(tag => tag.id === recipe.tagId && !tag.archivedAt))
        .sort((a, b) => (state.recipeService[`${repository.id}:${a.id}`] ?? 0) - (state.recipeService[`${repository.id}:${b.id}`] ?? 0));
      for (const summary of recipes) {
        const key = `fresh:${repository.id}:${summary.id}`;
        if (excluded.has(key)) continue;
        const recipe = deps.store.getRecipeRevision(summary.id, summary.currentRevision)!;
        if (!recipe.repositoryIds.includes(repository.id) || !(repository.weights[recipe.tagId]! > 0)) continue;
        const defaults = { ownerId: state.settings.config.defaultOwnerId, providerId: state.settings.config.defaultProviderId, finishPolicy: recipe.contract.variables.sf.defaultFinishPolicy };
        const id = randomUUID(); const template = recipe.contract.variables.sf.taskTemplate;
        const request = { recipeId: recipe.recipeId, repositoryIds: [repository.id], title: template.title, description: template.description };
        try {
          const task = validateContract('TaskSpec', deps.materialize({ id, repository: structuredClone(repository), recipe: structuredClone(recipe), request, defaults, source: 'automatic' }));
          if (task.id !== id || task.parentId !== undefined || task.source !== 'automatic' || task.repositoryId !== repository.id
            || task.recipeId !== recipe.recipeId || task.recipeRevision !== recipe.revision || task.tagId !== recipe.tagId
            || task.ownerId !== defaults.ownerId || task.providerId !== defaults.providerId || task.finishPolicy !== defaults.finishPolicy
            || task.title !== request.title || task.description !== request.description) { excluded.add(key); continue; }
          if (!hasCapabilityGrants(task, state.grants, deps.clock)) continue;
          choices.push({ task, repository, candidate: basis(state, repository, task) });
        } catch { excluded.add(key); }
      }
      const rotation = state.rotations[repository.id]!;
      const choice = selectAutomaticTag(rotation.weights, rotation.cursor, new Set(choices.map(value => value.task.tagId)));
      const selected = choice ? choices.find(value => value.task.tagId === choice.tagId) : undefined;
      if (selected) { selected.candidate.proposedRotation = choice!.cursorAfterStart; return selected; }
    }
    return null;
  }
  return {
    async dispatch(_trigger): Promise<DispatchResult> {
      const continuation = await deps.continuations?.();
      if (continuation) return continuation;
      const excluded = new Set<string>();
      for (;;) {
        const state = deps.store.getAdmissionState();
        if (state.settings.paused) return noop('paused', 'Resume the factory');
        if (state.activeLeases.length >= state.settings.config.limits.concurrency) return noop('capacity', 'Wait for an active lease to be released');
        if (!quotaAvailable(state.quota, state.settings.config.limits.startsPerDay)) return noop('day_limit', 'Wait for the next local calendar day');
        const selected = choose(state, excluded);
        if (!selected) return noop('no_eligible_work', 'Activate a repository or resolve recipe, owner and capability readiness');
        const key = selected.record ? selected.task.id : `fresh:${selected.repository.id}:${selected.task.recipeId}`;
        // Capture the calendar day before readiness; reserve rejects a midnight crossing.
        const dayKey = deps.clock.localDayKey(deps.clock.wallNow());
        let prepared: PreparedStart | UnavailableStart;
        try { prepared = await deps.readiness(structuredClone(selected.task)); }
        catch { prepared = { ready: false, code: 'owner_unavailable', recovery: 'Reconnect the assigned owner and verify its isolation profile' }; }
        if (!prepared.ready) {
          excluded.add(key);
          if (selected.record) {
            try { deps.store.markAdmissionAttention(selected.task.id, selected.record.revision, prepared.code, prepared.recovery); }
            catch (error) { if (!(error instanceof StoreError)) throw error; }
          }
          continue;
        }
        let reservation: Reservation;
        try { reservation = deps.store.reserveStart({ ...selected.candidate, prepared }, dayKey); }
        catch (error) {
          if (error instanceof StoreError) return noop(error.code, error.message);
          throw error;
        }
        let outcome: StartOutcome;
        try { outcome = await deps.start(structuredClone(reservation)); }
        catch { return noop('launch_unknown', 'Reconcile the reserved external execution before retrying', reservation.id); }
        if (outcome.kind === 'not_started') {
          deps.store.releaseUnstarted(reservation.id); return noop(outcome.code, outcome.recovery);
        }
        if (outcome.kind === 'unknown') return noop(outcome.code, outcome.recovery, reservation.id);
        try { deps.store.confirmStart(reservation.id, outcome.identity); }
        catch (error) { return noop(error instanceof StoreError ? error.code : 'confirmation_unknown', 'Reconcile the proven external start and retained reservation', reservation.id); }
        return { kind: 'started', attemptId: reservation.attempt.id };
      }
    },
  };
}
