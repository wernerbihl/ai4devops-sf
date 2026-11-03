# Orchestration and Native Owners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run real restricted recipes/native tasks and provide the three-command local installation.

**Architecture:** Trusted controllers own Docker, Kestra and native bridge access. Workers receive attempt-scoped operations; the coordinator uses durable reservations and idempotent native/workflow identities.

**Tech Stack:** Node/TypeScript, Docker, pinned Kestra OSS/H2, AHP, BB SDK, per-user OS startup.

**Spec:** [Approved design](../../specs/2026-11-03-local-software-factory-design.md); [master contracts](../2026-11-03-software-factory.md). Requires P1–P5 and the C-task interfaces.

## Global Constraints

All master constraints apply. No raw DB access from recipes, unverified profile
fallback, arbitrary Kestra plugins, global pre-login service, or unpinned npx tick.

## Review Focus

RF4: E1/E3. RF3: E2/E6. RF1/RF5: E7/E8. Public host APIs and actual environment
verification must agree; an advertised permission mode is insufficient.

---

### E1: Recipe validator, registry and task materialization

**Files:** Create runner/src/recipes/{validate,registry,materialize,policy}.ts,
recipes/starter/{focused-feature,focused-bug-fix,scoped-quality}.yaml,
tests/recipes/recipes.test.ts.

**Interfaces:** `validateRecipe(yaml: string, grants: Grant[]): ValidatedRecipe`;
`saveRecipeRevision(input: ValidatedRecipe): RecipeRevision`;
`materializeTask(request: CreateTaskRequest, revision: RecipeRevision,
repositoryId: string, defaults: ExecutionDefaults): TaskSpec`.

- [ ] Write `materializes_one_tag_and_complete_task_without_extra_model_call`. Assert title/description plus the recipe's goal/criteria/input template form a valid TaskSpec; generated children inherit the tag; code defaults to pr and reporting can default to result; context is preserved without a factory token cap.
~~~ts
assert.equal(task.tagId, revision.tagId);
assert.deepEqual(task.context, suppliedContext);
assert.equal("contextBudget" in task, false);
~~~
- [ ] Write RF4 `rejects_recipe_control_plane_escape`: hostile plugins/runners/images, unsafe expressions/subflows, mounts/socket/privileged mode, malformed metadata, YAML alias expansion and oversized input fail validation. Editing a recipe never changes an existing revision.
- [ ] Run `npm test -- tests/recipes/recipes.test.ts`; expect missing validator/materializer failures.
- [ ] Implement the P4-proven native YAML subset and strict metadata schema. Resolve skills/tools by declared references; bind grants to a revision. Cap imported YAML at 512 KiB, validate structure before Kestra submission, and activate only validated revisions with approved grants.
- [ ] Run focused tests plus a starter-recipe live check against the pinned Kestra schema; commit `feat: validate and version factory recipes`.

### E2: Pinned Kestra deployment and execution client

**Files:** Create runner/src/kestra/{deployment,client,executions,pause}.ts,
runtime/kestra/{compose.yaml,application.yaml}, tests/kestra/client.test.ts.

**Interfaces:** `ensureKestra(installation: Installation): Promise<KestraHandle>`;
`KestraPort.ensureExecution(start: WorkflowStart): Promise<WorkflowIdentity>`;
`snapshot(identity): Promise<WorkflowSnapshot>`;
`resumeInput(identity, input, key): Promise<void>`; `stop(identity): Promise<void>`.
WorkflowStart includes attempt key, immutable recipe revision and broker grant;
P1 defines the wire identities, input and snapshot schema.

- [ ] Write `persists_h2_and_correlates_pause_inputs` with a restart fixture; assert factory SQLite cannot be substituted for H2 and native idle cannot complete the workflow.
- [ ] Write RF3 `finds_existing_execution_after_lost_start_reply`. Assert one execution per attempt key, pinned revision and typed resume idempotency.
~~~ts
assert.equal(executionCountForAttempt, 1);
assert.equal(resumedExecutionId, originalExecutionId);
assert.equal(actualRevision, pinnedRevision);
~~~
- [ ] Run `npm test -- tests/kestra/client.test.ts`; expect failures.
- [ ] Implement only the P4-proven OSS APIs/settings. Publish no database/admin/Docker endpoint to the browser or workers. Label owned containers and bind durable H2/storage under the selected installation.
- [ ] Run focused tests and `npm run probe:kestra -- --live --scratch-repo tests/.scratch/probe-repo` against this implementation; commit `feat: coordinate pinned local Kestra executions`.

### E3: Attempt broker and verified isolation profiles

**Files:** Create runner/src/broker/{server,capabilities,operations}.ts,
src/isolation/{profiles,verify}.ts, tests/broker/broker.test.ts,
tests/isolation/profiles.test.ts.

**Interfaces:** `issueAttemptCapability(attempt, grants): CapabilityToken`;
`authorizeAttempt(token, operation, target): ActorScope`;
`startWorkerBroker(deps): Promise<WorkerBroker>`;
`requireVerifiedProfile(start: NativeStart): Promise<ProfileEvidence>`.
Broker operations reconstruct sensitive fields from the reservation, not
worker-supplied owner/provider/path/finish values.

- [ ] Write `blocks_stale_or_cross_scope_worker_mutations`: reject expired/wrong-fence tokens, unrelated repos/tasks, tag or finish escalation, second concurrent native writers, direct admin routes and owner switching. Revoked attempts cannot submit results.
~~~ts
assert.throws(() => authorizeAttempt(staleToken, operation, target));
assert.equal(crossRepositoryMutationAllowed, false);
assert.equal(secondNativeWriterAllowed, false);
~~~
- [ ] Write RF4 `verifies_effective_boundary_not_declared_flags`: fail changed mounts/images/network, symlink escape, alternate egress and unapproved external client tools. Assert workers cannot read Docker socket, SQLite or host credentials.
- [ ] Run `npm test -- tests/broker/broker.test.ts tests/isolation/profiles.test.ts`; expect absent enforcement.
- [ ] Implement separate private broker networking, per-attempt signed capabilities, positive operation allowlists and P4-proven profiles. Revalidate effective settings before dispatch; mark unsupported tool restrictions blocked rather than degrading access.
- [ ] Run focused tests and live isolation probes for each advertised owner/provider; commit `feat: enforce attempt capabilities and isolated execution`.

### E4: Production VS Code Agent Host owner

**Files:** Create runner/src/owners/{vscode,ahp,navigation,registry}.ts,
tests/owners/vscode.test.ts.

**Interfaces:** `createVsCodeOwner(options: VsCodeOptions): NativeOwner`;
`OwnerRegistry.get(ownerId): NativeOwner`;
`OwnerRegistry.list(required): Promise<OwnerReadiness[]>`. VsCodeOptions
specifies authenticated endpoint/managed launcher, compatibility manifest and
verified profile resolver.

- [ ] Write `implements_native_owner_without_sdk_import`: replay P2 protocol fixtures through every NativeOwner method; assert unsupported providers/configurations and unverified isolation fail readiness.
- [ ] Write `opens_exact_identity_and_does_not_replace_missing_history`: verify the pinned native navigation format, original identity on retry and lost-session attention.
~~~ts
assert.deepEqual(retryIdentity, originalIdentity);
assert.equal(newSessionCountAfterLostHistory, 0);
assert.equal(missingHistoryNeedsAttention, true);
~~~
- [ ] Run `npm test -- tests/owners/vscode.test.ts`; expect missing adapter behavior.
- [ ] Implement against the exact P2 AHP version, provider-returned schemas and authenticated transport. Start a configured headless owner only through the supported managed path; connect its verified isolated environment.
- [ ] Run focused tests and both live P2 probes through this adapter; commit `feat: add VS Code native execution owner`.

### E5: Production BB owner bridge

**Files:** Create runner/src/owners/{bb,bridge-rpc}.ts,
canvas/adapters/bb/{backend,native-owner,owner-channel}.ts,
runner/tests/owners/bb.test.ts; extend canvas adapter package configuration.

**Interfaces:** `createBbOwner(channel: OwnerChannel): NativeOwner`;
`registerBbOwner(sdk: BbSdk, channel: OwnerChannel): Promise<Dispose>`.
OwnerChannel transports P1 OwnerRpc/OwnerEvent over authenticated local
IPC/backend pairing. It never relies on externally adopting an SDK session.

- [ ] Write `maps_native_threads_and_reconciles_without_event_replay`: assert thread ID persistence, interaction response, quiesce/retry/navigation, and snapshot recovery after reconnect.
- [ ] Write `rejects_dispatch_without_repo_admission_or_profile`: cover native follow-ups/steers/retries through BB admission hooks, unavailable Copilot, absent backend and changed environment verification.
~~~ts
assert.equal(capabilities.supportedProviders.includes("copilot"), false);
assert.equal(dispatchWithExpiredLeaseAllowed, false);
assert.deepEqual(reconnectedIdentity, originalIdentity);
~~~
- [ ] Run `npm test -- tests/owners/bb.test.ts` in runner; expect failures against the fake public SDK/channel.
- [ ] Implement only P3-proven public thread/provider/environment APIs. The plugin runs while its BB backend is available; unsupported auto-launch queues with attention. Browser clients cannot register the owner channel.
- [ ] Run focused tests and the P3 live probe using the production bridge; commit in both repositories with `feat: integrate BB-owned native task execution`.

### E6: Real runtime coordinator and crash reconciliation

**Files:** Create runner/src/service/{runtime,coordinator,reconcile,main}.ts,
tests/service/runtime.test.ts, tests/integration/task-lifecycle.test.ts.

**Interfaces:** `startRuntime(installation: Installation): Promise<FactoryRuntime>`;
`reconcileInstallation(runtime): Promise<ReconcileReport>`;
`FactoryRuntime.stop(): Promise<void>`. Wires C1–C8 and E1–E5 into C5 ApiDeps
and SchedulerDeps; no fake owner/workflow port is used in production.

- [ ] Write `runs_recipe_to_native_result_without_parallel_writer`: use real SQLite and process-level fixture services; verify reservation, Kestra identity, native work, input, result/CI closeout and release.
- [ ] Write RF3 `recovers_each_external_effect_boundary`: terminate between reservation/start, between native create/reply and between result/closeout acknowledgment. Assert one effect and preserved session/workspace on restart.
~~~ts
assert.equal(nativeSessionCount, 1);
assert.equal(workflowExecutionCount, 1);
assert.deepEqual(identityAfterRestart, identityBeforeRestart);
~~~
- [ ] Run `npm test -- tests/service/runtime.test.ts tests/integration/task-lifecycle.test.ts`; expect missing wiring/reconciliation behavior.
- [ ] Implement outbox-driven commands, stable idempotency, readiness/quota reservations and snapshot reconciliation. Keep unknown writers fenced. Track workflow, native and task completion separately; report unavailable usage explicitly.
- [ ] Run focused tests, all runner tests and a live scratch-repository result-only lifecycle for both providers; commit `feat: connect durable factory runtime`.

### E7: Three-command CLI and per-user login service

**Files:** Create runner/bin/ai4devops-sf.mjs,
src/cli/{main,setup,next}.ts,
src/install/{locator,plan,install,service-linux,service-macos,service-windows}.ts,
tests/install/install.test.ts, tests/cli/commands.test.ts.

**Interfaces:** `planInstall(answers: SetupAnswers): Promise<InstallPlan>`;
`applyInstall(plan: InstallPlan): Promise<Installation>`;
`locateInstallation(): Promise<Installation | null>`;
`runCli(argv: string[], io: CliIo): Promise<number>`.
SetupAnswers covers directory, takt and provider/owner configuration.
StartupAdapter has `install(plan)`, `start()`, `stop()`, `remove()` and `status()`.
main.ts exports `PUBLIC_COMMANDS = ["setup", "next", "uninstall"]` and
`parseCommand(argv: string[]): ParsedCommand`; ParsedCommand separates help
flags from command names.

- [ ] Write `offers_exactly_three_commands_and_restores_answers`: setup/next/uninstall only, help as a flag, stored defaults, valid multi-provider selection and Install (Y/n); no usable provider or Docker stops before mutations.
~~~ts
assert.deepEqual(PUBLIC_COMMANDS, ["setup", "next", "uninstall"]);
assert.throws(() => parseCommand(["daemon"]));
assert.equal(persistentMutationsBeforeConfirmation, 0);
~~~
- [ ] Add `old_node_gets_runtime_diagnostic_before_backend_import`: an older runtime receives a concise Node >=24.22.2 requirement and recovery, without a SQLite/import stack trace or installation mutation.
- [ ] Write RF1 `quotes_startup_paths_without_shell_evaluation` for spaces/Unicode on all OS adapters. Write RF5 `login_restart_drops_missed_ticks`: managed absolute entry, 60-second interval, no backlog, dependency readiness and no unpinned npx loop.
- [ ] Run `npm test -- tests/install/install.test.ts tests/cli/commands.test.ts`; expect missing command/startup behavior.
- [ ] Implement the private runtime entry, locator in standard OS app config, versioned runtime copy and user-login startup adapters. next starts the installed service if needed, then requests one dispatch. Display all directories/services/grants/limits before installation.
- [ ] Run focused tests plus temp-install startup smoke on Linux, macOS and Windows; commit `feat: install factory and user-login service`.

### E8: Reconfiguration, relocation and owned cleanup

**Files:** Create runner/src/install/{reconfigure,uninstall,backup}.ts,
src/cli/uninstall.ts, tests/install/reconfigure.test.ts.

**Interfaces:** `reconfigureInstallation(current, plan): Promise<Installation>`;
`uninstallInstallation(installation): Promise<CleanupReport>`.
CleanupReport lists removed owned resources and blocked live identities.

- [ ] Write `reconfigure_preserves_data_and_rolls_back_failed_healthcheck`: transactional backups, same installation identity, service replacement, immutable revisions and native IDs retained.
- [ ] Write RF1 `relocation_validates_native_workspace_paths`: unsupported unfinished-session moves leave the old installation intact with a recovery action. Write `cleanup_refuses_unknown_writer_and_preserves_shared_resources` for unrelated Docker, gh login, native apps and GitHub PRs.
~~~ts
assert.equal(oldInstallationStillExistsAfterBlockedMove, true);
assert.equal(sharedResourcesRemoved, 0);
assert.equal(credentialLogoutCalls, 0);
~~~
- [ ] Run `npm test -- tests/install/reconfigure.test.ts`; expect missing behavior.
- [ ] Implement stop-admission/quiesce, consistent SQLite/H2 backups, staged migration and rollback. Delete only labeled installation-owned resources after proven quiescence. Never infer a new native identity for a moved session.
- [ ] Run focused tests and the full runner suite; commit `feat: reconfigure and uninstall owned factory resources`.
