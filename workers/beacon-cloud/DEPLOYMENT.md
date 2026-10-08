# Deployment and recovery preparation

**Rollout scope:** the owner authorized review, merge and an isolated **TEST**
deployment on 2026-10-05. Use `agent-beacon-cloud-test`,
`agent-beacon-cloud-test-db` and `agent-beacon-cloud-test-raw` for that rollout.
The production examples below are a future runbook and require separate approval.
Use the existing account plan; do not change shared resources or subscriptions.
Cloud resource usage follows the account's billing and quotas.
The completed TEST rollout and cloud verification are in
[TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md).

## Isolate the resources first

Recheck the selected account and names at deployment time. The current proposal
is `agent-beacon-cloud` Worker, `agent-beacon-cloud-db` D1 (`DB`) and
`agent-beacon-cloud-raw` R2 (`RAW`). Do not reuse any existing project resources,
change a shared wildcard route, or modify existing websites or organization
Access policies. DNS inventory is incomplete due to permission errors; do not
create a custom domain until that is resolved and separately authorized.

Use an initially independent workers.dev endpoint. The committed Wrangler file
has `workers_dev:false`, `preview_urls:false`, no routes and a placeholder D1
UUID. Keep production account/resource IDs in ignored `.local/` configuration.
Use a deployment credential for only this account/project and runtime credentials
unique to this service; never use an existing project secret or upstream device
token. Leave R2 public access disabled.

After authorization, create new resources (stop if either name already exists):

```sh
cd workers/beacon-cloud
npx wrangler d1 create agent-beacon-cloud-db
npx wrangler r2 bucket create agent-beacon-cloud-raw
```

Create `.local/wrangler.production.jsonc` with private permissions, using this
template. Replace all placeholders with the **new** resources/account. Paths
are relative to that config file, not the shell directory.

```json
{
  "name": "agent-beacon-cloud",
  "account_id": "REPLACE_WITH_SELECTED_ACCOUNT_ID",
  "main": "../src/index.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": true,
  "preview_urls": false,
  "observability": {"enabled": false},
  "vars": {"PUBLIC_URL": "https://agent-beacon-cloud.REPLACE_WITH_SUBDOMAIN.workers.dev"},
  "d1_databases": [{"binding":"DB","database_name":"agent-beacon-cloud-db",
    "database_id":"REPLACE_WITH_NEW_DATABASE_UUID","migrations_dir":"../migrations"}],
  "r2_buckets": [{"binding":"RAW","bucket_name":"agent-beacon-cloud-raw"}]
}
```

No credentials belong in `vars`, git, frontend code, shell arguments, fixtures,
screenshots or logs. `.dev.vars*`, `.wrangler/` and `.local/` are ignored. When
inspecting Cloudflare credentials locally, disable Wrangler debug logging
(`WRANGLER_WRITE_LOGS=false`) and never print or persist retrieved token values.

## Migration, secrets and device provisioning

Use the same explicit production config for every remote command. Apply the
pending additive migrations only to this project's explicitly selected D1 database:

```sh
npx wrangler d1 migrations apply agent-beacon-cloud-db --remote --config .local/wrangler.production.jsonc
npx wrangler deploy --config .local/wrangler.production.jsonc
# Configure different, random 32-byte-or-longer read secrets via interactive prompts.
npx wrangler secret put READ_TOKEN --config .local/wrangler.production.jsonc
npx wrangler secret put MCP_TOKEN --config .local/wrangler.production.jsonc
# Optional central workflow writes: independently generated reviewer secret.
npx wrangler secret put REVIEW_TOKEN --config .local/wrangler.production.jsonc
```

Deployment before read secrets produces a protected but unusable dashboard/MCP,
not an open read endpoint. No devices can upload until their digests are inserted.
The 0.2 and 0.3 changes also require migrations `0002`, `0003` and `0004`. They
add central workflow and background-processing tables/triggers without changing
raw history; 0.3 stays inert after deployment until the opt-in steps in
[Background processing opt-in](#background-processing-opt-in-03) are taken. Back up the
selected D1 database first; use the existing isolated TEST config for a future
TEST upgrade, never a shared database or production example by accident.
Omitting `REVIEW_TOKEN` leaves all workflow writes denied. Never reuse read,
MCP or device secrets for this role. A code rollback leaves the additive tables
and audit history intact; do not drop them as a rollback step. The migration,
backup and restore procedure is in [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md).
Access-only deployments omit `READ_TOKEN` and configure the exact
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` pair for a separately approved application;
the Worker independently checks signature/issuer/audience/expiry. Do not change
organization-wide Access settings. Access can protect browser routes without
blocking device ingest; JWT validation in the Worker remains required.

For OAuth-aware MCP clients, configure an **external authorization server** that
supports the official OAuth2.1 profile and issues signed JWT access tokens for
the exact `https://YOUR_WORKER/mcp` audience and `beacon:read` scope. Set the public
`MCP_OAUTH_ISSUER`, `MCP_OAUTH_JWKS_URL` and `PUBLIC_URL` configuration. Any OAuth
field selects OAuth mode, which disables manual-token fallback; incomplete
configuration fails closed. The Worker exposes
`/.well-known/oauth-protected-resource/mcp` and verifies trusted issuer/JWKS;
it does not issue tokens or host login/consent. Real provider compatibility and
the full login/discovery flow must still be verified before describing it as
ready. Manual `MCP_TOKEN` mode needs a client that supports explicit auth headers.

Prepare each device with a different credential:

```sh
npm run device:prepare -- mbp "MBP"
npm run device:prepare -- mac-mini "Mac mini"
# For each displayed private directory, apply only its digest SQL.
npx wrangler d1 execute agent-beacon-cloud-db --remote --config .local/wrangler.production.jsonc --file PREPARED_DIRECTORY/enroll.sql
```

`device-token` is written once to a 0600 file beneath 0700 `.local`; SQL contains
only its SHA-256 digest. Transfer a device's token securely to that device only.
Follow [forwarder/README.md](forwarder/README.md), configuring separate state
directories, original collector log paths and corresponding project mappings
on each Mac. Starting it is an explicit forwarding consent step. Runtime
defaults to the connection point (`end`), inventory to `beginning`. A mapping
from each checkout path to the same SSH/HTTPS remote avoids path-only project
fragmentation; a local path cannot prove a shared repository by itself.

Do not run `beacon endpoint connect --dashboard-url`, edit the managed Vector
credential file, install launchd jobs, or change collector settings as part of
this runbook unless that separate local configuration change is authorized.

## Background processing opt-in (0.3)

This runbook has **not** been executed in any Cloudflare environment; it describes
a later, separately approved TEST upgrade. Deploying 0.3 changes nothing until each
step below is taken. Policies, field classes, coverage, Jev and the budget are
specified in [BACKGROUND-PROCESSING.md](BACKGROUND-PROCESSING.md).

Prerequisites:

- **Workers Paid on the selected account.** Free crons get 10 ms CPU, 50
  subrequests and 50 D1 queries, too little for any processing tick. Changing the
  account plan is a separate owner decision; this runbook never changes a plan or
  shared subscription. On either plan the code stays inert while
  `MAINTENANCE_TASKS` is unset (a tick then makes no D1 query).
- Registered crons count toward the account's cron-trigger limit; check the
  remaining allowance before adding two.
- **Dedicated secrets only.** `JEV_API_KEY` (and any later generator key) must be
  issued for this service alone. Never borrow a key, token or secret from another
  Cloudflare project, Worker or application, and never reuse read, MCP, review or
  device values.

Steps, shown for the isolated TEST config; keep the explicit `--config` on every
remote command:

1. **Back up first.** Pause this project's forwarders and review writes, export D1
   privately, record a Time Travel bookmark and run the local restore check in
   [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md). Stop if the restore check is incomplete.
2. **Migrate before deploying code.** Apply every pending migration (`0002`/`0003`
   if absent, then `0004`): `npx wrangler d1 migrations apply agent-beacon-cloud-test-db --remote --config .local/wrangler.test.jsonc`.
   The new context queries read `context_generation`; code deployed before `0004`
   makes note queries return `503` (ingest is unaffected).
3. **Register the crons and deploy.** The checked-in `wrangler.jsonc` declares them,
   but deployments use the private config: add
   `"triggers": {"crons": ["*/15 * * * *", "17 * * * *"]}` there (the hourly string
   must stay exactly `17 * * * *`; any other cron runs the frequent schedule), then
   `npx wrangler deploy --config .local/wrangler.test.jsonc`. Confirm it is inert:
   `GET /api/processing/policy` shows `"workspace":null`, `GET /api/processing/usage`
   shows `"allows_calls":false`, and `GET /api/processing/jobs` stays empty after a tick.
4. **Opt into scheduling.** Add `"MAINTENANCE_TASKS": "processing"` to the private
   config's `vars` (it is not a secret) and deploy again. Without a workspace policy
   a tick still plans nothing.
5. **Reviewer policy.** With `REVIEW_TOKEN`, `POST /api/processing/policies` a
   workspace row with `enabled:true`, `external_allowed:false`, `jev_enabled:false`
   and the narrowest useful `summary_fields`, then optional project rows to narrow
   further. Start with synthetic devices and data only.
6. **Run and review.** Wait for the next `*/15` tick or `POST /api/processing/run`
   with one `project_id` or `task_id`. Review the 「自動整理・待審」 candidate with the
   normal approve/reject flow; check job states with `GET /api/processing/jobs`. The
   scheduled log line carries task names, durations, usage counts and codes only.
7. **Controlled Jev test (optional, synthetic data, separate approval).**
   - `npx wrangler secret put JEV_API_KEY --config .local/wrangler.test.jsonc`
     through the interactive prompt, with a key issued only for this service. Never
     put it on a command line, in `vars`, git, fixtures or logs.
   - Set the `EXTERNAL_PROCESSING_PROJECTS` var to the one synthetic test project ID
     (not `*`); set `JEV_ENDPOINT`/`JEV_MODEL` only when the defaults are wrong.
   - Reviewer: project policy with `external_allowed:true`, `jev_enabled:true`,
     `external_fields` limited to `titles` (add `approved_note_text` only for
     synthetic notes) and `jev_skip_threshold:null`; a small budget through
     `POST /api/processing/budget`, e.g.
     `{"daily_call_limit":5,"daily_token_limit":50000,"daily_usd_ceiling":null,"max_input_chars":20000,"max_output_tokens":256,"timeout_ms":10000}`.
   - Check `external_gate` in `GET /api/processing/policy?project_id=…`, then after
     a tick `GET /api/processing/usage` and the job detail (uncalibrated signals,
     ledger statuses, reported cost). Record counts and codes in a new evidence
     file; never print the key or provider responses.
   - Afterwards set the budget limits to 0, remove the project from
     `EXTERNAL_PROCESSING_PROJECTS` and `npx wrangler secret delete JEV_API_KEY --config .local/wrangler.test.jsonc`
     unless continued use was separately accepted.

Stopping and rollback:

- **Stop without a code rollback.** The reviewer sets the workspace policy to
  `enabled:false` (queued jobs then skip with `policy_changed`), or the operator
  removes `processing` from `MAINTENANCE_TASKS` and redeploys. External calls also
  stop when the budget is 0, the project leaves `EXTERNAL_PROCESSING_PROJECTS` or
  `JEV_API_KEY` is deleted. None of these deletes data.
- **Code rollback.** `npx wrangler rollback` to the previous version keeps the
  `0004` tables, jobs, coverage, audits and pipeline candidates. `0004` is additive
  with no down migration; never drop processing tables or delete candidates as a
  rollback step. An older Worker does not read `context_generation`, so it lists
  pipeline candidates as ordinary pending candidates; their creation audit actor
  still reads `pipeline:beacon.extractive@1`. A pre-0.3 version has no scheduled
  handler, and how rollback interacts with registered crons was not tested here:
  check the Worker's schedules afterwards and remove them if they remain.

## Remote acceptance before using real logs

Use synthetic logs and temporary devices first. Repeat local acceptance against
the deployed endpoint: anonymous and cross-role requests denied, device claims
cannot select another namespace, exact/regrouped retries count once, same native
session on two devices stays separate, equivalent remotes share a project, and
dashboard/MCP return the same stored evidence. Restart the forwarder and redeploy
the Worker, then requery the same sessions and R2 payloads. Verify provider login
separately if enabling Access/OAuth.

The opt-in remote acceptance script targets only the exact
`agent-beacon-cloud-test.<subdomain>.workers.dev` hostname. It reads a private
0600 JSON credential file containing distinct `READ_TOKEN`, `MCP_TOKEN` and
`devices.mbp` / `devices.mini` pairs of `id` and `token`. Use synthetic devices,
never installed collector logs. Keep the file, generated state and results in
ignored private `.local/` storage. It invokes unchanged shipping hooks in an
isolated temporary home and sanitizes generated host/path fields before upload.

```sh
npm run test:remote -- --endpoint https://agent-beacon-cloud-test.REPLACE_WITH_SUBDOMAIN.workers.dev
# Redeploy the same Worker with the same D1/R2 bindings, then read the same evidence:
npm run test:remote -- --endpoint https://agent-beacon-cloud-test.REPLACE_WITH_SUBDOMAIN.workers.dev --mode verify
```

The first command persists a private synthetic seed marker; retries reuse the
same evidence. `verify` does not reseed. Optional Playwright environment variables
from [VALIDATION.md](VALIDATION.md) enable authenticated direct HTTPS browser
acceptance. Print only pass labels/counts; do not print credentials or raw responses.

## Recovery and rollback

Pause only this project's forwarders first. Preserve their private outboxes and
checkpoints; do not delete local logs or reset positions to clear an error.
An abrupt kill can leave a lock: verify the owning process is stopped before
removing only `forwarder.lock`, then restart with the same state. Incorrect
credentials/400/409 stop delivery and keep queued batches for operator repair.

For an application regression, record the current deployment and restore the
previous approved Worker version using the explicit private config:

```sh
npx wrangler deployments list --config .local/wrangler.production.jsonc
npx wrangler rollback PREVIOUS_VERSION_ID --config .local/wrangler.production.jsonc
```

A Worker rollback does not roll back D1/R2 data. The initial schema has no
destructive down migration; use forward-compatible additive migrations. Before
any later database change, export this database privately and record a D1 Time
Travel bookmark (where supported). D1 recovery is an independent explicit action
and can discard newer indexes/device rotations; reconcile against retained R2
batches and outboxes before resuming. Code rollback, backup restoration and R2
reindex/garbage collection are not automated or tested in the cloud here.

If retiring the service, disable forwarding and access first, preserve approved
backups, and remove only this project's Worker/bindings/resources after explicit
destructive-action approval. Never delete existing shared resources.

References: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
