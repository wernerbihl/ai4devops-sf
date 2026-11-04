# Software Factory session closeout — 2026-11-04

The user ended integration testing for this session and explicitly authorized PRs targeting `main`, automatic merge in both repositories, and deletion of the created feature branches and worktrees. Remaining live test gates are deferred to the user's manual testing across machines and apps; they do not block this checkpoint merge.

## Delivered checkpoint

- Versioned domain/native-owner contracts, runtime validation and generated OpenAPI/JSON Schema.
- VS Code, BB, Kestra and isolation feasibility probes, fixtures and reviewed corrections.
- A shared Svelte dashboard fixture, protected local health transport, BB integration and Canvas extension source.
- Pinned compatibility/image policy and historical evidence with explicit passed, failed and blocked results.

This is the contracts-and-probes foundation. The storage, scheduler, production service/API, native execution adapters, three-command installer/CLI and production dashboard in tasks C1–C8, E1–E8 and U1–U6 remain planned work. This checkpoint is not the first usable factory release.

## User dispositions and current facts

| Item | Disposition |
| --- | --- |
| VS Code Insiders update | Resolved; current observed build 1.146.0-insider, commit e576c7bbeb39772a1d1ebe472545def0d93e6d8b. |
| Native Canvas enablement | Verified true through the owning host's `canvasesEnabled` setting. |
| Local VS Code Codex setup | Closed at user direction; user will review on another machine. No local passing native Codex test is claimed. |
| BB Git credential forwarding | Disabled with explicit user approval. Fresh readback: `machineGitCredentialsEnabled:false`, built-in forwarding status `disabled`, zero custom global/project variables. Leave this setting disabled unless the user requests a change. |
| Copilot App | Installed version 1.1.34; Canvas controls and owned-folder registration observed. User reports its installer accepts GitHub URLs rather than the staged local directory. Installation/loading from a GitHub URL remains unverified. |
| All remaining live testing gates | Deferred to user manual testing for this merge. Native lifecycle, selected-conversation identity, App/VS Code Canvas mounting and restricted native execution profiles remain unverified where their receipts say so. |

Historical evidence and the strict `gates:check` diagnostic retain their actual results. No fixture or user waiver is converted into a live pass. Native dispatch and isolation checks retain their existing restrictions.

## Manual testing and follow-up

1. Use Node 24.22.2 or later and install dependencies independently in each repository.
2. In the runner, run `npm test`, `npm run typecheck`, `npm run build` and `npm run protocol:check`. `npm run gates:check` diagnoses evidence completeness and is expected to remain nonzero with the current deferred receipts.
3. In the Canvas repository, run `npm test`, `npm run typecheck` and `npm run build:probe`. `npm run probe:standalone` opens the standalone fixture; Canvas staging and BB transport instructions are in `probes/canvas/README.md`.
4. Verify native Copilot/Codex lifecycle, input, cancellation, reconnection and exact selected-conversation identity on each supported host. Separately verify filesystem, network, tool-client and credential restrictions before admitting untrusted work.
5. Verify actual VS Code and Copilot App Canvas installation, theme, resource/CSP behavior, authenticated health transport, navigation and disposal. The Copilot App GitHub-URL packaging/loading path requires follow-up.
6. BB setup admission currently remains disabled in the probe. A proposed dynamic policy guard was investigated after the global forwarding change but was not implemented before session closeout.

Deferred review notes include a stronger prior-pairing preservation regression, two low development-tool advisories and the existing moderate Hono advisory. These were disclosed during task reviews; no clean dependency audit is claimed.

## Session records

The approved design and implementation plans remain in `docs/superpowers/`. Session ledger, individual reports, reviews and remaining proposal notes are archived in thread storage before deleting the worktrees. Live evidence under `release/evidence/` remains committed with its original qualifications.

## Checkpoint verification

Fresh Node24.22.2 verification on this checkpoint passed runner93/93 tests, typecheck, build and protocol:check; Canvas24/24 backend tests and8/8 UI/transport tests, typecheck and build:probe. No live editor/App/native-model/Docker probe was rerun during closeout. The historical strict readiness diagnostic remains qualified as described above.
