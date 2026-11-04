# P5 review fixes, round 1 — I1 and I2 only

The reviewed implementation defects are fixed; P5 remains **BLOCKED**. One actual `npm run gates:check` still exits1 with `ready:false`, three passed IDs and eight blocked IDs. The eight selected canonical receipts, their digests, profile inventory and host versions/statuses are unchanged. No native/browser/editor/model or unrelated full-suite rerun was performed.

## I1: contained evidence paths on Windows

The same production predicate now rejects a first `..` component using either slash separator, then applies the platform's absolute-path check. `contained()` still resolves real filesystem targets before applying that predicate, so directory symlink/junction escapes cannot enter the bundle through an apparently local path.

RED used an extraction of the **unchanged** former predicate. `npm test -- tests/probes/gates.test.ts` passed27/28; the actual predicate returned `true` for `path.win32.relative('C:\release\evidence','C:\release\outside.json') === '..\outside.json'`. [gates-red.txt](gates-red.txt) records the failure. GREEN, same command: **28/28**, [gates-green.txt](gates-green.txt).

Coverage includes existing outside files used as manifest-selected receipts, profile specs and artifacts, both through real parent references and through real directory symlink/Windows-junction references. Fixture hashes are refreshed so hash/file-missing errors cannot accidentally satisfy those tests. Each case first demonstrates valid evidence/profile coverage before replacing its reference. Additional Windows-semantics cases cover parent, sibling-prefix, other-drive and legitimate contained paths using `node:path.win32` and the same production predicate. Actual filesystem cases ran on Linux; this is not a native Windows filesystem test claim. `npm run typecheck`, `npm run build` and diff checks passed.

## I2: executable Canvas navigation adapter

`probes/canvas/extension.mjs` now reads the same trusted `SF_P5_NATIVE_URL` probe-process configuration used by standalone and supplies the server's `onNavigate` callback. The URL must have already been observed and explicitly approved in its native host, and be supplied to the owned extension process at launch. The shared backend and frontend retain HTTP(S)/no-embedded-credentials validation. No Canvas window API, independent SDK session, credential grant or inferred native target was added. Missing configuration remains unavailable409; rejected schemes/credential-bearing URLs return503; a valid navigation acknowledgment remains **`selected:false`**.

The tests import the **actual extension entry**, stub only the public `createCanvas`/`joinSession` SDK registration context, then call the real instance server over paired local HTTP. RED `npm test -- tests/probes/canvas-wrapper.test.ts` failed2/2: configured navigation returned409 instead of200, and invalid configuration never reached route validation. [canvas-red.txt](canvas-red.txt) preserves this.

GREEN `npm test -- tests/probes/canvas-wrapper.test.ts tests/probes/transport.test.ts`: **5/5**, [canvas-green.txt](canvas-green.txt). Coverage verifies registration, configured delegation with `selected:false`, missing/invalid targets, retained URL for repeated instance opens, native close shutting its real listening socket, and existing transport/auth/origin/concurrent-surface safeguards. The fixture URI is never navigated or contacted externally. These are fixture/component tests, not real Canvas selection evidence.

A focused public-SDK scan caught the test's variable dynamic import, so the test now uses a static module path plus a no-exports `.d.mts` declaration for the side-effect entry. No scanner rule was relaxed. The covering `node --test --test-name-pattern 'only public SDK imports' tests/bb.test.ts` passes1/1; [sdk-scan-red.txt](sdk-scan-red.txt), [sdk-scan-green.txt](sdk-scan-green.txt). `npm run build:probe` passes shared Svelte generation, package typecheck and public BB server/frontend builds; [canvas-build.txt](canvas-build.txt).

## Verification limits and handoff

All tooling used official Node24.22.2 through the existing task-local PATH. [validation.json](validation.json) records exact FIX_BASE commits, current covering counts and current gate result. Previous86-runner /24-backend+6-DOM full-suite receipts and prior standalone/BB real-host receipts remain **historical FIX_BASE verification**; they were not rerun or promoted by this fix. A configured callback alone cannot satisfy any Canvas selected-identity gate.

The VS Code updater still blocks owned native activation; the Copilot App target/version, native lifecycle/model/UI and BB credential/isolation/provider-profile prerequisites remain unresolved. Operators must supply an explicitly approved observed target URL to each actual Canvas process and obtain actual host DOM/theme/CSP/resource/portal/auth/native-selection/close observations. No production C/E/U work is authorized. Minor M1 pairing-test preservation and M2 dependency advisories are deferred as instructed.

Changed implementation files: runner `scripts/check-gates.ts`, `tests/probes/gates.test.ts`; canvas `probes/canvas/extension.mjs`, `probes/canvas/extension.d.mts`, `probes/canvas/README.md`, `tests/probes/canvas-wrapper.test.ts`. Runner adds this fix report/receipts and appends the durable P5 report. Only test-owned loopback listeners and temporary existing-file/junction fixtures were created, and all were cleaned. No native thread/model, browser/editor, machine/container or plugin installation/reload was performed in this fix.

Canvas fix commit: `c9b30039ed55d388cd0b92a9878f25226fe8358b` — `fix: wire approved Canvas native navigation adapter`. Runner containment/report commit is the commit owning this fix directory.
