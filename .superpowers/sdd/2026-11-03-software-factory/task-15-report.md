# Task 15 / E2 implementation report

Status: DONE_WITH_CONCERNS. Production pinned-engine client and setup deployment are implemented; the production client passed an actual pinned Kestra + fixture-broker roundtrip. Product bind-mount deployment could not run through this host's broken Windows-Docker-to-WSL path bridge. Windows private protection and E3/E6/E7 assembly remain the assigned consumer tasks, not claims of implemented native-host support.

## Scope and root rulings

Read task-15-brief, task-15-context-notes, binding-constraints and implementer-procedure. Used the test-driven-development skill. No subagents, global Docker/WSL/auth changes, provider credentials, external repository mutations, or GUI dependency. Root explicitly approved `src/kestra/*` rather than nonexistent `runner/src` because the actual package compiles `src`; approved the minimal Installation, protected-store, real Docker/process, internal journal and trusted authority ports. Root subsequently required/approved continuation binding for the actual C4 producer: retry clones the same workflow/native identity into a new attempt, while human continuation advances the fence on the same attempt.

## Implementation

- `src/kestra/deployment.ts`: real `ProcessDocker` uses shell:false argv, stdin-only private request/credential transport, bounded output/deadlines and redacted errors. `ensureKestra` creates private persistent installation directories/config/H2 data; validates canonical ownership/modes and rejects symlinks, malformed keys and modified configuration. The POSIX secret store creates/reuses a private secret file exclusively with fsync; AES key is canonical standard-base64 of 32 random bytes, as required by pinned engine SECRET inputs. Windows has no plaintext default: a separate protected-store/runtime-ACL implementation is required.
- Pinned images come from authoritative `release/images.json`; no probe/cache imports. Engine and transport containers have owned labels/deterministic identities, no published ports, no socket mounts, readonly root, dropped capabilities/no-new-privileges, resource limits and private internal network. Adoption verifies digest/architecture, image entrypoint/working directory, command/user, environment, mounts, restrictions and ownership. Unknown create/start replies reconcile those identities. A restarted engine also restarts an existing private transport sidecar to rejoin its network namespace. POSIX container UID/GID match the non-root installation owner; Windows uses UID/GID 1000 with injected ACL protection.
- `runtime/kestra/{application.yaml,compose.yaml}`: managed recursive rendering disabled, plugin installation disabled, H2 repository/queue plus local persistent storage. The compose file documents topology; production deployment uses verified Docker argv. `scripts/copy-runtime-assets.mjs` copies these assets and release image pins into the compiled package.
- `src/kestra/executions.ts`: private durable SQLite **transport-intent journal**, separate from factory SQLite and engine H2. Unique attempt and request keys; full immutable start fingerprints; transactional compare/claim before asynchronous start/resume effects; durable pending/sent/known and pending/sent/done outcomes. Database FULL synchronous commits and private permissions. No blind start or resume retries after uncertain effects.
- `src/kestra/client.ts`: real `KestraPort` uses E1 validation/hash/contract and exact three-task graph. Domain recipe revision maps to a content/revision-derived immutable engine flow ID with pinned numeric revision 1. Returned and searched executions must match namespace, flow ID, numeric revision and attempt/revision labels. Search correlation is not presented as native engine deduplication: the journal claims the sole send; uncertain outcomes remain uncertain rather than resubmitting.
- Public inputs reject reserved `sf_` keys. Trusted initial request is validated for operation, attempt, scope repositories, grants, recipe, task/owner/provider and fence; only the shared canonical E1 codec creates reserved STRING bodies. Capability headers require the exact safe alphabet. Initial and final capabilities are separate.
- Early results stay durable until the internal `await_result` taskrun is actually PAUSED. Resume keys bind typed exact results, taskrun and emitted logical envelope. Sent/unknown resumes reconcile the fixed persisted onResume STRING before completion; they never blindly resend. Snapshot exposes no internal SECRET/result Pause as human input. SUCCESS alone cannot invent a result: fixed `outputs.submit_result.body` evaluation must decode a successful shared WorkerResponse with matching request ID and exact TaskResult/current attempt. Broker errors or uncertain observation yield `unknown`, not completion. Native idle has no completion path. Engine stop observation does not assert native quiescence.
- Private `rebindContinuation(identity,key)` reads trusted lifecycle authority, verifies prior attempt/current fence, immutable task/recipe and the original fixed native-start acknowledgement/session, then durably binds the existing workflow to the current attempt/fence. It neither resumes Pause nor sends native continuation. Only a pending/not-issued result may be invalidated. Sent/unknown/done results prevent rebinding. Binding generation is rechecked transactionally after asynchronous ResultAuthority returns and immediately before claiming the resume send, fencing stale authority work.

## Exported ports / consumer handoffs

`Installation = { id: string; root: string; docker: DockerPort; secrets: InstallationSecretStore }`.
`DockerPort.command(args: string[], options?: {stdin?: string}): Promise<string>`; real `new ProcessDocker(executable = 'docker')` is provided. No developer executable path is hardcoded.
`InstallationSecretStore.loadOrCreate(id,root): Promise<{username,password,encryptionKey}>`; optional `protectRuntimeDirectory(path)` is mandatory on Windows. `PosixInstallationSecrets` is the concrete POSIX implementation, unrelated to C6 GitHub AuthRecord.
`ensureKestra(installation): Promise<KestraHandle>` returns `installationId`, owned `containerId`, `transportContainerId`, `journalDirectory`, backend-only authenticated `request`, and `brokerNetwork: {id,name,alias:'sf-broker',port:8080}`.
`createEngineTransport(docker, transportContainerId, secrets)` is also exported and is the actual production transport used by setup and the live fixture.

`new KestraClient({journalDirectory,request,authority})` implements `ensureExecution(WorkflowStart)`, `snapshot(WorkflowIdentity)`, `resumeInput(identity,TaskResult,key)`, `stop(identity)` and `close()`. Additional private lifecycle seam: `rebindContinuation(identity,key)`.
`KestraAuthority.start(start)` and `.result(identity,input,key)` return `{request: WorkerRequest,capability:string}`; optional `.continuation(identity,key)` returns `ContinuationBinding {attemptId,previousAttemptId,fence,taskId,recipeId,recipeRevision,native:NativeIdentity}`. These are trusted server reconstructors, never browser/worker request forwarding.

- **E3**: supply actual live scope/grant/expiry/current-fence authorization in the authority port; E2 shape/correlation checks do not grant authority. Own the broker endpoint and alias on `handle.brokerNetwork`. Attach only that trusted broker to this engine network, never arbitrary workers. Use shared codecs for success and error bodies. Issue fresh result capabilities after continuation/retry; do not reuse the initial token. Worker/native isolation profiles remain E3/E4 responsibilities, not verified by engine container restrictions.
- **E6**: assemble E1 registry, E3 authority and the client. Recover uncertain starts using the original immutable WorkflowStart/key; never issue a different key merely because transport failed. Retry that retains the existing workflow must call `rebindContinuation` through C4's bookkeeping `workflow.resume`; do **not** call ensureExecution as a new engine start. Authority.continuation must read actual C4 retry chain/current attempt/native records, not infer ancestry from a supplied ID. NativeOwner.send handles human answers; internal resumeInput accepts only genuine typed results. A binding change after an issued result must reconcile first. Engine terminal status plus structured result still needs C8/native/workspace quiescence before closeout or lease release.
- **E7**: select canonical private installation root; call mutating ensureKestra only after install confirmation, never during preview. Provide platform Docker executable and Windows protected secret + runtime ACL store. Ensure pinned images are installed before ensureKestra (`--pull never`). Persist the handle directory paths. Owned resources manifest is `kestra/owned-resources.json`; labels are `sf.installation`, `sf.owner`, `sf.component`. Uninstall must verify identity/ownership before removal and follow data-retention policy; E2 does not delete production H2. Recovery reopens `kestra/journal/execution-intents.sqlite` and the same H2/config/key. Never replace engine H2 with factory or intent SQLite.

## RED / GREEN and exact verification

All commands below ran in `/home/wbihl/workspace/software-factory/ai4devops-sf/.worktrees/product`, with `PATH=/tmp/sf-p1-runtime/node-v24.22.2-linux-x64/bin:$PATH`.

1. Initial `npm test -- tests/kestra/client.test.ts`: first missing-module RED; then explicit unimplemented client scaffold produced six behavior failures including one-start, reserved-input and resume/recovery expectations. Final meaningful RED stdout: `/tmp/sf-task15-red.log`. Deployment missing-module RED: `/tmp/sf-task15-deployment-red.log`. Additional actual regression REDs: `/tmp/sf-task15-network-red.log` (real Docker IPv4/IPv6 default network options); `/tmp/sf-task15-key-red.log` (canonical standard-base64 AES key); `/tmp/sf-task15-entrypoint-red.log` (entrypoint escape); `/tmp/sf-task15-restart-red.log` (transport namespace restart). Continuation integration coverage was added after the root's additional producer requirement; no separate preimplementation RED is claimed for that extension.
2. Final `npm test -- tests/kestra/client.test.ts tests/kestra/deployment.test.ts > /tmp/sf-task15-focused-green.log 2>&1`: exit 0. Exact final summary:
   ```text
   ℹ tests 15
   ℹ suites 0
   ℹ pass 15
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ℹ duration_ms 4539.55833
   ```
3. `npm test > /tmp/sf-task15-full-green.log 2>&1`: exit 0. Initial full run 278/278; source review then added the namespace-restart fix and its RED/GREEN, so a final full run was warranted. Exact final stdout summary:
   ```text
   ℹ tests 278
   ℹ suites 0
   ℹ pass 278
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ℹ duration_ms 40534.71912
   ```
4. `npm run typecheck > /tmp/sf-task15-typecheck-green.log 2>&1`: exit 0; `> tsc --noEmit`, no diagnostics.
5. `npm run protocol:check > /tmp/sf-task15-protocol-green.log 2>&1`: exit 0; `> node scripts/generate-protocol.ts --check`, no drift.
6. `npm run build > /tmp/sf-task15-build-green.log 2>&1`: exit 0; `> tsc -p tsconfig.build.json && node scripts/copy-runtime-assets.mjs`, no diagnostics.
7. Standalone compiled-package smoke: copied only `dist`, dereferenced runtime dependencies and a module package manifest to a fresh `/tmp/sf-e2-package-*`, spawned Node there, imported compiled deployment, and exercised packaged configuration/secret creation with an intentionally unavailable daemon. Exit 0, `/tmp/sf-task15-packaged-green.log` exact stdout: `Standalone compiled package imports and loads pinned runtime assets without source/sibling/cache paths`. Temp package/install removed. No sibling checkout, source or dev cache was required.
8. `git diff --check`: exit 0, no output.

## Actual pinned-engine integration (new product proof)

Command:
```sh
PATH=/tmp/sf-p1-runtime/node-v24.22.2-linux-x64/bin:$PATH SF_E2_DOCKER=/mnt/c/Users/wbihl/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe node scripts/check-kestra-roundtrip.ts > /tmp/sf-task15-live-green.log 2>&1
```
Exit 0. Persistent receipt: `release/evidence/e2/product-r1/kestra-roundtrip.json`; original `/tmp/sf-task15-live-receipt.json`. Exact output begins `Pinned engine authenticated API ready; wrong credentials rejected` and `Start HTTP status 200 accepted`; receipt ends `"status": "passed", "cleanup": "complete"`.

This invokes actual production KestraClient + createEngineTransport, actual E1 Registry/materializer/codec and the current three-task starter on the pinned linux/amd64 Kestra image, against an explicitly synthetic broker. Fixture broker rejects any byte difference in both encoded request bodies and checks distinct initial/final authorization. Replies contain literal raw tags, expressions, percent, quotes, newlines, escape text, Japanese and emoji, and are decoded/compared outside the engine. Twelve assertions: wrong basic auth denied; lost-start-reply recovery; fixed three-task graph; exact native body and reply; H2 Pause survives engine restart; same execution/recipe revision after client restart; fresh final fence/capability; exact result body/reply; resume-key idempotency; one start and one result; H2 database file observed. Engine execution `3cTmSvpONtC28f2zjDi6Pn`. All owned live containers/volumes/network cleaned after ownership checks. No native provider/GUI proof is asserted.

Early live failure found the concrete AES-base64 requirement (HTTP 422 `Invalid AES key length: 29 bytes` with a fixed fixture canary); source and tests corrected it. The initial uncertain start remained journaled and was never blindly resubmitted. Final clean stdout is separate from earlier diagnostic logs.

Required legacy command also ran:
```sh
PATH=/tmp/sf-p1-runtime/node-v24.22.2-linux-x64/bin:$PATH SF_P4_DOCKER=/mnt/c/Users/wbihl/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe npm run probe:kestra -- --live --scratch-repo tests/.scratch/probe-repo --output-dir /tmp/sf-task15-legacy-probe > /tmp/sf-task15-legacy-probe.log 2>&1
```
Exit 0; eight legacy P4 assertions passed, including typed invalid resume rejection and H2 SUCCESS surviving a second restart. Evidence `/tmp/sf-task15-legacy-probe/{kestra-oss-h2,kestra-oss-h2-details}.json`. **This unchanged legacy probe is old-probe API/H2 coverage only, not production-client proof.** The new product proof is the preceding roundtrip script/receipt.

## Limits / self-review

- Product `ensureKestra` bind deployment was attempted. `/usr/bin/docker` is the known broken WSL stub; explicit Windows Docker executable worked for daemon operations, but rejected `/tmp/sf-e2-live-production/kestra/data` with `bind source path does not exist`. A bounded UNC mapping attempt failed `accessing specified distro mount service: stat /run/guest-services/distro-services/ubuntu-22-04.sock: no such file or directory`. No WSL/global config workaround was made. The owned failed-bind network/root were subsequently removed after exact ownership checks. Production deployment is source + filesystem/Docker-fixture tested; live product-client roundtrip used explicitly fixture-owned volumes, not falsely claimed product binds.
- Windows protector, native Windows/macOS/ARM behavior, GUI/native-provider operation and production broker/isolation remain unverified here. Failclosed private/proven-capability boundaries stay intact. E7 owns Windows implementation and platform installation evidence; user host visuals do not replace those automated boundaries.
- Unknown start/resume outcomes intentionally remain journaled if no matching execution/output is observable. This avoids duplicate effects; E6 must expose reconciliation/attention instead of inventing success or automatically replacing the attempt. `stop` only requests engine kill; it does not prove writer/native quiescence.
- Reviewed actual source/diff for secrets in argv/logs, foreign-resource adoption, broker-network scope, immutable flow validation, request/response codec reuse, stale result authority versus continuation races, build asset paths, and no factory-SQLite-as-H2 substitution. Found/fixed AES key format, entrypoint verification, pinned kill path, and transport namespace restart. No source/probe coupling or unrelated refactor was introduced.
