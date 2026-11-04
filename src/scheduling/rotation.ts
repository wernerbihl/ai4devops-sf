import type { RotationChoice, RotationCursor, RotationQuota, WeightSnapshot } from './rotation-types.ts';

function gcd(left: number, right: number): number {
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function cycleFor(weights: WeightSnapshot): RotationQuota[] {
  if (!Number.isSafeInteger(weights.revision) || weights.revision < 0) {
    throw new RangeError('Weight revision must be a nonnegative safe integer');
  }
  const seen = new Set<string>();
  for (const entry of weights.entries) {
    if (!entry.tagId || seen.has(entry.tagId)
      || !Number.isInteger(entry.value) || entry.value < 0 || entry.value > 100
      || !Number.isSafeInteger(entry.createdOrder) || entry.createdOrder < 0) {
      throw new RangeError('Weights require unique tag IDs, integer values 0–100, and nonnegative creation orders');
    }
    seen.add(entry.tagId);
  }
  const positive = weights.entries.filter(entry => entry.value > 0)
    .sort((left, right) => right.value - left.value || left.createdOrder - right.createdOrder);
  const divisor = positive.reduce((value, entry) => gcd(value, entry.value), 0);
  return positive.map(entry => ({ tagId: entry.tagId, quota: entry.value / divisor }));
}

function validateCursor(cursor: RotationCursor, cycle: readonly RotationQuota[]): void {
  if (cursor.cycleQuotas.length !== cycle.length
    || cycle.some((entry, index) => entry.tagId !== cursor.cycleQuotas[index]?.tagId || entry.quota !== cursor.cycleQuotas[index]?.quota)
    || !Number.isInteger(cursor.tagIndex) || cursor.tagIndex < 0 || cursor.tagIndex >= cycle.length
    || !Number.isInteger(cursor.remainingQuota) || cursor.remainingQuota < 1
    || cursor.remainingQuota > cycle[cursor.tagIndex]!.quota) {
    throw new RangeError('Rotation cursor must match the current reduced cycle and contain a valid next position');
  }
}

/**
 * Select one automatic start without changing inputs. Only persist cursorAfterStart
 * when that start is admitted. A revision change discards the old cursor entirely;
 * malformed same-revision cursors throw RangeError instead of silently restarting.
 */
export function selectAutomaticTag(weights: WeightSnapshot, cursor: RotationCursor | null, available: ReadonlySet<string>): RotationChoice | null {
  const cycle = cycleFor(weights);
  if (cycle.length === 0) return null;
  const current = cursor?.weightsVersion === weights.revision ? cursor : null;
  if (current) validateCursor(current, cycle);
  let tagIndex = current?.tagIndex ?? 0;
  let remainingQuota = current?.remainingQuota ?? cycle[0]!.quota;

  // Each unavailable batch is discarded in one step, with no catch-up debt.
  for (let visited = 0; visited < cycle.length; visited++) {
    const entry = cycle[tagIndex]!;
    if (available.has(entry.tagId)) {
      remainingQuota--;
      if (remainingQuota === 0) {
        tagIndex = (tagIndex + 1) % cycle.length;
        remainingQuota = cycle[tagIndex]!.quota;
      }
      return { tagId: entry.tagId, cursorAfterStart: {
        weightsVersion: weights.revision, cycleQuotas: cycle, tagIndex, remainingQuota,
      } };
    }
    tagIndex = (tagIndex + 1) % cycle.length;
    remainingQuota = cycle[tagIndex]!.quota;
  }
  return null;
}

/** Simulate starts using local cursor values; never commit or mutate rotation state. */
export function previewRotation(weights: WeightSnapshot, cursor: RotationCursor | null, available: ReadonlySet<string>, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Preview count must be a nonnegative safe integer');
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    const choice = selectAutomaticTag(weights, cursor, available);
    if (!choice) break;
    result.push(choice.tagId);
    cursor = choice.cursorAfterStart;
  }
  return result;
}
