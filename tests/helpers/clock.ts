import type { Clock } from '../../src/contracts/domain.ts';

export class FakeClock implements Clock {
  private time = Date.parse('2026-11-04T10:00:00.000Z');
  private elapsed = 0;
  wallNow(): Date { return new Date(this.time); }
  monotonicMs(): number { return this.elapsed; }
  localDayKey(at: Date): string { return at.toISOString().slice(0, 10); }
  advance(ms: number): void { this.time += ms; this.elapsed += ms; }
}
