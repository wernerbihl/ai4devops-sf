import type { QuotaState } from './admission-types.ts';

/** A calendar key, never elapsed hours. Persisted high-water keys prevent clock-reversal resets. */
export function effectiveDayKey(localDayKey: string, highWaterDay?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDayKey)) throw new RangeError('Clock must supply a YYYY-MM-DD local day');
  return highWaterDay && highWaterDay > localDayKey ? highWaterDay : localDayKey;
}
export function quotaAvailable(quota: QuotaState, startsPerDay: number): boolean {
  return quota.confirmed + quota.pending < startsPerDay;
}
