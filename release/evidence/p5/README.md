# P5 consolidated feasibility gate report — 2026-11-04

**BLOCKED. Product C/E/U work must not begin.** `npm run gates:check` exits **1** and returns `ready:false`. Three gates pass; eight required gate/coverage IDs remain blocked. Unit/DOM fixtures never count as native passes.

| Required evidence | Current result | Evidence / exact remaining prerequisite |
| --- | --- | --- |
| `vscode-copilot` | blocked | Corrected P2 native lifecycle rerun, full continuous tool audit, exact native input answer and selected UI identity; retained historical receipts are qualified. |
| `vscode-codex` | blocked | Last verified native model catalog had no available Codex models; usable models plus corrected lifecycle/selection proof are required. |
| `bb-codex-isolated` | blocked | Current SDK cannot deny initial inherited server GitHub/global credentials per machine; no verified isolated enrolled Codex lifecycle. |
| `kestra-oss-h2` | passed, imported current P4 proof | Original corrected `release/evidence/p4/kestra-fix1/` receipt and details are preserved under `upstream/`; only artifact paths change in `kestra-current.json`. This was not rerun in P5. |
| `dashboard-standalone` | passed | Real Chrome mount, resources, protected paired health, light/dark, contained overlay, enforced inline-script refusal, disposal and actual read-only native selection. |
| `dashboard-vscode` | blocked | Owned development host could not start: `vscodeinsiders-updating` mutex was still held after 30,867ms. No extension activation or Canvas DOM observed. Finish update naturally, reopen, reverify installed build/source, then feature/auth/initialized owned chat and full actual Canvas observations. |
| `dashboard-copilot-app` | blocked | No confirmed installed supported app/other-machine target or exact app version. User resource question remains pending; no substitute browser/VS Code pass. |
| `dashboard-bb` | passed | Installed public SDK nav panel mounted the same Svelte build; real RPC health, SDK theme mode, contained overlay, disposal and `useBbContext().threadId` plus actual route after public `toThread`. Local host has **no CSP header**; this is observed policy, not enforced-CSP/security proof. |
| `provider-copilot`, `provider-codex`, `profile-bb-codex` | blocked | Actual verified restricted native profiles for both providers and mandatory BB/Codex isolation are required. Empty profiles cannot pass. P4 worker/headless startup receipts are component proof only. |

The protected P1-shaped health fixture is temporary integration infrastructure. It does **not** complete C5 product API/auth/security. Release U6 must retest the actual production transports and deployed host policies.

## Reproduce / interpret the gate

Use official Node **24.22.2** for runner/canvas tooling. In the runner checkout:

```sh
PATH=/tmp/sf-p1-runtime/node-v24.22.2-linux-x64/bin:$PATH npm run gates:check
```

`manifest.json` explicitly selects eight required records with source, UTC assessment timestamp and SHA-256. No recursive discovery chooses old/duplicate P4/P2 receipts. `scripts/check-gates.ts` is the required assertion/version policy; arbitrary evidence JSON cannot lower it. All mandatory assertions must exist uniquely and be true; all selected evidence must validate as live/passed, have matching exact pinned version fields, unchanged receipt digests, and existing contained file artifacts. Missing, malformed, blocked, failed, fixture, incomplete, ambiguous, changed-digest or incompatible evidence blocks readiness. Absolute/out-of-directory artifact paths and directory artifacts fail.

`profiles` is the advertised execution-profile inventory, currently empty with explicit source qualification. Each nonempty entry supplies `specFile`, `evidenceFile`, `source`, `specSha256`, `evidenceSha256`. Runtime P1 ProfileSpec/ProfileEvidence schemas, matching owner/provider/profile/capabilities, compatible host/profile/image versions, unique probe IDs and the complete native restriction assertion set are required. Multiple compatible native probes may jointly prove restrictions; duplicate/invalid profiles cannot provide coverage. Current established pairs are VS Code/Copilot, VS Code/Codex and BB/Codex. No BB/Copilot or unestablished Copilot App execution-owner capability is invented. A future App owner needs an established supported contract before advertisement.

The Copilot App host pin is deliberately `UNRESOLVED`; even a receipt echoing that string cannot pass. Replace a host baseline only after verifying actual installed version, public contracts and live behavior. An editor update also requires rechecking the old VS Code `1.145.0-insider` / `3c0ec3a089398503a462029e7cc2a5749df5169a` baseline.

Exact assertion groups and version pins are in the checker; detailed external prerequisites are in [remaining-prerequisites.json](remaining-prerequisites.json), and official/source provenance is in [sources.json](sources.json).

## Actual mounts and source provenance

The single `canvas/probes/shared/App.svelte` fixture compiles to `dist/shared/probe.js` / `probe.css`. Standalone and both Canvas wrappers serve those files; BB's React/public-SDK wrapper imports those same compiled files. BB's host provides React and SDK runtime shims. [build-assets.json](build-assets.json) records final asset digests and verifies no backend bearer implementation/Node crypto/runner import in the frontend build.

Actual live versions: Chrome **152.0.0.0**, build/server Node **24.22.2**, Svelte **5.57.3**, Vite **8.3.5**; BB **0.48.1**, SDK **0.6.104**, backend Node **22.21.1**. Tooling pins also include Vitest **5.1.0**, Svelte Vite plugin **7.3.1**, jsdom **30.1.3**, React **19.2.4**, React types **19.2.14**, Testing Library React **16.3.2**. Canvas SDK current public source was inspected at `90f11bf1401b48721f4d4e6354e95aefcc3c7943`; published npm `1.0.28` lookup is not an installed-host attestation. Actual App version remains unknown.

The genuine Canvas entry uses the runtime-injected `@github/copilot-sdk/extension`, `createCanvas`, `joinSession({canvases})`, `open` returning a URL and `onClose`. It creates no independent SDK session, fake host bridge or model turn. Official Copilot App documentation confirms repository-scoped `.github/extensions` discovery. The exact VS Code source confirms initialized local Copilot chats, Canvas enablement and public no-input UI activation paths. Its application setting defaults false with an automatic experiment; no effective setting/auth state was inferred from that default.

Standalone observations: [standalone-browser.json](standalone-browser.json), [standalone-native.json](standalone-native.json), [standalone-dark.jpg](standalone-dark.jpg). HTTP health without private backend bearer returned 401; paired bridge returned 200; the HttpOnly pairing value was absent from JavaScript cookies; all three assets returned 200. A real `securitypolicyviolation` reported `script-src-elem` and the injected inline script did not execute. Light/dark and contained overlay were observed, then roots=0 and portals=0.

BB observations: [bb-browser.json](bb-browser.json), [bb-runtime.json](bb-runtime.json). Native selection was observed through the public probe-owned overlay's `useBbContext().threadId` **and** actual selected URL after `toThread`, then the browser returned to the probe. Only the explicitly authorized current conversation was used, read-only. Standalone navigated to that **already observed** URL and observed the same native SDK selection. No helper thread write API or model input was used; this routing proof makes no factory ownership/lifecycle/isolation claim. No transcript contents are included in these sanitized receipts.

The bounded VS Code attempt staged only trusted fixture files, an isolated profile and public-API diagnostic extension. [vscode-owned-stage.json](vscode-owned-stage.json), [vscode-owned-extension.cjs](vscode-owned-extension.cjs), [vscode-owned-launch.ps1](vscode-owned-launch.ps1), [vscode-launch-error.txt](vscode-launch-error.txt), [vscode-uia.json](vscode-uia.json) preserve the exact attempt. The public command was `aiCustomization.openManagementEditor` with `canvases`; it never activated. UI Automation found no owned-title window, and no extension result was created. The updater and existing editor profiles/processes were left unchanged. There was no model turn, copied auth store or new login.

The earlier no-turn BB create attempt was rejected by the actual API with HTTP400 `input must contain at least one entry`; it returned no thread ID, and no prompt was substituted. Its pending marker was reconciled/cleared; final code removes that unsupported create path entirely and has only explicit read-only pairing/unpairing. [empty-thread-attempt.json](empty-thread-attempt.json) preserves this limitation.

## Verification and TDD

All final source validation passed:

- Runner `npm test`: **86/86**, including **21/21** gate cases; `npm run typecheck`, `npm run build`, `npm run protocol:check`, `git diff --check`: exit0.
- Canvas `npm test`: **24/24** existing/new backend cases and **6/6** Svelte/DOM/real HTTP cases; `npm run build:probe` builds the Svelte library, typechecks and builds public BB server/frontend artifacts: exit0. `git diff --check`: exit0.
- `npm run gates:check`: **exit1**, `ready:false`; passed `kestra-oss-h2`, `dashboard-standalone`, `dashboard-bb`; eight remaining blocked IDs above. This is the intended conservative result.

Required initial RED runs were exactly runner `npm test -- tests/probes/gates.test.ts` (missing `scripts/check-gates.ts`) and canvas `npm test -- tests/probes/mount.test.ts` (missing shared mount implementation). [gates-red.txt](gates-red.txt) and [mount-red.txt](mount-red.txt) preserve the failures. Additional RED receipts cover the missing protected transport, read-only pair RPC, concurrent cookie collision and P1 profile object-order/multiple-probe contract. [gates-green.txt](gates-green.txt), [transport-green.txt](transport-green.txt), [runner-full-tests.txt](runner-full-tests.txt), [canvas-full-tests.txt](canvas-full-tests.txt), [canvas-build.txt](canvas-build.txt) preserve GREEN results. Captured text output has trailing whitespace/terminal blank lines normalized for diff-clean committed receipts; messages and counts are unchanged.

Self-review fixed a reload-only CJS/top-level-await issue by splitting the server library and CLI; replaced guessed BB CSS-class theme detection with the public SDK theme hook; fixed same-host simultaneous mount cookie collisions using per-server names; ensured clean test invocation builds the generated shared artifact; preserved the P3 public-import scan with explicit public test/frontend package allowances; aligned profiles with P1 object semantics and multiple uniquely named proofs; made duplicate/invalid profiles unable to contribute provider coverage. No remaining implementation failure is hidden by blocked host receipts.

`npm audit` reports **3 advisories**: two low for current Svelte-plugin/deepmerge development tooling and one moderate for existing P3 Hono. [audit.json](audit.json) contains exact current output. No unrelated dependency upgrades were made.

## Resources and handoff

[resources.json](resources.json), [browser-cleanup.json](browser-cleanup.json), [bb-unpair.json](bb-unpair.json), [vscode-cleanup.json](vscode-cleanup.json) record cleanup. All four owned standalone origins are unreachable after stop. The owned browser session is closed. The Windows owned profile/repository/extension root was removed after observing zero matching processes. BB read-only pairing was removed; zero native threads were created, zero inputs sent, and no new containers/machines were made. BB protected health listeners now close after each RPC. Existing `sf-native-probe` remains installed/running with the new frontend; P3 settings/hooks and existing tooling/cache remain intact. Retained P2 histories/partly removed scratch, prior contracts and prior receipts are unchanged. Earlier implementations remain preserved; P3 registration/tooling is extended for P5 as listed in the file inventory.

Canvas implementation commit: `22dcc7b2d7a0b222448e7d427802fbbdd949edce` (`test: verify all factory dashboard surfaces`). The full implementer report is also at runner `.superpowers/sdd/2026-11-03-software-factory/task-5-report.md`. The durable evidence here survives disposable SDD cleanup. Proceed only with independent review or prerequisite recovery; do not start dependent product work while readiness is false.

## Review fix round1: I1 / I2

The Windows evidence containment predicate and missing Canvas native callback wiring are corrected in [fix1/README.md](fix1/README.md), with current focused RED/GREEN/build receipts. Earlier full-suite/live receipts above are historical verification at the original FIX_BASE commits; no new full/native/browser/editor/model run was made for this fix. Current covering checks pass28 gate cases,5 Canvas-wrapper/transport cases and1 public-SDK scan; builds/typechecks pass. One actual gate command remains exit1, ready:false,3passed/8blocked. Canonical required receipt statuses/digests and real-host prerequisites are unchanged. A trusted approved observed URL can now be supplied to the actual Canvas process via SF_P5_NATIVE_URL, but no real Canvas selection pass is claimed. M1/M2 remain deferred.
