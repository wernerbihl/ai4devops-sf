# State and Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a durable local API whose scheduling, leases and GitHub side effects follow the approved rules.

**Architecture:** Keep pure selection separate from transactional reservation and external effects. SQLite is authoritative; native/workflow effects are accessed through injected ports and reconciled through a durable outbox.

**Tech Stack:** TypeScript/Node, node:sqlite, Node HTTP/SSE, Git/gh subprocesses, contract schemas.

**Spec:** [Approved design](../../specs/2026-11-03-local-software-factory-design.md); [master contracts](../2026-11-03-software-factory.md). Requires P1–P5.

## Global Constraints

All master constraints apply. In particular: independent weights, manual priority,
no discovery lane, immutable running identity, one active writer per repo, and
the exact `60/1/30/100/2` defaults.

## Review Focus

RF1: C7. RF2: C6. RF3: C8. RF5: C3/C4. Local API authentication is exercised
in C5 rather than inferred from binding to loopback.

---

### C1: Durable state, revisions and controlled CRUD

**Files:** Create runner/src/storage/{database,migrate,store,tags,tasks,recipes,outbox}.ts,
src/storage/migrations/001_initial.sql, tests/storage/store.test.ts,
tests/helpers/{store,fixtures,clock}.ts.

**Interfaces:** `openStore(path: string): FactoryStore`; `close(): void`;
`snapshot(): FactorySnapshot`; `createTasks(request: CreateTaskRequest,
actor: ActorScope, key: string): TaskSpec[]`; `upsertFinding(input: FindingInput,
actor: ActorScope, key: string): TaskSpec`; `archiveTag(id, replacementId): void`.
P1 supplies wire types; this task defines typed storage methods consumed by
C3/C4. `createFixture()` returns a temporary store, fake Clock and seeded
repository/recipe/tasks; it never changes the user's home.

- [ ] Write `persists_revisions_and_deduplicates_open_findings`. Assert duplicate idempotency keys return the same child IDs; the same repo/recipe/finding key reuses an open task; a closed recurrence creates a linked task; reopening the DB preserves immutable revisions.
~~~ts
assert.equal(repeatedFinding.id, firstFinding.id);
assert.notEqual(closedRecurrence.id, firstFinding.id);
assert.equal(reopenedTask.recipeRevision, originalRevision);
~~~
- [ ] Write `archives_used_tags_without_rewriting_history`: queued work and active recipes are reassigned, historical completed references remain, and a running revision is unchanged. Reject missing replacement and attempts to mutate unrelated tasks through recipe scope.
- [ ] Add `seeds_default_tags_without_reserving_categories`: assert exactly Performance, Bug Fixes, Features, Wiz Fixes, SonarQube Fixes, Research, Improve Codebase Quality on first install; subsequent install preserves user-created tags and does not duplicate defaults.
- [ ] Run `npm test -- tests/storage/store.test.ts`; expect missing store behavior.
- [ ] Implement transactional migrations, foreign keys, WAL, unique keys and revision storage. Store recipe and task tags as single foreign keys. Task creation uses an injected recipe materializer until E1 supplies it; validate its TaskSpec output.
- [ ] Run focused tests and typecheck; commit `feat: add durable factory state and task CRUD` with src/storage, tests/storage, helpers and contract changes.

### C2: Independent batched weighted rotation

**Files:** Create runner/src/scheduling/{rotation,rotation-types}.ts,
tests/scheduling/rotation.test.ts.

**Interfaces:** `selectAutomaticTag(weights: WeightSnapshot,
cursor: RotationCursor | null, available: ReadonlySet<string>): RotationChoice | null`.
WeightSnapshot has revision and entries `{tagId, value, createdOrder}`.
RotationCursor stores weightsVersion, reduced cycle quotas, tagIndex and
remaining quota. RotationChoice has tagId and cursorAfterStart.
`previewRotation(weights, cursor, available, count): string[]` is read-only.

- [ ] Write `matches_requested_batched_round_robin` with these assertions:
~~~ts
assert.deepEqual(turns90_10, [...Array(9).fill("T1"), "T2"]);
assert.deepEqual(turns80_50, [...Array(8).fill("T1"), ...Array(5).fill("T2")]);
assert.deepEqual(otherWeightsAfterEditingT1, otherWeightsBefore);
~~~
  Derive turns by repeatedly applying the returned cursor; no scheduler mocks.
- [ ] Add zero/all-zero, stable ties, unavailable tags without catch-up debt, restart serialization, and weight-revision reset cases. Assert preview never mutates its input cursor.
- [ ] Run `npm test -- tests/scheduling/rotation.test.ts`; expect missing rotation behavior.
- [ ] Implement GCD-reduced batched cycles in descending weight order. Skip unavailable work in bounded traversal; never normalize values or accrue missed quota.
- [ ] Run focused tests; commit `feat: implement persistent weighted tag rotation`.

### C3: Atomic admission, immediate manual work and quotas

**Files:** Create runner/src/scheduling/{admission,quotas,eligibility}.ts,
tests/scheduling/admission.test.ts; extend storage transaction methods.

**Interfaces:** `createScheduler(deps: SchedulerDeps): Scheduler`;
`Scheduler.dispatch(trigger: "takt" | "manual" | "resume" | "lease_released"):
Promise<DispatchResult>`. SchedulerDeps supplies store, Clock, readiness,
recipe materialization and workflow-start ports. DispatchResult is started
with attemptId, or noop with code/recovery.

Store methods: `reserveStart(candidate, dayKey): Reservation`,
`confirmStart(reservationId, externalIdentity): void`,
`releaseUnstarted(reservationId): void`. Reservation includes task, attempt,
quota reservation, proposed rotation and fenced lease.
DispatchResult uses kind `started` with attemptId or `noop` with code/recovery.

- [ ] Write `concurrent_dispatch_starts_one_manual_task`: race 20 next/manual calls against one ready manual task plus automatic candidates; assert one attempt/lease/slot, manual selection and unchanged automatic cursor.
~~~ts
assert.equal(results.filter(result => result.kind === "started").length, 1);
assert.equal(startedTask.id, manualTask.id);
assert.deepEqual(rotationAfterManualStart, rotationBeforeManualStart);
~~~
- [ ] Write `selects_oldest_serviced_repo_then_oldest_task_or_recipe`: prove repo fairness, queued-before-fresh and least-recent recipe rotation. Manual work can use an automation-inactive repo; a human-controlled repo stays excluded.
- [ ] Write RF5 `local_day_limits_and_sleep_do_not_replay`: inject a 23/25-hour local day, wall-clock reversal, 100 confirmed starts and one pending reservation. Assert quota cannot oversubscribe; a failed preflight charges nothing; no tick backlog is created.
- [ ] Run `npm test -- tests/scheduling/admission.test.ts`; expect failing admission behavior.
- [ ] Implement reservation in a short immediate transaction, with no network await inside it. Confirm counters/cursor exactly once after proven external start; unknown launch retains reservations for reconciliation. A definitive no-launch releases reservations without advancing rotation.
- [ ] Run focused tests; commit `feat: add atomic dispatch and manual priority`.

### C4: Lifecycle, fencing, continuation and native takeover

**Files:** Create runner/src/scheduling/{lifecycle,leases,recovery}.ts,
tests/scheduling/lifecycle.test.ts; extend storage/outbox.

**Interfaces:** `applyOwnerEvent(attemptId, event: OwnerEvent): Promise<void>`;
`requestTakeover(taskId): Promise<void>`; `returnControl(repositoryId): Promise<void>`;
`resumeInput(requestId, value, key): Promise<void>`;
`retryTransient(attemptId, failure): Promise<Attempt | null>`.
FactoryStore persists lease fences, pending actions and active-time segments.

- [ ] Write `expired_lease_does_not_admit_a_second_native_writer`. Assert a lost owner remains blocked, stale-fence mutations fail, and only proven stopped/waiting identity can release the lease.
- [ ] Write `human_resume_preserves_identity_and_retry_is_charged`. Assert input waiting releases capacity, continuation keeps attempt/session/worktree and does not charge another start; two transient retries reuse the native identity but charge new attempts; a third becomes attention.
~~~ts
assert.deepEqual(identityAfterResume, originalIdentity);
assert.equal(startsAfterHumanResume, startsBeforeHumanResume);
assert.equal(startsAfterFirstRetry, startsBeforeHumanResume + 1);
~~~
- [ ] Write RF5 `active_time_uses_monotonic_segments`: human/CI waiting is excluded; 30 active minutes quiesces to attention; wall-clock jumps do not extend execution. Assert takeover blocks automatic turns and return-control revalidates before dispatch.
- [ ] Run `npm test -- tests/scheduling/lifecycle.test.ts`; expect failures.
- [ ] Implement the lifecycle and durable action journal. Require quiescence before release and before native handoff; idle alone does not complete a task. Reconnect reconciles snapshots before replaying outbox actions.
- [ ] Run focused tests; commit `feat: enforce native lifecycle and repository fencing`.

### C5: Protected local API and resumable events

**Files:** Create runner/src/service/{api,session,events,routes,snapshot}.ts,
tests/service/api.test.ts, tests/helpers/fake-ports.ts.

**Interfaces:** `startApi(deps: ApiDeps): Promise<ApiServer>`;
`ApiServer.close(): Promise<void>`. ApiDeps includes store, scheduler,
lifecycle/auth/recipe/owner ports and session policy. Implements all master
routes against P1's schema and exports sanitized FactorySnapshot.

- [ ] Write `requires_pairing_origin_and_csrf_for_mutations`: reject unpaired clients, unapproved origins, missing CSRF, stale entity revisions and attempted browser registration of an owner bridge; bind only loopback.
~~~ts
assert.equal(unpairedResponse.status, 401);
assert.equal(unapprovedOriginResponse.status, 403);
assert.equal(snapshotText.includes(fakeCredential), false);
~~~
- [ ] Write `manual_create_dispatches_and_sse_reconnect_refreshes`: submission triggers manual admission without a tick; event cursors resume once; a stale cursor returns reset-required without repeating a mutation. Assert snapshots/errors contain no credential values.
- [ ] Run `npm test -- tests/service/api.test.ts`; expect absent handlers.
- [ ] Implement authenticated browser sessions, native pairing/IPC boundary, request validation, idempotency, SSE and route delegation. A minimal Node HTTP router is sufficient; worker routes are not mounted on this listener.
- [ ] Run focused tests, protocol check and typecheck; commit `feat: expose authenticated factory API and events`.

### C6: Reuse existing GitHub identity, then App device flow

**Files:** Create runner/src/github/{auth,gh,credential-helper,device-flow,capabilities}.ts,
tests/github/auth.test.ts.

**Interfaces:** `resolveGitHubAuth(request: AuthRequest): Promise<AuthState>`;
`GitHubPort.request<T>(method, path, body?, key?): Promise<T>`;
`probeRepositoryAccess(repositoryId): Promise<RepositoryCapabilities>`.
AuthState.kind is connected, absent, repair_required, denied, or unavailable, with
sanitized account/source/recovery. Tokens stay behind the port.

- [ ] Write RF2 `keeps_identity_and_distinguishes_failures`: gh-active account mismatch requires attention; JSON status exit 0 plus error is not ready; 401/SSO/403/network/429 do not silently trigger App login. Only absent supported credentials offers fallback.
~~~ts
assert.equal(changedAccount.kind, "repair_required");
assert.equal(temporaryOutage.kind, "unavailable");
assert.equal(deviceFlowLaunchCount, 0);
~~~
- [ ] Write `reuses_gh_without_exposing_tokens` and `device_flow_refresh_needs_no_distributed_secret`. Assert SSH-only access is not API readiness, denied repo writes stay denied, and logs/UI never receive helper stdout credentials.
- [ ] Run `npm test -- tests/github/auth.test.ts`; expect missing auth resolution.
- [ ] Implement gh API delegation, noninteractive helper resolution and selected-identity binding, then documented App device flow. Do not embed the original OAuth ID as a GitHub App ID. Public App client configuration is a release prerequisite.
- [ ] Run focused tests; commit `feat: reuse GitHub authentication with App fallback`.

### C7: Managed clones and task workspaces

**Files:** Create runner/src/workspaces/{git,manager,revalidate}.ts,
tests/workspaces/manager.test.ts.

**Interfaces:** `prepareWorkspace(task: TaskSpec): Promise<Workspace>`;
`revalidateWorkspace(workspace: Workspace, expectedBase: string):
Promise<WorkspaceValidation>`. Workspace contains canonical path/baseSha;
WorkspaceValidation.kind is ready or needs_attention with retained changes.

- [ ] Write RF1 `handles_hostile_paths_without_shell_interpolation` using a local Git fixture with spaces, Unicode and shell punctuation. Assert literal arguments, managed-directory containment and no extra command/file creation.
~~~ts
assert.equal(gitInvocation.options.shell, false);
assert.equal(injectedMarkerExists, false);
assert.equal(resumeValidation.kind, "needs_attention");
~~~
- [ ] Write `resume_preserves_changes_and_rejects_escape_or_conflict`: independent task worktrees, symlink/reparse-point escape refusal, no shared user checkout mutation, and preserved uncommitted work after base drift.
- [ ] Run `npm test -- tests/workspaces/manager.test.ts`; expect missing workspace behavior.
- [ ] Implement argument-array subprocesses, repository identity checks and canonical-path validation. Broker credentials supply Git operations; do not embed credentials in stored remotes. Conflicts become attention, not discarded changes.
- [ ] Run focused tests; commit `feat: manage isolated task worktrees safely`.

### C8: Verified result, PR and merge closeout

**Files:** Create runner/src/github/{closeout,pull-requests,checks}.ts,
tests/github/closeout.test.ts.

**Interfaces:** `finishTask(task: TaskSpec, result: TaskResult):
Promise<CloseoutResult>`; CloseoutResult.kind is completed, waiting_ci or
needs_attention and includes verified PR/head/merge identity where applicable.
Consumes GitHubPort, store/outbox, workspace validation and lifecycle ports.

- [ ] Write `enforces_four_finish_policies_on_exact_head`: result-only needs no PR, PR-only never merges, merge-ci waits for current checks/rules, and only explicit merge_bypass requests bypass. GitHub refusal needs attention.
- [ ] Write RF3 `reconciles_lost_pr_and_merge_replies`: dropped response reuses the existing PR/merge; changed head invalidates old checks; merge-queue acceptance is not completion; untrusted output cannot upgrade authority. Native idle alone fails closeout.
~~~ts
assert.equal(createdPrCount, 1);
assert.equal(mergeRequest.headSha, validatedHeadSha);
assert.equal(queueAcceptedResult.kind, "waiting_ci");
~~~
- [ ] Run `npm test -- tests/github/closeout.test.ts`; expect failures.
- [ ] Implement stable operation markers/outbox reconciliation and SHA-pinned writes. Release the active repo lease only after the native writer is quiescent; CI monitoring itself does not consume an agent slot.
- [ ] Run focused tests and the full runner suite introduced so far; commit `feat: verify task results and GitHub closeout`.
