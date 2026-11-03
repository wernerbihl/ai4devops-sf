# Local software factory design

Date: 2026-11-03

Status: Builder check complete; awaiting user approval.

Builder check: A fresh reviewer reported "nothing important left" to clarify
before planning. Integration behavior remains subject to the feasibility
gates in this document.

## Intent

Give one person a local software factory that continually selects useful work
across their GitHub repositories. The person controls recipe priorities,
adds urgent manual work, answers requests for input, and continues tasks in
native agent conversations.

Two independently releasable projects provide the system:

- ai4devops-sf: an npm package with exactly three public commands: setup, next,
  and uninstall. It installs and coordinates the local services.
- ai4devops-sf-canvas: a Svelte/Vite application using shadcn-svelte, available
  standalone, as VS Code Canvas and GitHub Copilot App Canvas extensions, and
  through a BB plugin.

The first usable release includes all four dashboard surfaces and both
Copilot and Codex. Claude is outside this release. Each execution owner exposes
only provider combinations and restrictions that it actually supports.

The dashboard surface and execution owner are independent. A task submitted
from the browser may execute in a BB-native thread or a VS Code-native session.
The owner creates the conversation from the start; the factory does not create
an unrelated SDK session and later try to import it.

## Goals and boundaries

Goals:

- Automatic, bounded work after explicit repository activation.
- Predictable weighted round robin, exclusive repository execution, and prompt
  manual dispatch.
- User-managed recipes and tags, consistent task creation, and traceable results.
- Native conversations, human intervention, and recovery using the original
  provider session and task workspace.
- Local setup on Linux, macOS, and Windows, starting after user login.
- GitHub.com appearance, compact operational views, and one shared frontend.
- Recipes control context freely; report usage where the owner exposes it.

Outside this release:

- Shared multi-user factories, distributed scheduling, and hosted orchestration.
- Claude, arbitrary provider integrations, or invented native-session imports.
- Enterprise Kestra features or unrestricted execution of imported Kestra flows.
- A separate discovery subsystem. Discovery is ordinary recipe work.
- A factory-owned replacement chat UI or hard factory-imposed context budgets.
- Enforcing locks on unrelated agent sessions created outside the factory.

## Approaches and selected tradeoffs

### Workflow engine

Two approaches were considered:

1. A factory-specific YAML engine in the local Node service. This would reduce
   services and storage, but require building the workflow features.
2. Self-hosted Kestra, the factory service, SQLite, and isolated Docker workers.
   This provides an established workflow engine at the cost of another service
   and a separate execution-state database.

The user selected Kestra. Setup manages a pinned local Kestra container and
persistent embedded H2 storage. H2 is a deliberate choice for a smaller,
development-oriented local installation. SQLite remains authoritative for
factory tasks, scheduling, and leases; H2 belongs to Kestra.

### Execution and conversations

A common SDK runner with a factory conversation view was considered.
Cross-host native adoption of arbitrary SDK sessions has no common supported
contract. The user selected host-owned execution and restricted combinations.

This supersedes the original proposal that the CLI directly invokes every
provider SDK. Trusted adapters use each owner's native execution API and its
provider harness. SDKs remain appropriate where a host requires them, including
Copilot Canvas integration; they do not establish an additional independent
execution owner by default.

### Repository access

A GitHub App with selected-repository permissions was initially chosen.
The user subsequently chose to reuse supported existing authentication first,
including gh, and offer GitHub App login when no supported authentication is
available. The backend constrains factory requests to approved repositories;
it does not claim to narrow an existing token's GitHub permissions.

## Architecture and ownership

~~~mermaid
flowchart TD
    Browser[Standalone Svelte UI] --> API[Trusted local factory service]
    Canvas[VS Code / Copilot App Canvas adapters] --> API
    BBUI[BB plugin UI adapter] --> API
    Login[Per-user login service] --> API
    Next[next command / takt] --> API
    API --> DB[(Factory SQLite)]
    API --> Kestra[Trusted pinned Kestra controller]
    Kestra --> H2[(Kestra H2 and storage)]
    Kestra --> Worker[Isolated recipe worker]
    Worker --> Broker[Task-scoped factory broker]
    Broker --> API
    API --> Owner[Native execution-owner adapter]
    Owner --> Agent[Verified isolated native agent environment]
    Agent --> Native[Native conversation and persisted session]
    API --> GitHub[GitHub operations via existing auth or App login]
~~~

The local service owns admission, configuration, task state, leases, GitHub
operations, readiness, artifacts, and UI/API access. It is the only writer
through which untrusted recipes can change factory state.

Kestra owns workflow executions and Pause/resume state. SQLite records the
corresponding execution ID and pinned flow revision. Neither database is a
second editable authority for the other's state.

The native owner owns conversation identity, provider processes, and native
history. SQLite stores the owner/session identifiers, sanitized activity,
usage, task results, and artifact references. Host idle is not proof that the
task succeeded.

The factory service has a private daemon entry point, not a fourth public
command. The service serves the installed UI, API, and event stream between
ticks. Public next requests one dispatch through that same service.

### Separate repositories and releases

The runner publishes versioned API and schema contracts. The canvas project
checks in a generated client/schema snapshot and declares its compatible
protocol versions. Runtime code must not require a sibling checkout.

The canvas release includes built UI assets and host-specific adapter bundles.
The runner installation includes a compatible versioned UI asset distribution,
so a packaged factory does not require a development server or Bun. Bun remains
an acceptable way to run the standalone canvas development application.

Dependency versions, Kestra/plugins, worker images, and adapter capabilities
are pinned in release manifests. Exact versions are builder choices verified
by the integration gates below, rather than unversioned downloads at each takt.

## Installation and commands

### setup

Setup reruns the three requested groups using stored values:

1. Factory directory, defaulting to ~/.ai4devops-sf on Linux/macOS or
   %USERPROFILE%\.ai4devops-sf on Windows.
2. Takt interval, default 60 seconds, with an explanation that it triggers
   checks for automatic work.
3. Provider and execution configuration: discover installed tools and native
   owners, check supported authentication, allow selecting Copilot/Codex, and
   choose valid default execution owner/provider settings.

Discovery checks actual usable provider/owner paths, not just executable
presence. A compatible host may supply its provider runtime. Stop before
installation if no selected path can run. Model choices come from owner
capabilities and defaults, rather than hardcoded model names.

Docker must be installed and usable. Setup diagnoses a missing or unavailable
container engine and provides recovery instructions; it does not silently
install privileged OS software.

Before installation, show the exact directory, services, containers, storage,
login startup registration, selected owner/provider, takt, initial limits, and
required capability grants. Keep the requested Install (Y/n) step.

Example durable layout:

~~~text
<factory>/
  config.json                 non-secret configuration and schema version
  sqlite.db                   factory state; WAL sidecars may also exist
  recipes/                    recipe YAML and immutable revision snapshots
  repositories/               factory-managed Git clones
  worktrees/                  task-specific worktrees
  kestra/database/            persistent H2 data
  kestra/storage/             Kestra storage
  artifacts/                  results and task evidence
  runtime/                    installed, versioned service payload
  logs/                       bounded local service logs
  backups/                    migration/reconfiguration backups
~~~

A small per-user installation locator in the platform's standard application
configuration directory points to the chosen factory directory. It makes later
setup, next, and uninstall find a custom directory. It contains no credentials.

Linux uses a supported per-user service manager; macOS uses a LaunchAgent;
Windows uses a per-user logon startup registration. True pre-login startup is
not required. The service starts its managed dependencies after login, handles
dependency readiness, and resumes after sleep without replaying missed ticks.

The installed service invokes an absolute, versioned entry point using a
known Node executable. It does not resolve an unpinned npx package every tick.
The public npx commands remain the user-facing interface.

Reconfiguration stops admission, quiesces owned work, backs up state, updates
configuration and startup registration, and restarts with health checks.
Preserve tasks, recipes, results, and native identities. A directory move must
validate native workspace-path continuity; never silently substitute a fresh
conversation when the original owner cannot resume the relocated workspace.
Unsupported moves of unfinished sessions need an actionable resolution before
the old installation is removed.

### next

Find the configured installation and request one atomic dispatch. Concurrent
calls from the daemon, terminal, or UI cannot duplicate starts. If an installation
exists but the service is stopped, start the installed service and wait for its
readiness, or return an actionable startup error.

No eligible work is a successful no-op. Return a concise reason for a pause,
exhausted limit, unavailable owner, or lock. Events and task state are the UI's
source of detail.

### uninstall

Stop admission and scheduled work, quiesce factory-managed native execution,
remove only this installation's startup registration and owned containers,
then remove the factory directory and installation locator. Remove
installation-owned credential material without logging out of gh, Codex, or
other shared tools. Do not delete GitHub repositories, PRs, shared Docker
resources, or independently installed native applications.

If the service cannot establish that an owned native writer has stopped,
report the blocked cleanup rather than delete its live workspace.

## GitHub authentication and operations

The trusted backend tries supported credentials in this order:

1. Authenticated gh for the selected GitHub account, using gh api where possible.
2. Supported HTTPS Git credential helpers whose credential can authenticate
   the required GitHub API operations.
3. GitHub App device-flow login when no usable supported credential exists.

An SSH remote or successful Git fetch does not establish API/PR permission.
Check identity, repository access, and operation-specific readiness. Distinguish
missing credentials, expired authentication, permission/SSO failures, rate
limits, and temporary network errors. Do not replace an existing identity merely
because GitHub is temporarily unreachable.

Bind the configured account identity. Detect a changed active gh account instead
of silently acting as a different user. Keep raw credentials in trusted
backend/provider storage, never frontend state, recipe YAML, or worker logs.

For App fallback, the implementation recommendation is a publisher-owned
GitHub App with device flow and user access tokens. This is local-only, avoids
shipping a client secret/private key, and acts as the user within the App's
installed repositories. Creating/configuring that new App is a release
prerequisite; the original supplied OAuth app is a different app type.

An explicit repository allowlist applies to all brokered GitHub actions.
PR creation and merging are separate capabilities, evaluated again at use.
Expected commit identity and PR head SHA protect against merging a different
change from the one whose result was validated.

## Tags, priorities, and automatic dispatch

### Tags

Tags have stable IDs and editable display names. Seed the seven example tags:
Performance, Bug Fixes, Features, Wiz Fixes, SonarQube Fixes, Research, and
Improve Codebase Quality. They are defaults, not fixed scheduling categories.

Every recipe and task has exactly one tag. Generated tasks inherit the creating
recipe's tag. There is no secondary descriptive-tag selection and no separate
discovery execution type.

Delete unused tags. Archive referenced tags so history remains interpretable.
Require reassignment of unfinished work and active recipes. A running attempt
retains its immutable revision and tag until it is quiescent; archival stops
new automatic starts for the old tag immediately.

### Independent priority weights

Each repository stores a 0–100 integer weight per active tag. Values do not
sum to 100 and changing one never changes another. Zero removes the tag from
automatic selection; explicit manual work remains separately eligible.

Use batched weighted round robin, preserving a cursor per repository. Reduce
positive weights by their greatest common divisor:

- 90 and 10 produce nine T1 starts followed by one T2 start, then repeat.
- 80 and 50 produce eight T1 starts followed by five T2 starts.

This describes that repository's subsequence; other repositories can run between
its turns. Do not replace it with a smoother alternating distribution.

Implementation proposal: visit tags by descending weight, with stable creation
order for ties, and start a new cycle when weights change. A skipped unavailable
tag accumulates no catch-up debt. Persist the cursor across service restarts.

### Automatic admission

At a takt:

1. If paused or at a global execution/activity limit, do not start work.
2. Give eligible manual work or explicit user resumption priority.
3. Choose the eligible unlocked repository least recently serviced by the
   factory. A repository is eligible only if it has runnable work or a runnable
   matching recipe under a positive tag weight.
4. Choose its next eligible tag using the persisted weighted rotation.
5. Run the oldest ready queued automatic task in that tag. If none exists,
   create a task for a fresh matching recipe invocation.
6. If several fresh recipes match, choose the least recently run on that repo,
   with a stable tie breaker.
7. Atomically reserve global capacity and the repository lease, create the
   attempt, charge the daily start counter, and advance scheduling state.
8. Start the pinned Kestra execution and native owner through idempotent
   requests. Reconcile a crash between local reservation and external creation.

Each next admits at most one new task attempt. No separate discovery passes
or backlog targets exist. Recipes can inspect code, modify it, report results,
or create tasks according to their own workflow.

Only actual automatic task starts consume weighted turns. Manual starts do
not. Retries use the same task and consume daily attempt allowance without
consuming a second weighted task turn. Do not advance a tag merely because a
readiness probe or preflight check failed.

Skipped ticks do not form a backlog. An empty or blocked tag does not prevent
other runnable tags or repositories from being considered.

### Manual and multi-repository work

Submission and repository lease release trigger manual admission immediately,
including between takt ticks. Manual work bypasses tag rotation but obeys
global pauses, capacity, task duration, daily limits, and repository exclusion.

An explicit manual task may target a repository whose autonomous activation is
off; it does not turn on continuous automatic work. Interactive human ownership
still prevents competing factory work on that repository.

Multi-repository submission creates a parent and one child per repository.
Children hold independent leases and create their own results/PRs. There is no
cross-repository atomic merge. The parent completes when all children satisfy
their requested outcomes and exposes partial failures.

## Task lifecycle, limits, and leases

Task state records at least queued, running, waiting for input, waiting for CI,
needs attention, completed, failed, and cancelled, plus ownership/control mode.
The UI groups these into Planned, In progress, Done, and Needs Attention.
Keep a specific reason and recovery action for blocked states.

Each attempt records its task, recipe revision, base commit, worktree, Kestra
execution, native owner/session IDs, capability profile, timestamps, usage,
active duration, result, and retry relationship.

Defaults, editable in Settings:

| Limit | Default |
| --- | --- |
| Active factory-managed runs globally | 1 |
| Active execution per attempt | 30 minutes |
| Task-attempt starts per local calendar day | 100 |
| Automatic retries for transient failure | 2 |

Manual, automatic, and retry attempts count toward the daily limit. Waiting for
human input and CI does not consume active execution time or an agent slot.
Resuming a human-paused attempt is continuation, not a second daily attempt;
a crash retry is a new charged attempt using the same native session/workspace.
Do not kill a healthy attempt merely because the day boundary or start limit
was reached after it began.

SQLite transactions reserve capacity and leases together. A lease includes a
unique attempt identity, heartbeat, and monotonically increasing fencing
generation. Every broker mutation verifies that generation.

Lease timeout alone does not prove the previous native agent stopped. Confirm
quiescence or stop the owned isolated environment before allowing another
factory agent onto that repo. If this cannot be established, keep the repository
blocked for attention. This is essential when a native host is disconnected.

Release active leases after the native writer is quiescent when waiting for
input, performing background CI monitoring, or finishing. Reacquire before
resuming model work and revalidate the base, worktree, relevant recipe grants,
and owner capabilities. Do not discard saved changes to resolve drift.

Transient retries resume the original native conversation and workspace using
bounded backoff. Authentication failures, denied permissions, merge refusal,
conflicts, or invalid task results require attention rather than blind retries.

### Native takeover

The task detail offers the exact native conversation once it exists.
Taking control pauses automatic scheduling for that repo before handing it to
the native UI. The factory stops driving additional turns and closeout while
the human owns the conversation.

Return control explicitly in the repository panel. Reconcile native state and
revalidate the workspace before automatic work resumes. A structured reply to
a factory input request is not a full takeover; it resumes the waiting workflow.

The factory tracks active work in its own native sessions. It cannot promise
exclusion against unrelated sessions the person creates outside the factory.

## Recipes, task contract, and context

Recipes are native Kestra YAML with factory metadata, validated against the
pinned Kestra schema and a factory-approved subset of task types and settings.
They live under the factory's recipes directory and have immutable revisions.
Do not provide a second discovery DSL or execution-role field.

The logical recipe contract contains:

- Stable recipe ID, schema version, revision/hash, name, description, one tag.
- Typed inputs and declared defaults, including applicable repositories.
- Goal/task templates and acceptance criteria.
- Required skills and tool references, with supported versions where relevant.
- Required capabilities: workspace paths/modes, tool use, network destinations,
  and explicitly selected credential identities.
- Native owner/provider compatibility constraints and finish-policy defaults.
- Kestra tasks and expected structured outputs.

The exact placement of factory metadata in valid Kestra labels/variables is a
builder detail, verified against the chosen upstream schema. The field semantics
above and broker schema are shared contracts, not free-form prompt conventions.

Every executable task supplies title, description, goal, acceptance criteria,
recipe revision, repository, tag, required skills/tools, relevant context or
context references, requested finish policy, and execution defaults/overrides.
The factory validates missing or inconsistent fields before dispatch.

Recipes choose context freely. They may provide excerpts, paths, evidence,
instructions, or their own retrieval strategy. Do not impose a factory token
budget or claim to control the host's entire history. Preserve required native
instructions and show reported usage; label estimates and unavailable metrics.

### Controlled CRUD and deduplication

Recipes access shared factory state through a narrow versioned broker API.
They never mount SQLite or receive raw SQL access.

The API provides validated task creation/read/update/cancel operations, finding
upsert, result submission, attention requests, artifact access, and permitted
native execution requests. Bind each capability to its attempt, repo scope,
recipe revision, grants, expiry, and fencing generation.

Creation and all retryable mutations carry idempotency keys. Task-producing
recipes cannot change their inherited tag, elevate finish authority, switch a
running owner/provider, or modify unrelated tasks using worker credentials.
Deletion of live/history-bearing work means cancellation/archive, not erasing
audit history.

For discoveries, the tuple repository + recipe ID + stable finding key identifies
an existing open task. Reuse that task on a repeated finding; do not replace a
running task's acceptance criteria. A recurrence after closure may create a
new linked task. Validate the declared target scope before creating children.

### Results and finish policies

Completion requires structured workflow/native output plus verification of the
requested outcome. A native idle event only ends a turn.

1. Save result only: retain a report, evidence, and any created task IDs; no PR
   is required.
2. Create PR: create the PR for the validated task changes; leave it for review.
3. Create PR and merge if CI passes: observe the current PR head's relevant
   checks and repository requirements before requesting merge.
4. Create PR and merge even if CI fails: request an authorized checks/rules bypass
   only when this policy was explicitly selected. GitHub refusal needs attention.

Code-changing tasks default to Create PR. Recipes can default reporting work to
result-only. Pin the finish policy before execution; untrusted output cannot
upgrade it.

The backend performs GitHub mutations using the validated head SHA. A queued
merge request is not a completed merge. Observe the actual outcome and do not
rerun PR creation or merge on an uncertain network response without reconciliation.

## Isolation and execution-owner adapters

Imported code runs in an isolated Docker worker with only the approved workspace
mounts, network path, resources, and attempt-scoped broker access. It never
receives the Docker socket, full factory directory, host credential stores,
arbitrary host mounts, privileged mode, or unrestricted controller APIs.

Trusted Kestra and service code control Docker execution settings. Imported
flows cannot choose arbitrary JVM plugins, Process runners, subflows/revisions,
unsafe interpolation, images, mounts, networks, or privilege settings. Factory
validation enforces this in OSS; paid Kestra governance is not a dependency.
Keep the trusted pinned plugin/controller surface small.

Isolating recipe code does not by itself isolate the agent the recipe requests.
An adapter must verify the effective native execution environment and each
required restriction. Worktrees and a generic permission-mode label are not
hard isolation evidence.

The supported pattern is a controlled native runtime inside an isolated
environment, with scoped workspace mounts and enforced network policy.
Exclude unapproved client-contributed tools that execute outside it. Explicit
external capabilities must be treated as such. A declared model credential
is available within its approved runtime boundary; do not promise its value
is hidden from code in that boundary without a verified use-only mechanism.
GitHub credentials remain behind the backend broker.

If an owner cannot enforce a recipe's required tool, path, credential, or network
restriction, block dispatch with the missing capability. Never fall back to a
broader host environment or a different owner/provider.

### Adapter contract

Each trusted adapter supports capability discovery/readiness, environment
validation, create-or-reconcile native task identity, send/resume, activity/input
events, cancel/quiesce, native navigation, usage reporting, and durable identity
reconciliation. Exact transport details belong to that host.

| Surface or owner | Required integration |
| --- | --- |
| Standalone browser | Shared local API client; submits to configured native owner |
| VS Code Canvas | Shared Svelte UI through a Copilot Canvas adapter; separate native execution sessions |
| VS Code execution owner | Authenticated Agent Host Protocol, provider/config discovery, native session/chat actions; managed headless host where supported |
| Copilot App Canvas | Shared UI through the compatible Canvas extension; execution-owner option only after required management/navigation handlers are proven |
| BB dashboard | BB plugin wrapper mounting shared Svelte UI in the host-supported frontend entry |
| BB execution owner | Native thread APIs, lifecycle/interactions, navigation, and admission hooks in a verified isolated environment |

VS Code 1.144 is the researched AHP/native-opening baseline and must be checked
against the actual release used. BB currently exposes Codex in this installation;
Copilot is not assumed available there. Provider support is a runtime capability
matrix, not a hardcoded promise.

Native opening uses documented or source-verified, version-gated contracts.
An owner that loses native history exposes that condition; the factory must not
create a replacement conversation and label it the original.

## Human input and dashboard

Kestra OSS Pause and typed resume inputs are sufficient for workflow questions;
no Enterprise HumanTask dependency is needed. The service correlates these with
native-owner input/approval requests, pauses active work, and publishes a
Needs Attention item with a clear response action.

The approved UI reference is the companion canvas repository's
docs/superpowers/mockups/factory-dashboard.html. PRODUCT.md records the durable
product decisions. The reference uses sample data and simulates effects.

Build the production interface in Svelte with shadcn-svelte components,
styled with GitHub Primer's colors, compact density, borders, type scale, and
light/dark themes. Host wrappers must not duplicate the application UI.

Required flows:

- Existing authentication is detected first. Show the connected account and
  repositories; offer GitHub App login when needed.
- Header: Settings at the top left; Add Recipe and primary Add Task actions.
- Repositories: searchable accordion list, activation, current execution owner,
  task link, independent tag-priority sliders, and a weighted-rotation preview.
- Needs Attention: prominent blocked/input items above the repository list.
- Tasks: repository/status filters, title/tag/source/status, details, results,
  activity, available usage, and native opening after a session exists.
- Add Task: title, description, one recipe/inherited tag, repositories, four
  finish policies, and optional owner/provider overrides.
- Recipes: starter templates, YAML editor, file import, metadata/capability
  editing, validation feedback, and activation readiness.
- Settings: takt, limits, default execution, tags CRUD/archive/reassignment,
  and sanitized GitHub identity/access state.
- Native handoff: explain repository pause and offer explicit return control.

Support keyboard operation, visible focus, accessible form errors, loading,
empty, unavailable-service, and permission states. Preserve the approved
structure at narrow widths, without horizontal overflow. Use host theme and
scoped overlay targets when embedded. Do not depend on remote fonts/assets.

## Local API and durable data

Bind the browser API explicitly to loopback. Use authenticated local IPC or a
paired protected local API for native adapters. Restrict origins and mutations;
an arbitrary website must not obtain access to local credentials or task
operations merely by reaching a localhost port.

Serve the installed UI from the backend's origin with a protected session.
Use an OS-user-controlled pairing/bootstrap mechanism for native and dev
clients. Keep long-lived credentials out of URLs and frontend bundles.
Workers use a separate narrow broker path on controlled container networking,
not the browser/admin API.

SQLite's logical entities include installation/configuration, tags, repositories,
per-repository weights/cursors, recipe revisions and grants, tasks/parents,
attempts, leases, quota reservations, findings, owner identities, attention
requests, artifacts, usage, and an event/outbox log.

Use transactions, foreign keys, unique dedup/idempotency keys, schema versions,
and a durable outbox/reconciliation scheme for external side effects. Write
attempt reservations before starting Kestra/native execution. Reconcile by
stable IDs after restart, including hosts whose events are not replayed.

Keep a bound on diagnostic logs; retain task history and results until user
deletion/uninstall. The exact SQL layout, event transport, loopback port, token
storage implementation, heartbeat periods, and indexes are builder choices.

## Release validation and feasibility gates

The documentation establishes integration routes, not completed compatibility
tests. Before broad implementation, prove:

1. A native Copilot task and a native Codex task can be created, controlled,
   paused/resumed, reconciled, and opened through the chosen VS Code baseline.
2. Native BB Codex execution, interaction, admission, and exact-thread navigation
   work through the selected isolated environment. Advertise no absent provider.
3. Each of the four dashboard adapters loads the shared Svelte build and reaches
   the factory service. Copilot App owner capability remains unavailable unless
   its creation/control/navigation handlers pass the probe.
4. Required restrictions hold around the actual native work, including external
   tools; failure blocks that combination.
5. Kestra OSS/H2 can persist, pause/resume, restart, and run the restricted
   recipe subset with no exposed worker access to trusted control surfaces.

No probe may silently relax a settled requirement. A failed product-critical
gate must be reported before continuing dependent implementation.

Required verification for a release:

- Clean install/reconfigure/uninstall on supported Linux, macOS, and Windows
  without relying on a sibling checkout, developer cache, or Bun at runtime.
- Concurrent next/manual events never duplicate attempts or violate leases.
- 90/10 produces the requested 9:1 batch rotation across restarts; independent
  weights, missing work, manual priority, limits, and recipe rotation behave.
- Stale workers, lost owner connections, sleep, retries, input, CI waiting, and
  native takeover preserve identity and cannot admit competing native writers.
- Repeated findings and uncertain GitHub responses remain idempotent.
- Four finish policies produce the verified requested outcomes and enforce
  explicit bypass authority.
- UI flows and embedded themes work using the production component library,
  with keyboard and narrow-layout checks.

## Implementation calls to review

These fill gaps without changing the chosen product direction:

- Publisher-owned App device-flow fallback, with user-attributed actions.
- Descending-weight tag order, stable tie breakers, no catch-up debt for
  unavailable work, and cursor reset after priority edits.
- Manual tasks can run without enabling autonomous repository activation.
- Human input continuation keeps its original attempt; transient retries charge
  a new attempt without consuming another weighted task turn.
- UI assets are distributed with a compatible runner release; API/schema
  compatibility does not depend on a shared filesystem checkout.
- Direct SDK dispatch is replaced by native owner adapters, as required by the
  user's host-ownership decision.

The builder may choose libraries, exact schema field names, pinned compatible
versions, packaging details, controller plumbing, and test fixtures. The builder
may not restore a discovery subsystem, normalize priorities to 100, add Claude,
replace native threads with a factory chat UI, or weaken capability enforcement.

## Source notes

Primary references used for feasibility:

- [VS Code Agent Host architecture](https://code.visualstudio.com/docs/agents/concepts/agent-host)
- [VS Code native session management](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- [VS Code Canvas prerequisites](https://code.visualstudio.com/docs/agents/run/canvases)
- [VS Code sandbox scope](https://code.visualstudio.com/docs/agents/run/agent-sandboxing)
- [AHP session commands](https://github.com/microsoft/agent-host-protocol/blob/main/types/channels-session/commands.ts)
- [VS Code native opening baseline](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/platform/agentHost/common/openSessionLink.ts)
- [BB thread API](https://github.com/get-bb/bb/blob/main/packages/sdk/src/areas/threads.ts)
- [BB Codex sandbox policy](https://github.com/get-bb/bb/blob/main/plugins/provider-codex/src/session-params.ts)
- [Copilot Canvas extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
- [Copilot SDK session-management contract](https://github.com/github/copilot-sdk/blob/main/docs/session-management.md)
- [Kestra Docker installation and H2](https://kestra.io/docs/installation/docker)
- [Kestra task runners](https://kestra.io/docs/task-runners)
- [Kestra OSS and paid features](https://kestra.io/docs/oss-vs-paid)
- [Kestra Pause](https://kestra.io/plugins/core/flow/io.kestra.plugin.core.flow.pause)
- [Docker daemon trust boundary](https://docs.docker.com/engine/security/)
- [GitHub CLI API](https://cli.github.com/manual/gh_api)
- [Git credential helpers](https://git-scm.com/docs/git-credential)
- [GitHub App user access/device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Device-flow token refresh exception](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub merge authority](https://cli.github.com/manual/gh_pr_merge)
- [SQLite application-server pattern](https://www.sqlite.org/whentouse.html)
- [shadcn-svelte Vite](https://www.shadcn-svelte.com/docs/installation/vite)
- [shadcn-svelte theming](https://www.shadcn-svelte.com/docs/theming)
- [GitHub Primer colors](https://primer.style/product/primitives/color/)
- [GitHub Primer typography](https://primer.style/product/primitives/typography/)
