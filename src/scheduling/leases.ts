import type { Attempt, Clock, TaskSpec } from '../contracts/domain.ts';
import type { AdmissionState } from './admission-types.ts';
import { hasCapabilityGrants } from './eligibility.ts';
import { ensure } from '../storage/database.ts';

export type Quiescence = 'stopped' | 'waiting' | 'unknown';
export interface ActiveSegment { epoch: string; started: number; ended: number }
export interface LifecycleState {
  segments: ActiveSegment[];
  active?: { epoch: string; started: number };
  uncertain?: boolean;
  quiescent?: boolean;
  stopRequested?: boolean;
  effect?: { actionId: string; token: string; phase: 'inflight' | 'unknown' | 'accepted' };
}
export function continuationAllowed(task: TaskSpec, state: AdmissionState, clock: Clock, retry: boolean, held?: { attemptId: string; pending: boolean }): void {
  const repository = state.repositories.find(repo => repo.id === task.repositoryId);
  ensure(repository?.controlMode === 'factory' && !state.settings.paused, 'paused', 'Return repository and factory to automatic control');
  const otherLeases = state.activeLeases.filter(lease => lease.attemptId !== held?.attemptId);
  ensure(!otherLeases.some(lease => lease.repositoryId === task.repositoryId), 'repository_busy', 'Wait for the repository writer to quiesce');
  ensure(otherLeases.length < state.settings.config.limits.concurrency, 'capacity', 'Wait for active capacity');
  ensure(!retry || state.quota.confirmed + state.quota.pending - (held?.pending ? 1 : 0) < state.settings.config.limits.startsPerDay, 'day_limit', 'Wait for the next local day');
  ensure(state.recipes.some(recipe => recipe.id === task.recipeId && recipe.active)
    && state.recipeReadiness.some(r => r.recipeId === task.recipeId && r.recipeRevision === task.recipeRevision && r.ready)
    && state.tags.some(tag => tag.id === task.tagId && !tag.archivedAt)
    && hasCapabilityGrants(task, state.grants, clock), 'capability_blocked', 'Revalidate pinned recipe and explicit capability grants');
}
/** Monotonic clocks are comparable only inside the process epoch that opened a segment. */
export function accountActive(attempt: Attempt, state: LifecycleState, clock: Clock, epoch: string, stop: boolean, budget: number): { duration: number; state: LifecycleState } {
  const next = structuredClone(state);
  let duration = attempt.activeDurationMs;
  if (next.active) {
    if (next.active.epoch !== epoch || clock.monotonicMs() < next.active.started) {
      duration = Math.max(duration, budget); next.uncertain = true;
    } else {
      const end = clock.monotonicMs(); duration += Math.floor(end - next.active.started);
      next.segments.push({ ...next.active, ended: end });
    }
    delete next.active;
  }
  if (!stop) next.active = { epoch, started: clock.monotonicMs() };
  return { duration, state: next };
}
