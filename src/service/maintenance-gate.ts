/** Synchronous admission fence and drain barrier for operations that may create writers. */
export class MaintenanceGate {
  private closed = false;
  private active = 0;
  private waiters: Array<() => void> = [];
  enter(): () => void {
    if (this.closed) throw new Error('Factory maintenance is in progress');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) for (const resolve of this.waiters.splice(0)) resolve();
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.active) await new Promise<void>(resolve => this.waiters.push(resolve));
  }
}
