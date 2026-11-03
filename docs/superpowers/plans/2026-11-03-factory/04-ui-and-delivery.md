# Factory UI and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved shared interface in all four surfaces with independently installable artifacts.

**Architecture:** One Svelte application consumes the versioned factory protocol through injected transports. Thin host adapters supply authenticated connections, theme/resource handling and native navigation; credentials remain in the trusted backend.

**Tech Stack:** Svelte/Vite, shadcn-svelte, GitHub Primer tokens, Vitest/Testing Library, Playwright and the proven host SDK versions.

**Spec:** [Approved design](../../specs/2026-11-03-local-software-factory-design.md); [master interfaces](../2026-11-03-software-factory.md). UI reference: canvas/docs/superpowers/mockups/factory-dashboard.html and companion captures. Requires P1–P5; U5/U6 require the real E-task integrations.

## Global Constraints

All master constraints apply. Use production Svelte/shadcn components, not the
mockup HTML as runtime code. Preserve one tag, four finish options, independent
priorities, native handoff, all four surfaces and reported-only context usage.

## Review Focus

RF1: U6 package/install paths. U2 tests independent weights and stale updates;
U3 tests absent native identities; U4 tests hostile YAML; U5 tests mount/portal
boundaries and avoids exposing credentials in host frames.

---

### U1: Shared application, generated client and connection states

**Files:** Modify canvas/package.json, package-lock.json and tsconfig.json
from the probe package. Create vite.config.ts, vitest.config.ts, components.json,
.gitignore, index.html, src/{main.ts,App.svelte},
src/lib/api/{generated,client,transport}.ts, src/lib/state/factory.svelte.ts,
src/lib/theme/{primer.css,host.ts}, src/lib/components/ui/,
scripts/sync-protocol.ts, protocol/compatibility.json,
tests/app/connection.test.ts, playwright.config.ts.

**Interfaces:** `createFactoryClient(transport: Transport): FactoryClient`;
`mountFactoryUI(target: HTMLElement, options: AppOptions): Dispose`.
Transport has typed request/subscribe and is supplied by the host.
FactoryClient exposes the master API operations and sanitized FactorySnapshot.
AppOptions carries client, theme and native-navigation callbacks, never tokens.

- [ ] Write `handles_existing_auth_login_repair_and_offline_states`: show connected identity without redundant login; absent credentials offers App flow; denied/offline states preserve identity and offer the correct recovery. Incompatible protocol refuses mutation.
- [ ] Write `hydrates_and_resumes_events_without_duplicate_actions`: bootstrap snapshot, reconnect cursor, reset-required refresh and loading/empty states. Assert no token enters serializable app state.
~~~ts
expect(JSON.stringify(appState)).not.toContain(fakeCredential);
expect(mutationCallsAfterEventReconnect).toHaveLength(0);
expect(protocolMismatchAllowsMutation).toBe(false);
~~~
- [ ] Run `npm test -- tests/app/connection.test.ts`; expect missing app/client behavior after establishing Vitest scripts.
- [ ] Implement the shell/client and explicit schema-artifact sync. Provide dev/test/check/build/e2e scripts and a lockfile; no sibling source import. Configure the documented Vite/Svelte shadcn aliases and generate the required UI primitives. Map Primer colors/density/theme to shadcn tokens; scope styles and portals to the app root. Standalone development supports bun run dev.
- [ ] Run focused tests, `npm run check`, `npm run build` and `npm run protocol:check`; commit `feat: add shared factory app and versioned client`.

### U2: Repository accordions, priorities, tags and settings

**Files:** Create canvas/src/lib/features/repositories/{RepositoryList,RepositoryRow,PriorityControls}.svelte,
features/settings/{Settings,TagManager}.svelte,
tests/features/repositories.test.ts, tests/e2e/priorities.spec.ts.

**Interfaces:** Consumes FactoryClient repository/settings/tag methods.
PriorityControls accepts repositoryId, tag weights and read-only rotation
preview; updates send a single changed weight plus entity revision.
TagManager calls delete-unused or archive-with-replacement endpoints.

- [ ] Write `changes_one_priority_without_rebalancing_others` and `previews_nine_to_one_turns`:
~~~ts
expect(sentWeightPatch).toEqual({ tagId: "T1", value: 80, revision: 4 });
expect(otherTagValue).toBe(50);
expect(turnLabels).toEqual([...Array(9).fill("T1"), "T2"]);
~~~
  The server's canonical preview supplies the turn labels.
- [ ] Add activation/paused/interactive-control, all-zero, missing-work, stale-revision and tag CRUD/archive tests. Verify settings expose `60/1/30/100/2` defaults without creating discovery controls.
- [ ] Run `npm test -- tests/features/repositories.test.ts`; expect missing feature behavior.
- [ ] Implement the approved compact accordion layout, independent sliders, repository tasks link, settings and tags. Keep optimistic edits keyed by stable IDs and reconcile server rejection; never normalize or rewrite untouched values.
- [ ] Run component tests plus `npm run test:e2e -- tests/e2e/priorities.spec.ts`; commit `feat: manage repository priorities and factory settings`.

### U3: Tasks, attention and native conversation handoff

**Files:** Create canvas/src/lib/features/tasks/{TaskList,TaskDetail,AddTask}.svelte,
features/attention/AttentionList.svelte, features/tasks/NativeHandoff.svelte,
tests/features/tasks.test.ts, tests/e2e/tasks.spec.ts.

**Interfaces:** Consumes createTask, attention response, takeover/open-native and
return-control operations. AddTask emits CreateTaskRequest; its tag is derived
from the selected recipe, not separately multi-selected.

- [ ] Write `creates_linked_manual_work_with_four_finish_policies`: required fields, multiple repositories, one inherited tag, host/provider overrides filtered by capabilities, and immediate queued state.
- [ ] Write `hands_off_only_after_repo_pause_and_existing_identity`: disable native opening before a session exists; pause before navigation; failed pause does not open; missing native history becomes attention. Input response is not a takeover; explicit return-control refreshes readiness.
~~~ts
expect(openNativeBeforeStart.disabled).toBe(true);
expect(handoffCallOrder).toEqual(["takeover", "open-native"]);
expect(navigationCallsAfterFailedPause).toHaveLength(0);
~~~
- [ ] Write `shows_result_activity_and_available_usage_without_chat_clone`: result-only completion has no required PR; unavailable metrics stay unavailable; explicit bypass copy explains existing privileges and refusal.
- [ ] Run `npm test -- tests/features/tasks.test.ts`; expect missing flows.
- [ ] Implement approved list/detail/forms and the prominent Needs Attention region. Follow server transitions; never infer task completion from native idle or UI navigation.
- [ ] Run focused tests plus `npm run test:e2e -- tests/e2e/tasks.spec.ts`; commit `feat: add task and native intervention workflows`.

### U4: Recipe templates, YAML editing and import

**Files:** Create canvas/src/lib/features/recipes/{RecipeList,RecipeEditor,CapabilityGrants}.svelte,
tests/features/recipes.test.ts, tests/e2e/recipes.spec.ts.

**Interfaces:** Consumes list/create/revise/validate/activate recipe operations.
Validation returns schema errors, normalized metadata, revision hash and
capability readiness; save/activation binds the validated hash.

- [ ] Write `supports_template_edit_and_import_with_one_tag`: input file is text, tag is singular, generated tasks inherit it, and any edit invalidates the validation hash.
- [ ] Write `cannot_activate_stale_or_unsafe_yaml`: malformed/oversized/hostile YAML, server rejection, revoked grants and changed profile cannot be bypassed by a disabled-button state or stale response. No AI-generation feature is added.
~~~ts
expect(saveButtonAfterEdit.disabled).toBe(true);
expect(activationWithStaleHashAccepted).toBe(false);
expect(importedRecipe.tagId).toBe(selectedSingleTagId);
~~~
- [ ] Run `npm test -- tests/features/recipes.test.ts`; expect missing behavior.
- [ ] Implement the editor using shadcn controls and the E1 schema; show actionable field/line errors, immutable revisions and explicit requested capability grants. Validation/activation authority remains server-side.
- [ ] Run component tests plus `npm run test:e2e -- tests/e2e/recipes.spec.ts`; commit `feat: author and validate Kestra recipes`.

### U5: Production standalone, Canvas and BB adapters

**Files:** Create canvas/adapters/standalone/transport.ts,
adapters/canvas/{extension.mjs,manifest.json,resources.ts},
adapters/bb/{index.ts,frontend.tsx,SvelteMount.tsx},
scripts/build-adapters.ts, tests/adapters/adapters.test.ts.
Integrate E5's BB backend/owner-channel entry.

**Interfaces:** `createStandaloneTransport(config): Transport`;
`createCanvasTransport(parent): Transport`;
`registerFactoryPlugin(): PluginDefinition`. Each calls mountFactoryUI once,
propagates host theme, owns its disposal and delegates native navigation to the
configured owner. P5 supplies the proven entry/manifest contracts.

- [ ] Write `mounts_same_ui_and_disposes_per_host`: exact shared entry, theme changes, scoped overlays, no duplicate subscriptions and no global CSS reset of the parent host.
- [ ] Write `keeps_auth_in_trusted_transport_and_owner_selection_independent`: no long-lived credential in web frames, remote asset dependency or browser owner-registration route; Copilot App dashboard can route to VS Code/BB even when its execution-owner handlers are absent.
~~~ts
expect(mountedRootsAfterDispose).toBe(0);
expect(JSON.stringify(frameProps)).not.toContain(fakeCredential);
expect(submittedOwnerId).toBe(configuredOwnerId);
~~~
- [ ] Run `npm test -- tests/adapters/adapters.test.ts`; expect adapter failures.
- [ ] Implement the P5-proven Canvas extension for both VS Code and Copilot App, BB React wrapper mounting Svelte, and standalone same-origin/dev connection. Use host resource/CSP APIs and supported packaging, not a substituted generic webview.
- [ ] Run all four live mount checks against production bundles and E6; commit `feat: package shared factory UI for every host`.

### U6: Portable packages and full release acceptance

**Files:** Create runner/scripts/{package,verify-package,verify-install}.ts,
runner/tests/package/portable.test.ts, runner/.github/workflows/verify.yml;
canvas/scripts/{package,verify-package}.ts,
canvas/tests/e2e/release.spec.ts, canvas/.github/workflows/verify.yml;
update both manifests, release compatibility and user README files.

**Interfaces:** `verifyPackage(tarball: string, scratchRoot: string):
Promise<PackageReport>`; `verifyInstall(options: PlatformSmokeOptions):
Promise<InstallReport>`. Reports name exact artifacts, versions, platforms,
mandatory gates and blocked prerequisites. Canvas exports a versioned asset
distribution and host bundles; runner includes a compatible pinned distribution.

- [ ] Write RF1 `installs_from_tarballs_without_sibling_or_cache`: install built artifacts into a scratch path containing spaces/Unicode, start with only documented runtime prerequisites, and assert bundled UI, three commands and private daemon work without Bun or repo-relative imports.
~~~ts
assert.equal(packageReport.requiresSiblingCheckout, false);
assert.equal(packageReport.requiresBun, false);
assert.deepEqual(packageReport.commands, ["setup", "next", "uninstall"]);
~~~
- [ ] Write `cold_install_reconfigure_resume_and_owned_uninstall` against the real service: preserve history/native identities, user-login startup, tag rotation and manual priority, pause/input/retry, four closeout policies and cleanup.
- [ ] Run focused package/e2e tests; expect missing packaging/integration behavior.
- [ ] Implement builds, explicit package allowlists and artifact/schema compatibility checks. Test Node 24 and a supported newer Node runtime; run OS smoke on Linux/macOS/Windows. Inspect npm tarballs/host bundles for compiled entries, bundled assets, required runtime deps and absent credentials/caches. Record actual compatible versions.
- [ ] Run both repositories' type/check/build/test suites, protocol checks, all mandatory live gates, four production dashboard mounts, and platform smoke. Verify keyboard operation plus 1280px/390px light/dark screenshots against the approved mockup and assert scrollWidth <= clientWidth; batch corrections and confirm once.
- [ ] Exercise PR writes/CI/bypass acceptance only in a user-designated disposable GitHub repository. If none is designated, keep that live acceptance blocked rather than claim mock tests prove GitHub behavior. App device-flow fallback likewise requires the real publisher App configuration.
- [ ] Produce reviewable tarballs and adapter bundles, install instructions and an acceptance report. Do not publish a registry package or assign a license without the publisher's instruction/configuration. Commit each repository with `build: verify portable factory release artifacts`.

## Completion

The first usable release is complete only when all four dashboards, both
providers through verified owners, real isolation, three OS installation
paths and requested finish behaviors pass acceptance. Partial UI mounts,
fake owners, blocked gates or a successful tarball alone are insufficient.
