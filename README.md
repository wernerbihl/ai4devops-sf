# Software Factory foundation

Contracts, feasibility probes and shared dashboard fixtures for the approved local Software Factory design. The production factory service, scheduler, installer and dashboard are still planned.

Use Node **24.22.2 or later**:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run protocol:check
```

See the [session closeout and manual-test handoff](docs/superpowers/reports/2026-11-04-session-closeout.md), [implementation plan](docs/superpowers/plans/2026-11-03-software-factory.md) and [evidence report](release/evidence/p5/README.md).

The user deferred remaining live integration tests to manual testing for this checkpoint merge. `npm run gates:check` continues to report the actual evidence status; missing native proof is not reported as passing.
