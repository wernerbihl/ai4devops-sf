# Software Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved local factory, with Copilot/Codex native execution and all four dashboard surfaces.

**Architecture:** A local Node service owns SQLite, scheduling, leases, GitHub operations, and the protected UI API. Pinned Kestra/H2 runs restricted recipes; trusted adapters control verified isolated native execution owners. One Svelte application supplies the standalone, VS Code Canvas, Copilot App Canvas, and BB dashboards.

**Tech Stack:** TypeScript/ESM, Node 24.22.2 or later, node:sqlite behind a storage boundary, Node's test runner, Docker, Kestra OSS/H2, AHP, BB Plugin SDK, Svelte/Vite/shadcn-svelte, Vitest and Playwright for the UI.

**Spec:** [Approved design](../specs/2026-11-03-local-software-factory-design.md).

## Global Constraints

- Exactly three public commands: setup, next, and uninstall.
- Copilot and Codex; Claude is outside this release.
- All four dashboard surfaces in the first usable release; owner/provider combinations are capability-dependent.
- Kestra OSS, setup-managed pinned containers, persistent H2; SQLite owns factory state.
- User-login startup on Linux/macOS/Windows; initial takt 60 seconds; missed ticks are discarded.
- Each recipe and task has exactly one tag; generated tasks inherit the creating recipe's tag.
- Independent 0–100 priorities; 90/10 yields nine T1 starts, then one T2; no normalization to 100.
- No discovery subsystem, role, allowance, or backlog target.
- Manual submission/lease-release dispatch is immediate, respects limits, and does not consume weighted turns.
- Defaults: one active run globally, 30 active minutes per attempt, 100 starts per local day, two transient retries.
- Native owner/provider fixed after start; preserve native identity and workspace on continuation/retry.
- Four finish policies; bypass only when explicitly selected and already authorized by GitHub.
- Recipes choose context freely; usage reporting is not a factory context budget.
- Required isolation must be verified; unsupported combinations stay blocked.
- Use the approved GitHub-style mockup; production components use shadcn-svelte.
- Runtime packages must work without a sibling checkout, Bun, or a developer cache.

## Review Focus

These five conditions must be pinned in their owning task, not left to final review:

1. RF1: Spaces, Unicode, shell characters, and hostile repository metadata must not change subprocess arguments or escape a workspace. Tests: C7, E6, U6.
2. RF2: Changed gh identity, revoked credentials, SSO denial, and temporary outages must not silently switch accounts or launch a new login. Tests: C6.
3. RF3: Lost replies after native creation, workflow start, PR creation, or merge must reconcile the existing effect. Tests: P2, P3, E2, E5, C8.
4. RF4: Symlinks, IPv6/DNS alternatives, container settings, and client-contributed tools must not bypass capability restrictions. Tests: P4, E1, E3.
5. RF5: Sleep, local-day/DST rollover, and wall-clock changes must not replay ticks, reset active time incorrectly, or grant excess starts. Tests: C3, C4, E6.

---

## Plan structure and order

The specification spans independently testable subsystems. Use the linked plans
as one coordinated implementation, not separate product milestones.

| Order | Plan | Deliverable |
| --- | --- | --- |
| 1 | [01 — Contracts and feasibility](2026-11-03-factory/01-contracts-and-proofs.md) | Versioned contracts and live integration evidence |
| 2 | [02 — State and scheduling](2026-11-03-factory/02-state-and-scheduling.md) | Tested state machine, scheduler, API, GitHub and Git operations |
| 3 | [03 — Orchestration and owners](2026-11-03-factory/03-orchestration-and-owners.md) | Isolated Kestra workflows, native adapters, service and three-command CLI |
| 4 | [04 — UI and delivery](2026-11-03-factory/04-ui-and-delivery.md) | Shared production UI, all dashboard adapters, installable artifacts |

Complete P1–P5 before broad implementation. Fixture-only tests cannot satisfy a
live feasibility gate. Missing credentials/hosts yield `blocked` evidence, not a
passing skip. A failed product-critical gate stops its dependent work and returns
the concrete incompatibility to the user.

C1–C8 can be verified with explicit fake owner/workflow ports. E5 replaces those
ports with real implementations. U1–U4 can use a contract-valid API fixture;
U5/U6 must use real adapters/service. Do not present these intermediate
deliverables as the user's first usable release.

Execution requires isolated working checkouts created through the execution
workflow. Do not move this thread or alter existing checkout contents just to
write the plan. Commit each reviewed task in its owning repository.

The current host reports Node 22.21.1 and Bun 1.4.4. P1 must select a verified,
user-scoped Node 24.22.2-or-later runtime in the execution environment before
running backend tests. Do not replace the global Node installation as a side
effect. The published CLI checks its minimum runtime before importing SQLite.

## Repository and file map

`runner/` means the ai4devops-sf repository; `canvas/` means
ai4devops-sf-canvas. All task paths are repository-relative with this prefix.
Do not create a third project or require symlinks between the repositories.

| Location | Responsibility |
| --- | --- |
| runner/src/contracts/ | Domain schemas, native-owner protocol, defaults and validation |
| runner/protocol/ | Generated OpenAPI/JSON Schema and compatibility fixtures |
| runner/probes/ | Executable native/Kestra/isolation/dashboard feasibility checks |
| runner/src/storage/ | Migrations, typed repositories, transactions and outbox |
| runner/src/scheduling/ | Rotation, admission, quotas, leases and lifecycle |
| runner/src/github/ | Auth resolution, sanitized capabilities and PR closeout |
| runner/src/workspaces/ | Managed clones, task worktrees and resume validation |
| runner/src/recipes/ | Restricted Kestra validation, revision registry and task materialization |
| runner/src/kestra/ | Pinned deployment, executions, events, Pause and reconciliation |
| runner/src/broker/ | Attempt capabilities and narrow worker operations |
| runner/src/owners/ | AHP adapter and authenticated BB/native bridge clients |
| runner/src/service/ | Local API, event stream, runtime coordination and private entry |
| runner/src/install/ and src/cli/ | Locator, startup adapters, install transaction and command routing |
| runner/scripts/ and release/ | Generation, packaging, manifests and platform verification |
| canvas/src/lib/api/ | Generated wire types and typed client; no storage/credential imports |
| canvas/src/lib/features/ | Repository, task, recipe, settings and attention flows |
| canvas/src/lib/components/ui/ | shadcn-svelte components and GitHub token mapping |
| canvas/adapters/ | Standalone, Canvas extension and BB entry/bridge wrappers |
| canvas/tests/ | Component, browser and adapter tests |
| canvas/docs/superpowers/mockups/ | Approved reference; never production runtime code |

## Shared interfaces: define these in P1

Use named TypeScript domain types plus matching runtime JSON Schemas.
IDs are opaque strings; timestamps are ISO UTC strings; durations are milliseconds.

~~~ts
type ProviderId = "copilot" | "codex";
type FinishPolicy = "result" | "pr" | "merge_ci" | "merge_bypass";
type TaskStatus = "queued" | "running" | "waiting_input" | "waiting_ci"
  | "needs_attention" | "completed" | "failed" | "cancelled";
type TaskSource = "manual" | "automatic" | "recipe";
interface Clock {
  wallNow(): Date;
  monotonicMs(): number;
  localDayKey(at: Date): string;
}
interface FactoryConfig {
  schemaVersion: 1; factoryDir: string; taktSeconds: number;
  limits: { concurrency: number; activeMinutes: number;
    startsPerDay: number; transientRetries: number };
  defaultOwnerId: string; defaultProviderId: ProviderId;
}
interface RequiredCapabilities {
  paths: { root: string; mode: "read" | "write" }[];
  tools: string[]; networkDestinations: string[]; credentialRefs: string[];
  allowedFinishPolicies: FinishPolicy[];
}
interface NativeIdentity {
  ownerId: string; providerId: ProviderId; sessionId: string; chatId?: string;
}
interface TaskSpec {
  id: string; parentId?: string; repositoryId: string;
  recipeId: string; recipeRevision: string; tagId: string; source: TaskSource;
  title: string; description: string; goal: string; acceptanceCriteria: string[];
  skills: string[]; tools: string[]; context: unknown;
  finishPolicy: FinishPolicy; ownerId: string; providerId: ProviderId;
  required: RequiredCapabilities;
}
interface CreateTaskRequest {
  title: string; description: string; recipeId: string; repositoryIds: string[];
  finishPolicy?: FinishPolicy; ownerId?: string; providerId?: ProviderId;
}
interface NativeStart {
  idempotencyKey: string; attemptId: string; task: TaskSpec;
  workspacePath: string; baseSha: string; fence: number; profileId: string;
}
interface CapabilityReport {
  ready: boolean; reasons: string[]; supportedProviders: ProviderId[];
  verifiedProfileIds: string[]; version: string;
}
interface NativeSnapshot {
  identity: NativeIdentity; state: "active" | "waiting" | "idle" | "lost";
  inputs: { id: string; schema: object; prompt: string }[];
  usage?: { inputTokens?: number; outputTokens?: number; estimated: boolean };
}
interface NativeOwner {
  capabilities(required: RequiredCapabilities): Promise<CapabilityReport>;
  ensureStarted(): Promise<void>;
  ensureSession(start: NativeStart): Promise<NativeIdentity>;
  snapshot(identity: NativeIdentity): Promise<NativeSnapshot>;
  send(identity: NativeIdentity, input: object, idempotencyKey: string): Promise<void>;
  quiesce(identity: NativeIdentity): Promise<"stopped" | "waiting" | "unknown">;
  open(identity: NativeIdentity): Promise<{ uri?: string }>;
  subscribe(onEvent: (event: OwnerEvent) => void): () => void;
}
interface TaskResult {
  attemptId: string; summary: string; evidence: string[]; createdTaskIds: string[];
  outcome: "result" | "changes" | "needs_input"; headSha?: string;
}
interface ProbeEvidence {
  name: string; mode: "fixture" | "live";
  status: "passed" | "failed" | "blocked"; versions: Record<string, string>;
  assertions: { name: string; passed: boolean }[]; artifacts: string[];
}
~~~

P1 also defines RecipeContract/RecipeRevision, TaskRecord/FactorySnapshot,
Attempt, AttentionRequest, ActorScope, FindingInput, ExecutionDefaults,
FactoryEvent, Grant, ProfileSpec/ProfileEvidence, ProbeOptions,
WorkflowStart/WorkflowIdentity/WorkflowSnapshot, OwnerEvent and OwnerRpc. Their
schemas must express the spec's complete fields; later task steps name the
methods that operate on them. OwnerEvent covers snapshots, input, activity,
usage, native identity and connection loss; it never equates idle with success.
An owner RPC method maps one-to-one to NativeOwner and carries request identity.
RotationCursor and WeightSnapshot are internal scheduling types owned by C2.
Automatic scheduling treats task sources automatic and recipe identically;
manual is the only source that bypasses rotation.

ProbeOptions carries mode, allowLive, scratchRepo, outputDir, and optional
endpoint/provider. Fixture mode is explicitly marked and cannot satisfy gates.
Required evidence IDs are vscode-copilot, vscode-codex, bb-codex-isolated,
kestra-oss-h2, dashboard-standalone, dashboard-vscode, dashboard-copilot-app,
dashboard-bb, plus isolation evidence for each advertised owner/provider.
Copilot App execution-owner evidence is optional until advertised.

Use a strict `variables.sf` metadata object inside standard Kestra YAML, subject
to P4's upstream-schema proof. Keys: schemaVersion, recipeId, displayName, tagId,
inputSchema, taskTemplate, required, compatibleOwners, compatibleProviders,
defaultFinishPolicy. A necessary technical mapping correction in P4 must update
this contract and its fixtures together; it must not create a second workflow DSL.

## API boundary

P1 specifies and C5 implements these authenticated version-1 operations:

- Snapshot/health/events: GET /v1/health, /v1/snapshot, /v1/events.
- Settings: GET/PATCH /v1/settings.
- Repositories: GET /v1/repositories; PATCH /v1/repositories/:id; PATCH
  /v1/repositories/:id/weights; GET /v1/repositories/:id/rotation-preview.
- Tags: POST /v1/tags; PATCH/DELETE /v1/tags/:id;
  POST /v1/tags/:id/archive.
- Tasks: GET/POST /v1/tasks; GET/PATCH/DELETE /v1/tasks/:id.
- Recipes: GET/POST /v1/recipes; POST /v1/recipes/validate;
  POST /v1/recipes/:id/revisions; PATCH /v1/recipes/:id.
- Control: POST /v1/dispatch, /v1/attention/:id/respond,
  /v1/tasks/:id/takeover, /v1/repositories/:id/return-control,
  /v1/tasks/:id/open-native.
- Auth: POST /v1/auth/probe and /v1/auth/device-flow; authenticated polling and
  completion use the documented device flow, never a browser-supplied secret.

Worker broker endpoints are separate, attempt-authenticated equivalents for
task CRUD, finding upsert, native start/continuation, results, artifacts and
attention. They cannot call browser/admin operations. Browser sessions cannot
register trusted native owner bridges.

Errors use `{code, message, recovery, retryable}` with no raw tokens. Mutations
accept idempotency keys; versioned updates reject stale revisions. Events have
a monotonic sequence and resume cursor. Stale event cursors require a snapshot
refresh, never re-execution of an action.

## Test and release conventions

Runner: Node tests via `npm test -- tests/path.test.ts`, production build via
`npm run build`, type checks via `npm run typecheck`. P1 supplies these scripts,
package-lock.json, ESM configuration and TypeScript source-extension rewriting.
Distribute compiled JavaScript, not TypeScript in node_modules.

Canvas: `npm test -- path` uses Vitest; `npm run test:e2e -- path` uses
Playwright; `npm run check` and `npm run build` cover types and production assets.
P3/P5 establish the minimal probe package; U1 extends its production commands.
Each task ends with its focused tests and a
commit; broaden testing when a new integration is introduced.

Live probes use explicitly designated scratch local repositories, isolated
environments and supported existing provider authentication. Do not mutate a
production repository or create/merge public PRs as a convenient test fixture.
Full GitHub write smoke tests require a user-designated disposable repository.
Never store credentials or unsanitized logs in evidence.
Each live probe command passes `--live --scratch-repo tests/.scratch/probe-repo`.
Probe tooling creates that ignored scratch repo explicitly, writes sanitized
reports under release/evidence, and records fixture mode separately. P2–P5 add
their named npm scripts; gates:check runs scripts/check-gates.ts. Test assertions
below use task-local arranged fixtures unless a shared helper is named.

No implementation is performed by this planning task. The next decision is
review and execution method. Registry publication is separate from producing
reviewable tarballs/adapters and requires the publisher's configured identity,
package rights, license choice, and explicit publication instruction.

## Spec coverage

| Design area | Owning tasks |
| --- | --- |
| Contracts, independent checkouts and version compatibility | P1, U1, U6 |
| Live native execution, four mounts and isolation proof | P2–P5 |
| State, task CRUD, deduplication and tag history | C1, E1, U2 |
| Weighted rotation, manual priority and recipe fairness | C2, C3, U2 |
| Limits, leases, retries, input and takeover | C3, C4, E6, U3 |
| Existing GitHub authentication and App fallback | C6, U1 |
| Managed clones/worktrees and safe resumption | C7, C4 |
| Four verified finish policies | C8, E6, U3 |
| Restricted Kestra, H2, capabilities and context freedom | E1–E3 |
| Native owner adapters and durable coordination | E4–E6 |
| Setup, next, login startup, moves and uninstall | E7, E8, U6 |
| Approved production UI, authoring and all adapters | U1–U5 |
| Portable artifacts and full release acceptance | U6 |

## Planning sources

Node 24 supports type-stripped TypeScript tests; compiled packages use
JavaScript. [Node TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html),
[TypeScript import rewriting](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html).
node:sqlite is isolated behind storage because its Node 24 API is currently
release-candidate status; pin and verify it across release targets.
[Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
Owner, Kestra, GitHub and UI primary references are in the approved spec.
