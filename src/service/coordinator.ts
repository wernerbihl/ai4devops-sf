export interface CoordinatorOptions {
  /** Read current Settings on the independent control cadence; a change starts a fresh period. */
  taktMs: number | (() => number); controlMs: number;
  dispatch(trigger: 'takt' | 'manual' | 'resume' | 'lease_released'): Promise<unknown>;
  control(): Promise<void>;
  reconcile(): Promise<unknown>;
  onFailure?(lane: 'dispatch' | 'control' | 'reconcile'): void;
}
/** Independent lanes: a hung external start/send cannot own the deadline lane.
 * Timers represent present opportunities only; busy/slept ticks are discarded. */
export function createCoordinator(options: CoordinatorOptions) {
  const currentTaktMs = () => typeof options.taktMs === 'function' ? options.taktMs() : options.taktMs;
  const valid = (ms: number) => Number.isSafeInteger(ms) && ms > 0;
  if (![currentTaktMs(), options.controlMs].every(valid)) throw new TypeError('Positive runtime intervals required');
  let stopped = true; let dispatching = false; let controlling = false; let reconciling = false;
  let takt: NodeJS.Timeout | undefined; let control: NodeJS.Timeout | undefined;
  let scheduledTaktMs: number | undefined;
  function refreshTakt() {
    if (stopped) return;
    try {
      const next = currentTaktMs();
      if (!valid(next)) throw new TypeError('Positive runtime interval required');
      if (next === scheduledTaktMs) return;
      clearInterval(takt);
      scheduledTaktMs = next;
      // Start from observation time, never the old timer's elapsed/missed opportunities.
      takt = setInterval(() => { void dispatch('takt'); }, next);
    } catch { options.onFailure?.('control'); }
  }
  async function dispatch(trigger: 'takt' | 'manual' | 'resume' | 'lease_released') {
    if (stopped || dispatching) return;
    dispatching = true;
    try { await options.dispatch(trigger); } catch { options.onFailure?.('dispatch'); } finally { dispatching = false; }
  }
  async function check() {
    if (stopped || controlling) return;
    controlling = true;
    try { await options.control(); } catch { options.onFailure?.('control'); } finally { controlling = false; }
  }
  async function reconcile() {
    if (stopped || reconciling) return;
    reconciling = true;
    try { await options.reconcile(); } catch { options.onFailure?.('reconcile'); } finally { reconciling = false; }
  }
  return {
    dispatch, check, reconcile,
    start() {
      if (!stopped) return;
      stopped = false;
      refreshTakt();
      control = setInterval(() => { refreshTakt(); void check(); void reconcile(); }, options.controlMs);
      void dispatch('resume');
    },
    stop() { stopped = true; clearInterval(takt); clearInterval(control); scheduledTaktMs = undefined; },
  };
}
