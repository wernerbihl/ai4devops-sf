import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewRotation, selectAutomaticTag } from '../../src/scheduling/rotation.ts';
import type { RotationCursor, WeightSnapshot } from '../../src/scheduling/rotation-types.ts';

function weights(values: number[], revision = 1): WeightSnapshot {
  return { revision, entries: values.map((value, index) => ({ tagId: `T${index + 1}`, value, createdOrder: index })) };
}

function turns(snapshot: WeightSnapshot, count: number, cursor: RotationCursor | null = null, available: ReadonlySet<string> = new Set(['T1', 'T2', 'T3'])) {
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    const choice = selectAutomaticTag(snapshot, cursor, available);
    if (!choice) break;
    result.push(choice.tagId);
    cursor = choice.cursorAfterStart;
  }
  return { result, cursor };
}

// Catches smoothing, normalization, or editing unrelated independent weights.
test('matches_requested_batched_round_robin', () => {
  const snapshot = weights([90, 10]);
  const turns90_10 = turns(snapshot, 10).result;
  const turns80_50 = turns(weights([80, 50]), 13).result;
  const otherWeightsBefore = structuredClone(snapshot.entries.slice(1));
  const edited = { ...snapshot, revision: 2, entries: snapshot.entries.map(entry => entry.tagId === 'T1' ? { ...entry, value: 80 } : entry) };
  turns(edited, 9);
  const otherWeightsAfterEditingT1 = edited.entries.slice(1);
  assert.deepEqual(turns90_10, [...Array(9).fill("T1"), "T2"]);
  assert.deepEqual(turns80_50, [...Array(8).fill("T1"), ...Array(5).fill("T2")]);
  assert.deepEqual(otherWeightsAfterEditingT1, otherWeightsBefore);
  assert.deepEqual(turns(weights([90, 10]), 12).result, [...Array(9).fill('T1'), 'T2', 'T1', 'T1']);
});

// Catches ranking by input position rather than descending weight / creation order.
test('sorts_descending_with_stable_creation_order_ties', () => {
  const snapshot: WeightSnapshot = { revision: 1, entries: [
    { tagId: 'new', value: 50, createdOrder: 20 },
    { tagId: 'small', value: 25, createdOrder: 0 },
    { tagId: 'old', value: 50, createdOrder: 10 },
  ] };
  assert.deepEqual(turns(snapshot, 5, null, new Set(['new', 'small', 'old'])).result, ['old', 'old', 'new', 'new', 'small']);
});

// Catches zero values entering the cycle, including a zero GCD / empty cycle.
test('zero_weights_disable_automatic_starts', () => {
  assert.deepEqual(turns(weights([0, 100]), 3).result, ['T2', 'T2', 'T2']);
  assert.equal(selectAutomaticTag(weights([0, 0]), null, new Set(['T1', 'T2'])), null);
  assert.equal(selectAutomaticTag(weights([]), null, new Set(['T1'])), null);
  assert.deepEqual(previewRotation(weights([0]), null, new Set(['T1']), 5), []);
});

// Catches carrying skipped quotas forward or retaining a partially unavailable batch.
test('skips_unavailable_tags_without_catch_up_debt', () => {
  const snapshot = weights([60, 30, 10]);
  const first = turns(snapshot, 2).cursor;
  const skipped = turns(snapshot, 3, first, new Set(['T2', 'T3']));
  assert.deepEqual(skipped.result, ['T2', 'T2', 'T2']);
  assert.deepEqual(turns(snapshot, 8, skipped.cursor).result, ['T3', ...Array(6).fill('T1'), 'T2']);
  assert.deepEqual(turns(snapshot, 4, null, new Set(['T3'])).result, ['T3', 'T3', 'T3', 'T3']);
  assert.equal(selectAutomaticTag(snapshot, first, new Set(['unknown'])), null);
});

// Catches restart resetting a partial batch or losing cycle position.
test('serialized_cursor_resumes_mid_batch_and_across_cycles', () => {
  const snapshot = weights([80, 50]);
  const first = turns(snapshot, 6);
  const restored: RotationCursor = JSON.parse(JSON.stringify(first.cursor));
  assert.deepEqual(turns(snapshot, 9, restored).result, ['T1', 'T1', ...Array(5).fill('T2'), 'T1', 'T1']);
  assert.deepEqual(restored.cycleQuotas, [{ tagId: 'T1', quota: 8 }, { tagId: 'T2', quota: 5 }]);
});

// Catches applying an obsolete cursor after an independent weight edit.
test('weight_revision_change_restarts_with_new_quotas', () => {
  const oldCursor = turns(weights([90, 10]), 9).cursor;
  assert.deepEqual(turns(weights([10, 90], 2), 10, oldCursor).result, [...Array(9).fill('T2'), 'T1']);
  assert.deepEqual(turns(weights([90, 10], 2), 2, oldCursor).result, ['T1', 'T1']);
});

// Catches preview consuming persisted state, input mutation, or returning too many turns.
test('preview_is_read_only_and_matches_selection', () => {
  const snapshot = weights([80, 50]);
  const cursor = turns(snapshot, 7).cursor!;
  const available = new Set(['T1', 'T2']);
  const before = structuredClone({ snapshot, cursor, available });
  Object.freeze(snapshot.entries); Object.freeze(snapshot);
  cursor.cycleQuotas.forEach(Object.freeze); Object.freeze(cursor.cycleQuotas); Object.freeze(cursor);
  assert.deepEqual(previewRotation(snapshot, cursor, available, 8), ['T1', ...Array(5).fill('T2'), 'T1', 'T1']);
  assert.deepEqual(previewRotation(snapshot, cursor, available, 8), turns(snapshot, 8, cursor, available).result);
  assert.deepEqual({ snapshot, cursor, available }, before);
  assert.deepEqual(previewRotation(snapshot, cursor, available, 0), []);
});

// Catches invalid arithmetic inputs or corrupted persisted positions producing silent turns.
test('rejects_invalid_current_inputs_and_ignores_stale_cursor_shape', () => {
  for (const value of [-1, 101, 1.5, NaN, Infinity]) {
    assert.throws(() => selectAutomaticTag(weights([value]), null, new Set(['T1'])), RangeError);
  }
  assert.throws(() => selectAutomaticTag(weights([1], -1), null, new Set(['T1'])), RangeError);
  const duplicate: WeightSnapshot = { revision: 1, entries: [
    { tagId: 'T1', value: 10, createdOrder: 0 },
    { tagId: 'T1', value: 20, createdOrder: 1 },
  ] };
  assert.throws(() => selectAutomaticTag(duplicate, null, new Set(['T1'])), RangeError);
  const snapshot = weights([80, 50]);
  const cursor = turns(snapshot, 1).cursor!;
  for (const invalid of [
    { ...cursor, tagIndex: 2 },
    { ...cursor, tagIndex: 0.5 },
    { ...cursor, remainingQuota: 0 },
    { ...cursor, remainingQuota: 9 },
    { ...cursor, cycleQuotas: [{ tagId: 'T1', quota: 80 }, { tagId: 'T2', quota: 50 }] },
  ]) assert.throws(() => selectAutomaticTag(snapshot, invalid, new Set(['T1', 'T2'])), RangeError);
  assert.equal(selectAutomaticTag({ ...snapshot, revision: 2 }, { ...cursor, remainingQuota: -1 }, new Set(['T1', 'T2']))!.tagId, 'T1');
  for (const count of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => previewRotation(snapshot, cursor, new Set(['T1']), count), RangeError);
  }
});
