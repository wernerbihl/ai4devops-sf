export interface CoordinatorOptions {
  taktMs: number; controlMs: number;
  dispatch(trigger: 'takt' | 'manual' | 'resume' | 'lease_released'): Promise<unknown>;
  control(): Promise<void>;
  reconcile(): Promise<unknown>;
  onFailure?(lane: 'dispatch' | 'control' | 'reconcile'): void;
}
/** Independent lanes: a hung external start/send cannot own the deadline lane.
 * Timers represent present opportunities only; busy/slept ticks are discarded. */
export function createCoordinator(options: CoordinatorOptions) {
  if (![options.taktMs, options.controlMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) throw new TypeError('Positive runtime intervals required');
  let stopped = true; let dispatching = false; let controlling = false; let reconciling = false;
  let takt: NodeJS.Timeout | undefined; let control: NodeJS.Timeout | undefined;
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
      takt = setInterval(() => { void dispatch('takt'); }, options.taktMs);
      control = setInterval(() => { void check(); void reconcile(); }, options.controlMs);
      void dispatch('resume');
    },
    stop() { stopped = true; clearInterval(takt); clearInterval(control); },
  };
}
