# Contracts and Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the integration routes and publish the contracts every subsystem consumes.

**Architecture:** Keep executable probes separate from production adapters and share only the validated protocol/domain boundary. Record real host/isolation evidence before broad implementation.

**Tech Stack:** Node/TypeScript, JSON Schema/OpenAPI, AHP, BB SDK, Docker/Kestra and minimal shared Svelte fixtures.

**Spec:** [Approved design](../../specs/2026-11-03-local-software-factory-design.md); [master plan and shared types](../2026-11-03-software-factory.md).

## Global Constraints

All master-plan Global Constraints apply unchanged. No Claude, native session
import, broader fallback, paid Kestra dependency, or passing skipped live gate.

## Review Focus

RF3 belongs to P2/P3/P4. RF4 belongs to P4. P5 checks real embedded boundaries
instead of assuming a browser mount proves all four hosts.

---

### P1: Versioned domain and API contracts

**Files:** Create runner/package.json, package-lock.json, .gitignore, .node-version, tsconfig.json,
tsconfig.build.json, src/contracts/{domain,schemas,defaults,owner}.ts,
scripts/generate-protocol.ts, protocol/{openapi.json,schemas.json},
tests/contracts/contracts.test.ts, tests/fixtures/contracts.ts.

**Interfaces:** Produces all master shared types;
`validateTask(value: unknown): TaskSpec`;
`validateRecipeContract(value: unknown): RecipeContract`;
`defaultConfig(factoryDir: string): FactoryConfig`. Generated protocol includes
browser DTOs, worker envelopes, errors and owner RPC; no credential values.
tests/fixtures/contracts.ts exports `validTask(): TaskSpec`. Ignore
tests/.scratch, build output and raw logs; retain only sanitized gate evidence.

- [ ] Select a verified Node >=24.22.2 runtime in the isolated execution environment and record its absolute executable path. Set .node-version to 24.22.2; use the environment's user-scoped runtime provisioning rather than changing global Node 22.21.1. Confirm `node --version` before dependency installation/tests.
- [ ] Write `validates_task_and_defaults` asserting one tag only, nonempty goals/criteria, only Copilot/Codex, four finish policies, no context budget, and defaults `60/1/30/100/2`. Reject a task attempting a second tag or an unknown provider.
~~~ts
assert.equal(validateTask(validTask()).tagId, "features");
assert.throws(() => validateTask({ ...validTask(), tags: ["features", "bugs"] }));
assert.deepEqual(defaultConfig("/factory").limits,
  { concurrency: 1, activeMinutes: 30, startsPerDay: 100, transientRetries: 2 });
~~~
- [ ] Run `npm test -- tests/contracts/contracts.test.ts`; expect missing contract failures, not environment-related failures.
- [ ] Implement the signatures and generator. Configure ESM, Node >=24.22.2, test/typecheck/build scripts, erasable TypeScript and rewritten emitted extensions. Pin development dependencies and lockfile; keep runtime files compiled.
- [ ] Run focused tests, `npm run typecheck`, `npm run build` and `npm run protocol:check`; expect valid fixtures to round-trip and regeneration to leave no diff.
- [ ] Commit: `git add package.json package-lock.json tsconfig*.json src/contracts scripts/generate-protocol.ts protocol tests/contracts tests/fixtures`; `git commit -m "feat: define factory protocol and defaults"`.

### P2: VS Code native execution and exact-session opening

**Files:** Create runner/probes/vscode.ts, probes/common.ts,
tests/probes/vscode.test.ts, release/compatibility.json.
Modify runner/package.json/package-lock.json for the pinned protocol dependency
and `probe:vscode` script.

**Interfaces:** Consumes NativeOwner/NativeStart/ProbeEvidence. Produces
`probeVsCode(options: ProbeOptions): Promise<ProbeEvidence>`; ProbeOptions
contains scratchRepo, outputDir, explicit live permission, endpoint and provider.
release/compatibility.json records exact tested host/package versions.

- [ ] Add a fake AHP server test asserting provider-schema discovery, create/send/input/cancel/resume, exact native identity, and unsupported-profile rejection. RF3: drop the create reply; reconciliation must find the original session.
~~~ts
assert.equal(report.status, "passed");
assert.equal(createdSessionIds.size, 1);
assert.deepEqual(resumedIdentity, createdIdentity);
~~~
- [ ] Run `npm test -- tests/probes/vscode.test.ts`; expect failure before the probe exists.
- [ ] Implement the probe against the official pinned AHP contract and source-verified opening route; separate version-gated navigation from protocol logic.
- [ ] Run focused tests and `npm run probe:vscode -- --live --scratch-repo tests/.scratch/probe-repo --provider copilot`, then the Codex equivalent. Require both live evidence files to show create, native-open, pause/resume, restart/reconcile and quiescence. Absence is blocked.
- [ ] Commit: `git add probes tests/probes/vscode.test.ts release/compatibility.json package.json package-lock.json`; `git commit -m "test: prove VS Code native owner lifecycle"`.

### P3: BB native thread lifecycle and isolation provisioning

**Files:** Create runner/probes/bb.ts, tests/probes/bb.test.ts;
canvas/package.json, package-lock.json, tsconfig.json, scripts/build-probe.ts,
probes/bb/{plugin.ts,owner-probe.ts}; update compatibility manifest.
Modify runner/package.json/package-lock.json for `probe:bb`.

**Interfaces:** Produces `probeBb(options: ProbeOptions): Promise<ProbeEvidence>`.
The probe plugin uses public thread, interaction, navigation and dispatch-hook
contracts; NativeIdentity stores the BB thread ID as sessionId.

- [ ] Add a fake BB SDK test asserting spawn/send/input/retry/stop, exact-thread navigation, pre-dispatch lease rejection and absence of unregistered Copilot. RF3: reconnect after spawn with no reply and retain the original thread.
~~~ts
assert.equal(nativeThreadIds.size, 1);
assert.equal(registeredProviders.includes("copilot"), false);
assert.deepEqual(openedIdentity, resumedIdentity);
~~~
- [ ] Run `npm test -- tests/probes/bb.test.ts`; expect missing probe failures.
- [ ] Implement the probe bridge and a real isolated enrolled environment; verify effective mounts/network/tools. A worktree alone cannot pass. Record how provisioning and teardown are performed through supported APIs.
- [ ] Run focused tests, canvas `npm run build:probe` and runner `npm run probe:bb -- --live --scratch-repo tests/.scratch/probe-repo`. Require native Codex lifecycle plus isolation evidence. If local isolated provisioning is unavailable, report the blocker; a mocked profile is not proof.
- [ ] Commit probe changes in each owning repository with `test: prove BB native execution boundary`; include lock/compatibility changes.

### P4: Restricted Kestra/H2 and actual worker/agent boundaries

**Files:** Create runner/probes/kestra.ts, probes/isolation.ts,
tests/probes/{kestra,isolation}.test.ts, release/{images.json,recipe-policy.json}.
Modify runner/package.json for `probe:kestra` and `probe:isolation`.

**Interfaces:** Produces `probeKestra(options: ProbeOptions): Promise<ProbeEvidence>` and
`verifyProfile(profile: ProfileSpec): Promise<ProfileEvidence>`. P1 defines
ProfileSpec/ProfileEvidence with profile ID, image digests, effective settings,
verified restrictions and timestamp; unverified restrictions cannot become ready.

- [ ] Add tests requiring H2 persistence through restart, typed Pause/resume, immutable revision lookup, `variables.sf` compatibility and idempotent execution lookup. RF3: lose a start reply without duplicating execution.
- [ ] Add RF4 negative fixtures: Process runner, privileged/socket/host mounts, arbitrary plugins/subflows, unsafe interpolation, symlink escape, alternate IPv6/DNS egress, and client tools executing outside the native boundary must fail.
~~~ts
assert.equal(escapeResults.every(result => result.blocked), true);
assert.equal(resumedExecutionId, originalExecutionId);
assert.equal(metadataAcceptedByPinnedKestra, true);
~~~
- [ ] Run `npm test -- tests/probes/kestra.test.ts tests/probes/isolation.test.ts`; expect missing implementation/assertion failures.
- [ ] Implement probes using an exact OSS image/plugin set and controlled worker/native environments. Pin images by digest. Prove model credential scope separately from ungranted host credential access; never claim use-only secrecy without evidence.
- [ ] Run focused tests and `npm run probe:kestra -- --live --scratch-repo tests/.scratch/probe-repo` plus the equivalent probe:isolation command. Require real restriction tests and durable Pause/restart evidence; update schema mapping and fixtures together if upstream requires a technical metadata adjustment.
- [ ] Commit: `git add probes tests/probes release protocol src/contracts`; `git commit -m "test: prove restricted Kestra and native isolation"`.

### P5: Four real dashboard mounts and gate report

**Files:** Create canvas/probes/shared/{App.svelte,mount.ts},
probes/canvas/extension.mjs, probes/bb/frontend.tsx,
probes/standalone/{index.html,vite.config.ts}, tests/probes/mount.test.ts;
runner/scripts/check-gates.ts, tests/probes/gates.test.ts.
Create canvas/vitest.probes.config.ts; modify canvas/package.json/package-lock.json
to add Svelte/Vite/Vitest/DOM test tooling and a working probe test command.
Modify runner/package.json for `gates:check`.

**Interfaces:** Produces `mountProbe(target: HTMLElement, bridge: ProbeBridge): () => void`;
`checkGates(evidenceDir: string): GateSummary`, with
`GateSummary {ready: boolean; blocked: string[]; passed: string[]}`.
ProbeBridge supports health,
theme, native navigation and authenticated connection without credentials in UI.

- [ ] Add mount/unmount/theme/bridge tests and a gate-summary test that rejects missing, blocked, failed or version-mismatched required evidence.
~~~ts
assert.equal(summary.ready, false);
assert.equal(summary.blocked.includes("dashboard-copilot-app"), true);
assert.equal(mountedRootsAfterDispose, 0);
~~~
- [ ] Run canvas `npm test -- tests/probes/mount.test.ts` and runner `npm test -- tests/probes/gates.test.ts`; expect missing implementations.
- [ ] Implement one shared fixture and minimal public host wrappers. Validate portal/theme/CSP/resource behavior. Copilot App execution-owner handlers are an optional separate capability; its dashboard mount is mandatory.
- [ ] Run the real standalone, VS Code Canvas, Copilot App Canvas and BB mount probes, then `npm run gates:check` in runner. Require all mandatory gates to pass with sanitized reports and exact versions.
- [ ] Commit in each repository with `test: verify all factory dashboard surfaces`. Stop dependent product work if gates are incomplete.
