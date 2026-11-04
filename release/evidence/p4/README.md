# P4 restricted integration evidence

This is a pre-production gate, not a production orchestrator or verified native profile. `release/compatibility.json` and the earlier P2/P3 receipts are unchanged.

| Component | Live result | What it establishes |
| --- | --- | --- |
| Kestra OSS/H2 | Passed, 8 assertions | `variables.sf` accepted unchanged; immutable revision lookup; a deliberately discarded start reply recovered by exact attempt-label lookup without resubmission; typed Pause survives restart; malformed INT resume rejected; exact BOOL/INT output; unchanged execution identity; SUCCESS survives a second restart. |
| Restricted worker process | 15 assertions passed; overall isolation gate blocked | Actual nonroot process writes only to scratch, cannot read an unmounted fixed host-credential canary through a symlink or access Docker socket, cannot write the root filesystem, receives only the declared fixed model canary, and fails IPv4/IPv6/mapped-IPv6 and alternate DNS TCP/UDP egress attempts. |
| Managed headless VS Code | 19 startup/denial assertions passed; native gate blocked | Pinned shipped server runs inside the inspected restricted container; contained diagnostic AHP client sends only initialize/listSessions; wrong token rejected; GitHub MCP, connectors, system proxy and computer use disabled; Claude absent; Copilot and Codex each advertise zero models; zero sessions. No login or model turn. |
| Actual native task/tool lifecycle | Blocked | No provider authentication or approved model service egress was supplied. No native execution, input, pause, continuation, restart, UI identity or external client-tool execution is claimed. |
| BB native | Blocked | Earlier P3 initial GitHub/global environment forwarding limitation remains. No BB enrollment was attempted. |

## Reproduce component probes

From the runner root, Node 24.22.2 and the pinned images in `release/images.json` are required. Pull those exact digest references explicitly during trusted setup. This Windows Docker Desktop host uses:

```sh
export PATH=/tmp/sf-p1-runtime/node-v24.22.2-linux-x64/bin:$PATH
export SF_P4_DOCKER='/mnt/c/Users/wbihl/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'
npm test -- tests/probes/kestra.test.ts tests/probes/isolation.test.ts
npm run probe:kestra -- --live --scratch-repo tests/.scratch/probe-repo --output-dir logs/probes/p4-kestra
npm run probe:isolation -- --live --scratch-repo tests/.scratch/probe-repo --output-dir logs/probes/p4-isolation
```

The scratch check is read-only and requires the existing clean diagnostic fixture described by `assertLiveScratch`. Neither Docker runtime receives a host bind mount, a published port, a host credential or a Docker socket. There is no Windows/WSL path mapping assumption: runtime mounts are uniquely named Docker volumes only. Missing explicit `--live` uses fixture mode and cannot supply release evidence. Native `verifyProfile` always fails closed until the actual native restrictions are verified.

The source-referenced no-auth/no-turn headless diagnostic is preserved separately:

```sh
node release/evidence/p4/headless/setup.mjs --live
node release/evidence/p4/headless/bootstrap.mjs --live
```

These are bounded diagnostic scripts, not the production E4 installer. Setup downloads the exact official server artifact, verifies its commit, SHA256 and shipped entrypoint, provisions empty owned state and a private admission token. Bootstrap installs the exact official SDK with setup-only egress, then switches to a separate network-none/read-only native container with the assets/config volumes mounted read-only. The diagnostic client runs via `docker exec` in that same container; it supplies no session/client tools. The manifest is checkpointed before each allocation; cleanup checks the ownership label before deleting any resource. An interrupted setup must be cleaned only from its exact manifest after verifying ownership. Tokens are never printed or persisted in these receipts.

## Version and API facts

- Kestra `v2.0.8-slim`, Linux/amd64, with the exact official manifest digest in `images.json`. `/app/plugins` contains no additional JARs ([inventory](image-inventory/inventory.json)); the core Pause/Return plugins are bundled in the pinned release. Plugin auto-install is explicitly disabled.
- The pinned [`LocalCommand`](https://github.com/kestra-io/kestra/blob/v2.0.8/cli/src/main/java/io/kestra/cli/commands/servers/LocalCommand.java) uses H2 at `/app/data/database.mv.db`; the probe verified that file after actual restarts. Setup generates `/app/confs/application.yml` in an owned volume mounted read-only at runtime. Java gets a fixed loopback hostname; network mode stays `none`.
- The pinned [`ExecutionController`](https://github.com/kestra-io/kestra/blob/v2.0.8/webserver/src/main/java/io/kestra/webserver/controllers/api/ExecutionController.java) uses `/api/v1/main/executions`, nested search filters and `/{id}/actions/resume`. Kestra 2 removes outputs from GET execution, so exact persisted typed Pause outputs are read using the trusted `actions/eval` API. Recipes cannot choose arbitrary evaluation strings.
- RF3 deliberately discards the accepted HTTP200 start response before delivering an execution ID to the controller. Reconciliation searches namespace + flow + attempt label and validates all returned identity fields. No retry POST is sent. This proves the single in-flight lost-reply case; it does not turn Kestra labels into a uniqueness constraint or implement the future durable factory start registry/concurrency protocol.
- The [`FlowController`](https://github.com/kestra-io/kestra/blob/v2.0.8/webserver/src/main/java/io/kestra/webserver/controllers/api/FlowController.java) supports revision-qualified lookup; original revision metadata remains unchanged after a new revision and restart. No P1 technical mapping amendment was needed.
- VS Code `1.145.0-insider`, commit `3c0ec3a089398503a462029e7cc2a5749df5169a`, official server archive SHA256 `f410d7b12870992cd988b3bb09b65b1f77e1131b8e9d5daa6bf56317115db7ee`; Codex SDK `0.163.0`, archive SHA256 `201b83598aaa2764468788cff3ad450e81e5d1e2f00662be668f94d85e8de294`. Exact URLs are in the receipts. Its shipped native Node is `24.22.1`; runner/worker remain pinned to `24.22.2`.

## Headless startup, authentication and client-tool contract

The public [standalone host documentation](https://code.visualstudio.com/docs/agents/concepts/agent-host) describes `code agent host`. Pinned [`AgentHostArgs`](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/cli/src/commands/args.rs) supports `--new-instance --foreground --host --port --connection-token-file --user-data-dir --server-data-dir`. The CLI resolves latest server versions in the background, so this proof instead uses its pinned [shipped-server startup contract](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/cli/src/tunnels/agent_host.rs), with the actual product `serverApplicationName`:

```text
/assets/vscode/bin/code-server-insiders --start-server --accept-server-license-terms
  --host 127.0.0.1 --port 8080 --agent-host-port 8081 --server-data-dir /state
  --connection-token-file /config/token --telemetry-level off
```

`VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED=false`, `VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED=true` and `VSCODE_AGENT_HOST_CODEX_SDK_ROOT=/assets/codex-sdk` configure provider registration. The root configuration is seeded into owned `/state/data/User/globalStorage/agent-host-config.json`; the AHP snapshot confirms disabled `githubMcpServerEnabled`, `mcpConnectorsEnabled`, `systemProxyEnabled` and `computerUseEnabled`. See the pinned [environment constants](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/common/agentService.ts) and [configuration schema](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/common/agentHostSchema.ts).

The next real prerequisites are an explicitly approved provider credential/authentication path and constrained model-service egress for this owned boundary. Copilot accepts resource-scoped AHP `authenticate` credentials in [`copilotAgent.ts`](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/node/copilot/copilotAgent.ts); native OpenAI account sign-in in [`codexAgent.ts`](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/node/codex/codexAgent.ts) calls `account/login/start` with type `chatgpt`. Neither was invoked. Do not copy host login homes or forward general GitHub credentials to make this gate pass.

There is no verified universal exclusion of tools contributed by future admitted clients. [`agentSideEffects.ts`](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/node/agentSideEffects.ts) forwards active-client tool definitions to the provider, and the workbench [`agentHostSessionHandler.ts`](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts) executes them through its tool service. Empty contributions from this single contained client are verified only for this no-turn diagnostic. Any later editor/client admission must preserve verified executor containment or enforce and prove tool exclusion before native tasks run.

Declared model credentials may be readable to code inside the approved boundary. The fixed model canary is deliberately readable; no use-only secrecy is promised. The host credential test uses a fixed synthetic canary in a separate owned volume, never a user's credential store.

## Scope and cleanup

`recipe-policy.json` is a narrow feasibility allowlist (typed Pause, static Return and two fixed output expressions), not the production YAML importer or broker. It rejects Process runners, plugin/subflow substitution, runtime overrides, host/socket mounts, privileges, triggers, plugin defaults and arbitrary interpolation. The real worker process and headless process are independent component proofs; no Kestra-to-native broker, C/E/U subsystem or production dispatch is implemented.

Final per-run resource manifests show every owned container and volume removed. A transient WSL/Docker transport interruption during an earlier setup run was recovered by inspecting each exact ownership label and finishing that manifest's cleanup. Official pinned image cache entries remain available; no global/shared settings, shared resources or image caches were deleted. Earlier P2 native sessions/workspaces and all P3 records remain untouched. The historical failed Insiders entrypoint attempt is retained with its clean resource manifest; final bootstrap uses the verified product filename.
