# Software Factory Runner

Software Factory runs a private local service that turns explicitly activated recipes into bounded repository work. Its dashboard manages repositories, tasks, recipe approvals, human input and results. It uses SQLite for factory state and setup-managed pinned Kestra OSS containers with persistent H2. This is a reviewable **0.1.0 preview**; see [release compatibility and outstanding acceptance](release/COMPATIBILITY.md).

The supported execution path in this build is **VS Code Agents / Copilot**, subject to the real account, supported pinned host and per-attempt isolation checks. Codex, BB execution and GitHub Copilot App execution remain unavailable under current native API/security capabilities. Their dashboard adapters can still control a configured verified VS Code owner. A connected UI or discovered model never establishes execution readiness.

## Requirements

- Node.js **24.22.2 or newer supported LTS** and npm. Linux cold packages were also tested with **26.13.0**. Bun is unnecessary.
- A nonroot OS account; use that same account for the Runner, VS Code and dashboard hosts. An absolute private installation directory accessible to the selected Docker daemon is required.
- Docker with Linux/amd64 containers and a patched daemon: 26+ is accepted; patched 25.0.5+ and 23.0.11+ are also recognized. Setup verifies the daemon version, pinned images and the **actual selected directory bind**, and refuses an unavailable or unsafe boundary.
- Linux: a working systemd **user** session; macOS: launchd user agent; Windows: Task Scheduler and Windows PowerShell with working DPAPI and ownership/ACL checks. Login startup and native install on macOS/Windows still require machine qualification. Windows-mounted executables in WSL are not a substitute for a working selected daemon and host.
- Git for repository work; VS Code Agents with the supported host/API, a Copilot account and an executable that setup can launch. The release pins the isolated official AgentHost server commit in `release/images.json` / the image builder, rather than accepting an arbitrary host as equivalent.
- GitHub repository authorization is separate from Copilot OAuth. An already authenticated `gh` account can supply GitHub access; GitHub App device-flow fallback needs the publisher's real App configuration, which is not supplied by this repository.

Initial setup downloads the pinned official server/base images after confirmation and may require a second Copilot sign-in in the installed private profile. Read the preview before consenting. Setup does not install Docker, change global VS Code settings, or publish anything.

## Build reviewable local packages

```sh
git clone https://github.com/wernerbihl/ai4devops-sf.git
cd ai4devops-sf
npm ci
npm run package
npm run verify:package -- artifacts/ai4devops-sf-0.1.0.tgz "/tmp/sf cold 工場"
```

Choose a fresh scratch directory for each verification. On Windows use a fresh path under `$env:TEMP` instead of `/tmp`. `package` builds compiled JavaScript, validates the embedded dashboard/companion VSIX, verifies exact committed production inputs, records offline source/artifact/dependency hashes and writes `artifacts/ai4devops-sf-0.1.0.tgz`. No registry package or GitHub release is required. Git history must include the pinned source commits; retain them when integrating changes.

`verify:package` installs the actual tarball **offline with an empty npm cache**, exercises setup/next/uninstall help, copies the runtime and Node into a private scratch directory, and starts the real service with owned nonsecret configuration. It checks API/UI serving, private control authentication and singleton exclusion. It deliberately has no provisioned native provider or real Docker service; it reports the remaining live gates. It does not perform account sign-in or GitHub writes.

A clean Runner clone builds from its **shipped** `release/dashboard`; no Canvas checkout is needed. Production runtime has no sibling checkout, application source TypeScript imports, VSCE development dependency, Git provenance query, CDN or developer-cache requirement. Dependencies and the prebuilt, locally verified companion VSIX travel in the tarball.

## Install the tarball and start

Use a local prefix to keep the package separate from the protected installation. With the actual tarball from the previous step:

```sh
npm install --offline --omit=dev --ignore-scripts --no-audit --no-fund \
  --prefix "$HOME/software-factory-cli" "$PWD/artifacts/ai4devops-sf-0.1.0.tgz"
export PATH="$HOME/software-factory-cli/node_modules/.bin:$PATH"
ai4devops-sf --help
ai4devops-sf setup
```

PowerShell equivalent after building in the clone:

```powershell
npm install --offline --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$env:USERPROFILE\software-factory-cli" "$PWD\artifacts\ai4devops-sf-0.1.0.tgz"
$env:PATH = "$env:USERPROFILE\software-factory-cli\node_modules\.bin;$env:PATH"
ai4devops-sf setup
```

There are exactly three public commands:

| Command | What it does |
| --- | --- |
| `ai4devops-sf setup` | First run: preview, confirm, provision the private runtime/login service and open its dashboard. Existing install: **Open dashboard or reconfigure (open/reconfigure) [open]**. Enter accepts a fresh trusted open; choose `reconfigure` explicitly to change settings/runtime at the same directory. |
| `ai4devops-sf next` | Request immediate bounded dispatch through the private controller. A pending acknowledgement is reconciled with the same request; it does not authorize duplicate work. |
| `ai4devops-sf uninstall` | Ask the maintenance controller to quiesce exact owned resources and remove verified service/runtime entries. Report retained or unknown resources precisely; a partial cleanup returns nonzero. |

Existing-install default open starts/repairs the trusted dashboard without reauthentication, reconfiguration or task dispatch. After browser reload or service restart, run `setup` and choose **open** again to recover mutation authority. A tab with an existing cookie can become read-only after reload; copying a URL or refreshing is not equivalent to a new trusted pairing. Never paste pairing fragments or private control credentials into a task.

The login service uses its own copied Node binary and production dependencies. Keep the protected installation directory, locator, keys and ownership records intact. Changing the separate CLI prefix does not move installed native identities.

## Choose a dashboard

The same production interface is available in the browser, VS Code Canvas, GitHub Copilot App Canvas and BB navigation. The **execution owner is independent of the dashboard host**.

- Browser: run `ai4devops-sf setup` and accept **open**.
- Native Canvas: use the host's normal GitHub-URL extension installer with [the installable Software Factory directory](https://github.com/wernerbihl/ai4devops-sf-canvas/tree/main/.github/extensions/software-factory), then open Software Factory in Canvas. [Repository discovery URL](https://github.com/wernerbihl/ai4devops-sf-canvas). Both hosts require the same-user installed Runner; the protected loader verifies its exact runtime/helper identity.
- BB: follow the [Canvas repository's local build/install instructions](https://github.com/wernerbihl/ai4devops-sf-canvas#readme), then open **Software Factory** in navigation. BB's actual host theme subscription is supported.

Current public Canvas APIs expose no selected host theme/subscription. Those surfaces provide **Appearance: System / Light / Dark**, live within the frame and reset on reopen. System follows OS/browser media preference; automatic native host-selected theme synchronization is unsupported. Native installation, selected-conversation visuals and other-machine checks remain manual acceptance, distinct from the automated packaged/C5 transport tests.

## First repository, recipe and task

1. Open **Repositories → Add repository** and select a repository available to the current GitHub identity. Review the execution owner. Adding a repository leaves autonomous work inactive.
2. Open **Settings** to review limits and tags. Defaults are a 60-second takt, one active run, 30 active minutes per attempt, 100 starts per local day and two transient retries. Missed ticks are discarded. Priority sliders are independent 0–100 values: 90/10 gives nine first-tag starts then one second-tag start; they need not total 100.
3. Use **Add Recipe** to choose a starter or import local YAML, assign exactly one tag and repositories, then validate and save an inactive immutable revision. Imported recipes are untrusted. Review repository **name and immutable ID**, paths/tools/network/credentials/finish scope and current execution profile before explicitly approving and activating. Profile or scope changes require a fresh exact approval. Generated tasks inherit the recipe tag.
4. Use **Add Task** to select a recipe/repository and supply its input. Manual tasks may run while repository automation is inactive; they respect limits, dispatch immediately and do not consume weighted turns. They do not activate continuous work. For automatic bounded work, explicitly **Activate automatic work** on the repository and leave automatic work unpaused.
5. Watch **Tasks** and **Needs Attention**. Answer the original schema-bound question with **Respond**, or open the original native task for human control. Return repository/task control explicitly before factory work continues. Continuations/retries preserve the native owner/provider, conversation identity and worktree; an unknown effect remains fenced for recovery.

The four finish choices are create a PR, merge after CI, merge with explicitly selected already-authorized bypass, and return a result without a PR. Factory approval grants no extra GitHub privileges. Real PR/CI/bypass acceptance requires a designated disposable repository; none was used for this delivery.

Native conversations run in a pristine host with builtin/MCP execution denied; scoped client tools access a separate isolated real task worktree. The native filesystem/Git view therefore does not directly expose the worktree. The service verifies both roles and physical quiescence before releasing a writer lease. Unsupported capabilities remain blocked rather than falling back to unrestricted local execution.

## Reconfigure, uninstall and recovery

Same-directory reconfiguration preserves installation/history/native identity, stages protected SQLite/H2/key backups, fences admission, and health-checks an immutable runtime candidate. Known failed candidates roll back only after verified quiescence; unknown effects retain the exact recovery journal and original data. Follow the path and recovery reason printed by setup; do not overwrite an uncertain target.

**Directory relocation is currently unsupported** where native/workspace/private-profile continuity cannot be proven. Setup performs read-only inventory, reports the exact blockers, declines before mutating the old installation and tells you to use the original directory. A copied profile or a new conversation is not continuity.

Uninstall safely removes only verified owned service/runtime/Docker entries after controller proof, fresh mount survey and singleton exclusion. It currently **retains `<installation>/vscode-profile`** as `unverified companion profile process`: the launcher does not provide durable descendant-exit proof. Data, keys and recovery dependencies remain protected. The report lists exact retained paths. Close the owned native/profile windows, retain the original directory and resolve the reported identities/journals before retrying; no general automated profile/data deletion is claimed. Do not kill unrelated Code processes, delete the installation wholesale, or remove shared Docker resources. Removing this CLI prefix alone does not stop the installed service.

If Docker is unavailable, correct the selected daemon/bind mapping and rerun setup; no WSL repair is automatic. If pairing expires, reopen through setup. If the owner is unavailable, restore the original supported host/profile/account and inspect **Execution connections**. Never bypass a failed isolation, ACL, ownership or provenance check. Tampered/missing release metadata or image source/release labels are rejected; rebuild a clean committed source or reinstall the reviewed package.

## Development and release checks

```sh
npm run typecheck
npm run protocol:check
npm test
npm run package
npm run release:check
```

`npm test` includes real source/service/storage/scheduler/security integration plus explicitly labeled external-boundary fixtures. For full cold coverage set `SF_RELEASE_TARBALL` to the built artifact, or run `verify:package` directly. CI defines Linux source checks and Linux/macOS/Windows portable smoke on Node 24.22.2 and 26.13.0; workflow definitions do not establish that hosted jobs have run.

Maintainers changing the shared UI must commit Canvas production source, run its explicit `build:adapters -- --runner-root <Runner checkout>` synchronization, commit generated allowlists, then package Runner from exact committed inputs. Runtime never performs cross-repository synchronization. This repository is private development packaging; no registry publication or license assignment is implied.
