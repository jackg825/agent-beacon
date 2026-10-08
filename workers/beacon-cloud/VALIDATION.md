# Review evidence

## 0.4 Mac sync and data operations — local review

Validated on **2026-10-09 (Asia/Taipei)** in the
`claude/beacon-cloud-phase3` worktree, which carries the unmerged 0.2 and 0.3
milestones (jackg825/agent-beacon#3) plus roadmap phase 3 on top of main
`192d6ca1434c0e2f7e604c384bf1119e3caab3f7`. This milestone has **not** been
migrated, deployed, scheduled or accepted on Cloudflare: migrations `0005`–`0010`
were applied only to local databases, no BACKUP bucket exists, no checkpoint or
restore drill has used cloud data, no Mac has run `forwarder/sync.mjs` against a
deployed Worker, and only synthetic events, notes, devices and credentials were
used. No installed Beacon logs, collector settings or transcripts were read.

| Check | Current result |
| --- | --- |
| `npm run check` | TypeScript passes |
| `npm test` | **251/251 pass** (179 top-level tests, 72 subtests), zero skipped or cancelled, in two consecutive runs (39.6 s and 39.4 s). The six phase-3 suites (`sync`, `forwarder/sync`, `backup`, `retention`, `health`, `context-revisions`) hold 60 of the top-level tests; 0.3 had 154 (118 top-level). No intermittent Miniflare `fetch failed` occurred in either run |
| `npm run test:workflow-browser` | **3/3 pass** against the actual Worker/D1/R2: the 0.2 workflow (whose note detail now also covers a validity window, a flag created and dismissed, a share created and revoked and the revision chain), the 0.3 背景整理 run, and the new Mac 同步/資料維護 run described below |
| `npm run test:browser` | **2/2 pass** against the deterministic fixtures |
| Restore drill | `scripts/restore-check.ts` ran as a CLI on a checkpoint the browser run produced: first `--url` against the loopback reviewer object route with `--out`, then offline with `--dir`. Both **passed**: 38 tables, 33 rows, 3 raw objects, triggers 79/79, 12 checks, 0 findings, identical report hashes and `verify_request`. `npm test` also runs the `--dir` CLI in-process on a bundled-Worker checkpoint and makes each consistency check fail on a forged backup |
| `npm run test:collector` | **1/1 passes** with `GOPROXY=off` (cached modules, no download): shipping hook → JSONL → forwarder → Worker → D1/R2 → query after restart |
| Official MCP clients | Current and legacy clients discover **17 read-only tools** (new: `beacon_get_context_history`, `beacon_get_data_health`); the server reports `0.4.0` and its instructions say health hints are for a human operator and that no sync, retention or backup tool exists |
| Local D1 migrations | `WRANGLER_SEND_METRICS=false WRANGLER_WRITE_LOGS=false npx wrangler d1 migrations apply agent-beacon-cloud-db --local --persist-to <fresh temp dir>` applies `0001`–`0010` with **14/18/23/59/15/36/33/10/4/3 statements**; Worker fixtures also upgrade a populated `0001` database through `0010` |
| `npm run deploy:dry-run` | Passes; Worker **1661.54 KiB / gzip 324.32 KiB** (0.3: 1494.46 / 282.60); the checked-in config binds only `DB` and `RAW` (no `BACKUP`); no upload |
| Independent review | Tracks S (sync), D (data operations) and R (revisions) were each code-reviewed with adversarial verification and the confirmed findings fixed with regression tests. The 17 `fix(cloud)` commits after the phase-2 merge include re-checking the sync destination folder right before the write, reconciling interrupted sync writes from the destination, refusing retention when a BACKUP copy lacks its checksum, paging the retention plan past permanently blocked batches, treating young index rows as in flight in the list-diff, exporting every activity-sized table in rounds with a bounded final snapshot, keeping BACKUP copies right for replayed batches, a partial revision index that survives `ANALYZE` (`0010`), one page per arm in `include_shared` recall, and a revision-distance history window |

The new browser suite (`test/operations.browser.mjs`) runs the bundled Worker with
`RAW` and `BACKUP` bound and `MAINTENANCE_TASKS=backup,health`. In Mac 同步, a grant
is refused in the page without the reviewer key (nothing stored; the device's
`/v1/sync/snapshot` answers `403`), then created with it (`memory` and `summary`,
`include_shared`, actor `reviewer:` plus 16 hex digits). Its preview shows 3 approved
notes, 1 shared from the other project with its source label, and exactly the
device route's snapshot hash, titles and order; a title with markup renders as text.
In 資料維護, every finding's count, hint and sample IDs match `/api/health/data`,
including `device_stale` for a never-uploaded device whose markup name renders as
text. 「立即備份」 creates a `running` checkpoint; one Miniflare hourly
`17 * * * *` tick (backup D1 91 / R2 17 / fetch 0, health D1 3 / R2 1) completes it
with integrity verified and 3 raw copies, listed as 已完成・待演練. The drill's
`verify_request` pasted into the tab marks it 已驗證. A raw `keep_days` of 1, with
the batches aged three days, plans 1 batch while the 2 batches notes cite are
blocked as `referenced_by_context`; apply is refused until the confirmation box is
checked, then deletes 1 of 3 batches and leaves the device's snapshot hash
unchanged. Both tabs fit 1280 and 375 px with no horizontal overflow, no page errors
and empty browser storage.

The Node suites exercise, among others: the snapshot equal to authoritative recall
with a reproducible hash and a `413` before any content read; subscriptions that are
reviewer-only, idempotent, bounded at 100, revocable once and trigger-audited; a
device reading only its own grants' kinds, with one `403` for every missing grant;
preview/apply binding exact bytes, stale-snapshot, changed-destination and tampered
plan refusals, rollback refusing user edits, interrupted writes reconciled from the
destination, a folder swapped for a symlink refused right before the write,
instruction-file names and agent folders refused, and unforgeable rendering;
validity windows, `as_of`, bounded history and the revision index after `ANALYZE`;
reviewer and Jev flags that never touch a note, and shares served only while the
note stays approved and authoritative; health inert until opted in, the list-diff
across bounded and overlapping ticks, and findings without content; backups inert
without the binding and the opt-in, every committed table classified for export,
rows changed after their round reread, leased and allotment-bounded progress,
integrity reporting every kind of change and expiry protecting what retention
relied on; retention deleting only closed batch sets behind a drilled,
integrity-verified backup, rechecking inside the deleting transaction, failing closed
on unreadable references, retrying failed R2 deletes, pruning BACKUP copies after
grace and reporting resurrected batches; and every new route's credential matrix
through the bundled Worker.

Not verified here:

- Cloud migration of `0005`–`0010` (or `0002`–`0004`), TEST deployment, redeploy
  persistence and code rollback with the new tables in place.
- A BACKUP bucket, `backup`/`health` on a real hourly cron (Workers Paid CPU,
  subrequest and D1 limits, real tick duration and BACKUP usage at larger volumes),
  and a first scheduled checkpoint.
- A restore drill from a real TEST BACKUP into an isolated local database; any
  production recovery from BACKUP or D1 Time Travel. `verified` remains a reviewer
  attestation the server cannot prove.
- Raw retention applied to cloud data; summary, candidate and audit retention is
  report-only by design.
- A two-Mac sync pilot: real MBP/Mac mini preview, apply and rollback against a
  deployed Worker, with each device's own key, and revocation observed on a device.
  The sync tool's suite ran only in temporary directories on this review machine.
  Sync has no rate limit.
- Named-user review: every grant, flag, share, retention plan and drill attestation
  records the shared reviewer credential, not a person.
- Project-group share targets (deferred), a real Jev endpoint raising flags, and
  `jev_skip_threshold` calibration. `npm audit` and the upstream CLI/packaging suites
  were not rerun.

Wrangler ran with `WRANGLER_SEND_METRICS=false`, `WRANGLER_WRITE_LOGS=false`, no
account configuration and only `--local`/`--dry-run`; it still printed an update
notice (4.149.0 available), so its version check reached the npm registry. Browser
screenshots stayed in a private scratch directory. To reproduce, run the commands in
[Reproduce](#reproduce), then
`BEACON_PLAYWRIGHT_MODULE=/ABS/PATH/playwright/index.mjs npm run test:workflow-browser`
and `npm run test:browser`.

## 0.3 background processing — local review

Validated on **2026-10-09 (Asia/Taipei)** in an isolated worktree of
`claude/beacon-cloud-phase2`, which carries the unmerged 0.2 milestone, the
maintenance scaffold and roadmap phase 2 on top of main
`192d6ca1434c0e2f7e604c384bf1119e3caab3f7`. This milestone has **not** been
migrated, deployed, scheduled or accepted on Cloudflare: no cron fired in the cloud,
no Jev or other provider was called, and only synthetic events and fake providers
were used. No installed Beacon logs, collector settings or transcripts were read.

| Check | Current result |
| --- | --- |
| `npm run check` | TypeScript passes |
| `npm test` | **154/154 pass** (118 top-level tests, 36 subtests), zero skipped or cancelled, in two consecutive runs after the review fixes. Phase 2 accounts for 68 top-level tests (privacy, policy, planner/jobs, output, budget, Jev, maintenance and bundled-Worker suites) |
| Labelled acceptance scenario | `test/processing-output.test.ts`: one synthetic two-Mac task, 7 events → 7 persisted sources; **5/5 labelled items** (failure, fix, approval decision, verification, open lint risk) cited under their expected headings; 6 distinct citations in 511 characters; a fake Jev was asked 4 questions and stored 4 uncalibrated signals; the only contradiction ≥ 0.5 landed on the task note it was about; both notes stayed approved and the candidate stayed pending |
| `npm run test:workflow-browser` | **2/2 pass** against the actual Worker/D1/R2: the 0.2 workflow, plus a new 背景整理 run — save refused without the reviewer key; workspace policy saved (version 1, `reviewer:` actor); project scope planned (4 sources, queued); Miniflare `scheduled()` frequent tick ran it (`succeeded`, 4 covered, usage D1 33 / R2 7 / fetch 0); the job opens its pending candidate labelled 「自動整理・待審」 (`origin:pipeline`, actor `pipeline:beacon.extractive@1`) while default recall stays empty; 1280/375 px with no horizontal overflow, no page errors and empty browser storage |
| `npm run test:browser` | **2/2 pass** against the deterministic fixtures |
| `npm run test:collector` | **1/1 passes** with `GOPROXY=off` (cached modules, no download): shipping hook → JSONL → forwarder → Worker → D1/R2 → query after restart |
| Official MCP clients | Current and legacy clients discover **15 read-only tools**; the server reports `0.3.0` and its instructions say pending pipeline candidates and uncalibrated evaluator scores are not approved knowledge |
| Local D1 migrations | `WRANGLER_WRITE_LOGS=false npx wrangler d1 migrations apply agent-beacon-cloud-db --local --persist-to <fresh temp dir>` applies `0001`–`0004` with **14/18/23/59 statements**; Worker fixtures also upgrade a populated `0001` database through `0004` |
| `npm run deploy:dry-run` | Passes; Worker **1494.46 KiB / gzip 282.60 KiB** (0.2: 1358.20 / 245.39), direct `DB`/`RAW` bindings; no upload |
| Independent review | Six review dimensions with two adversarial verifiers per finding; 9 confirmed and 6 disputed findings were all fixed with tests (PEM/PGP blocks behind a key label, Windows paths in JSON text, cross-part Jev redaction, CJK punctuation after a secret, retry schedule, Jev timeout never shortened, a planner cursor race between overlapping ticks, and missing tests for lease fences, raw caps and stored-signal reuse) |

The suites exercise: inert defaults (no `MAINTENANCE_TASKS` → nothing runs; no
workspace policy → open tasks plan nothing and `run` returns 409); ingest still
acknowledging after every processing table is dropped; 450 events → three jobs
covering each event once; old-timestamp backfill and late-linked sessions covered
by the next job; policy or scope changes ending a claimed job as skipped before any
raw read or call; a lost lease committing nothing; a crash after the candidate
commit recording the existing candidate instead of a second one; a busy tick staying
inside its allotment; field-class projection with metadata only by default; the
redaction table (credential patterns, key vocabulary, bare copies, this Worker's
own secrets, redact-before-and-after truncation, home paths); pipeline actors unable
to review and approval still requiring `REVIEW_TOKEN`; every Jev gate condition
blocking the call on its own; a 307 not followed; a timeout recorded as
`outcome_unknown` and counted; a limit-1 reservation race and two overlapping ticks
each letting exactly one call through; and scheduled logs, reports, job errors and
read APIs carrying no event content, key or provider body.

Not verified here:

- Cloud migration of `0002`–`0004`, the private backup/restore drill, TEST
  deployment, redeploy persistence and code rollback, including how a rollback
  treats registered cron triggers.
- Any cron on Cloudflare: Workers Paid CPU, subrequest and D1 query behaviour,
  real per-tick duration, D1 rows read at larger event volumes, and the account's
  remaining cron-trigger allowance.
- A real Jev/TypeSafe endpoint and dedicated key: wire compatibility, latency,
  reported tokens and cost, and provider billing after `outcome_unknown`.
- Real private content: redaction is rule-based and tested only on synthetic
  patterns; summary quality and omissions on real two-Mac sessions are unmeasured.
- Model generation (not implemented) and `jev_skip_threshold` calibration.
- Named-user review: the reviewer actor still identifies a shared role credential.
- Phase 3 (Mac sync, retention, backups, data health, contradiction flags) is not
  implemented. `npm audit` and the upstream CLI/packaging suites were not rerun.

Wrangler ran with `WRANGLER_SEND_METRICS=false`, no account configuration and only
`--local`/`--dry-run`; it still printed an update notice, so its version check
reached the npm registry. Browser screenshots stayed in a private scratch directory.

## 0.2 project/task/context milestone — local review

Validated on **2026-10-07 (Asia/Taipei)** in the isolated
`codex/context-workflows` worktree, based on merged main
`192d6ca1434c0e2f7e604c384bf1119e3caab3f7`. This milestone has **not** been
migrated, deployed or accepted on Cloudflare. The prior cloud evidence below
belongs to 0.1. No installed collector settings or real transcripts were used.

| Check | Current result |
| --- | --- |
| `npm run check` | TypeScript passes |
| `npm test` | **79/79 pass**, zero skipped: forwarding/auth/MCP regression plus project/task/context suites using real workerd/D1/R2 |
| `npm run test:collector` | **1/1 passes**: unchanged shipping hook → synthetic JSONL → forwarder → Worker → D1/R2 → query survives runtime recreation |
| `npm run test:workflow-browser` | **1/1 passes** against the actual Worker/D1/R2; create group/relation, link MBP and mini sessions to one task, cite exact source, approve and replace a note, inspect 1280px/375px layouts |
| `npm run test:browser` | **2/2 pass** against deterministic read/write fixtures, including filters, pagination, text rendering, reviewer errors and mobile interaction |
| Official MCP clients | Current and legacy clients discover **13 read-only tools**, query tasks/approved notes/exact source versions and reject an absent approval tool |
| Local D1 migrations | `0001`, `0002`, `0003` pass via Wrangler with **14/18/23 statements**; integration and browser fixtures also upgrade a populated initial database |
| `npm run deploy:dry-run` | Passes; Worker **1358.20 KiB / gzip 245.39 KiB**, direct `DB`/`RAW` bindings; no upload |
| Dependency audit | `npm audit --json` reports **0 vulnerabilities**; pinned dev-toolchain `sharp` override `0.35.5` fixes [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) |
| Independent review | Exact raw variant scope, invalid-scope default recall, D1 trigger/CAS behavior, role separation and docs reviewed; identified issues corrected and regression checked |

Acceptance covers missing/short/reused reviewer credentials, denied read/device/MCP
writes, same-origin protection, bounded fatal-UTF-8 JSON, immutable sources/content,
cross-project/task source rejection, missing/corrupt R2 rejection, alternate captures
claiming another repo/session/harness, competing approval/revision races and atomic
audit failure rollback. Groups and tasks preserve project/device/session namespaces.
A pending revision keeps its approved parent active; approval supersedes it atomically.
Changed source scope marks a note non-authoritative and excludes it from default recall.

The browser also verifies anonymous denial, stored HTML rendered as text, no page
script errors, no horizontal overflow, empty browser storage and reviewer key removal
on reload. Local synthetic logs and screenshots stay in ignored `.qa-runs/` storage.
The earlier request-size regression was corrected from 32 to **64 KiB**, including
a 12,000-character Chinese content test; the final full suite has no failures.

New cloud migration, private backup/restore drill, cloud rollback, real Mac sleep/wake
and network-loss acceptance, named-user review, Jev/AI compact, background jobs,
retention and memory file publication/sync are **not verified or implemented here**.
The reviewer audit identifies a shared role credential, not a named human.
`sources_valid` describes D1 scope only; it is not permanent R2 availability or proof
that authored prose is true. See [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md)
and [ROADMAP.md](ROADMAP.md) for the operating boundaries and staged work.

No paid upstream sandbox scenario ran. The free doctor is not ready because Modal
and Anthropic credentials and Linux binaries are absent. Unchanged upstream CLI,
packaging and plugin suites were not broadly rerun. New remote CI evidence is
separate from the prior merged release's CI evidence below.

## Historical 0.1 base-service evidence

Validated on **2026-10-05 (Asia/Taipei)** in the fork checkout, based on upstream
`5937da1cd812660d256c367374b9752316f51cbc`, branch
`feat/cloudflare-backend`. The reviewed change is merged and the isolated TEST
deployment/remote evidence is recorded in [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md).
No real collector configuration change was performed. Tests use only synthetic event content and
temporary private storage; generated logs, databases, binaries and screenshots
remain ignored and outside the staged source.

## Verified

| Check | Result and evidence |
| --- | --- |
| `npm run check` | TypeScript passes for Worker, query/auth modules and review tests |
| `npm test` | **55/55 tests pass**, including 27 forwarding tests and the real workerd/D1/R2 integration suite |
| `npm run test:collector` | **1/1 passes**: compiled unchanged shipping `beacon-hooks` → JSONL → configured forwarder → workerd → D1/R2 → timeline; recreated runtime still reads history |
| Worker-backed browser | Installed headless Chrome passes Basic auth challenge, real D1/R2 timeline rendering, device/harness filtering and 375px layout; no page script errors |
| Browser fixture acceptance | **1/1 passes**: session/event pagination, all filters, adversarial HTML shown as text, denied read access and mobile layout against deterministic mock read APIs |
| MCP | Official current and legacy clients discover four annotated read-only tools and read devices/projects/sessions/R2 timeline through the real Worker router |
| OAuth resource server | Actual workerd downloads synthetic external JWKS; valid scoped JWT accepted, bad signature/claims return 401, insufficient scope returns 403; PRM/challenge and no static-token bypass verified |
| Dashboard Access verifier | Synthetic RSA assertions verify signature, issuer, audience and expiry; forged/expired/mismatched claims rejected |
| Wrangler D1 migration | Full `0001_initial.sql` applied to isolated local D1 with **14 statements**, including indexes/trigger; no remote database accessed |
| Wrangler deployment dry run | Passes; bundled Worker **743.15 KiB / gzip 153.85 KiB**, direct `DB`/`RAW` bindings; no upload/deployment |
| Shipping hook Go suite | `go test ./...` in `cli/beacon-hooks` passes (8 packages containing tests) |
| Shipping exporter Go suite | `go test ./...` in `collector-builder/exporter/beaconjsonexporter` passes (3 packages containing tests) |
| Public-source hygiene | Original license retained; new files/staged diff reviewed; private local paths/outputs ignored; no real credentials or transcripts staged |

The Worker integration specifically exercises anonymous rejection, role
separation, contradictory device claims, token rotation/revocation, exact and
regrouped concurrent retries, same native session IDs on two devices, SSH/HTTPS
project equivalence, nondefault port separation, cursor/filter behavior, whole
batch validation, gzip expansion limits, runtime/inventory namespaces and
distinct raw versions under one logical event.

Independent review fixed two forwarding blockers before cloud rollout: clearing
outboxes on arbitrary HTTP success, and reusing checkpoints across destinations
or device credentials. Tests now require exact bounded Worker acknowledgement,
authenticate destination/device before sending, retain data on malformed replies,
reject mismatched/unbound state and prevent redirect credential leakage.

Deterministic stale-preflight tests make both requests read before either index
transaction commits, then force remote-first/local-second ordering. D1 keeps
remote identity and projects earlier events consistently; differing remotes
produce a transactional 409 with no partially indexed events. R2-first database
failure retains raw evidence and a retry completes the index. A missing R2 object
returns 503. Optional-session records stay separate; project evidence upgrades
unknown→path→remote. Timeline output caps payload memory at 2 MiB and cursor
continuation returns every large synthetic event once.

## Reproduce

```sh
cd workers/beacon-cloud
npm ci
npm run check
npm test
npm run test:collector  # Go is required; builds unchanged shipping hooks into ignored dist/
npm run deploy:dry-run
WRANGLER_WRITE_LOGS=false npx wrangler d1 migrations apply agent-beacon-cloud-db --local --persist-to .test-state/migrations
```

The optional browser tests require an installed Playwright package and browser.
Set `BEACON_PLAYWRIGHT_MODULE` to its module path and, when needed,
`BEACON_CHROMIUM_EXECUTABLE` to the browser binary, then run
`npm run test:workflow-browser` for the real Worker workflow and 背景整理 checks
(set `BEACON_WORKFLOW_SCREENSHOT_DIR` to keep screenshots) or
`npm run test:browser` for fixture interaction
coverage. The normal Node suite deliberately does not require browser downloads.
The CI workflow runs only local tests/dry run and the isolated shipping-hook
acceptance; it contains no deployment credentials or deployment step. Both new
backend runs and all 18 upstream CI jobs passed remotely before merge; links are
in [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md).

## Boundaries and remaining work

- **Cloudflare production:** isolated TEST D1/R2 and Worker deployment, real
  remote acceptance and redeploy persistence passed. No production rollout,
  latency/load/CPU-budget or quota tests, backup restore or cloud rollback ran.
  The test retained the existing account plan and subscriptions.
- **Real Macs:** no MBP/Mac mini telemetry, launchd job, sleep/wake/network-loss
  run, installed collector setting or full OTLP Collector execution was tested.
  The compiled shipping hook consumed synthetic Claude-shaped envelopes; no
  actual Claude session or agent transcript was collected. This upstream generic
  hook retains command/call ID but does not promote supplied stdout/exit_code;
  the test does not invent missing fields.
- **Identity providers:** no external OAuth authorization server was created;
  real OAuth login/discovery, provider signing-key rollover, Access login and
  client-specific SSO remain untested. Manual bearer clients work locally;
  clients requiring OAuth need a configured compatible external issuer.
- **Memory at the 0.1 release:** candidate creation/review was absent. The local
  0.2 milestone above adds manual candidates and reviewer approval. AI generation,
  publication and cross-machine synchronization remain unimplemented.
- **Operational extensions:** no retention/deletion UI, automated R2 orphan
  cleanup/reindex, variant browser, inventory UI, multi-tenant accounts, durable
  jobs or automatic service installation. Forwarder retention is bounded; abrupt
  termination can need verified manual stale-lock removal. See its README for
  copytruncate ambiguity and recovery.
- **Cloudflare inventory:** independent names currently clear; all DNS-record
  reads returned 403, so custom-domain clearance remains unverified. Access API
  visibility does not prove absence of other organization configuration.
- **Upstream sandbox:** free doctor ran, but prerequisite check was not ready
  (Modal/Anthropic credentials and Linux binaries missing). No paid scenario ran;
  the sandbox also cannot establish macOS-specific behavior.

The entire upstream CLI/race/macOS packaging/other plugin suites were not rerun:
their source and configuration were not changed. Relevant shipping hooks and
exporter suites and the new backend's acceptance checks are the evidence here.
