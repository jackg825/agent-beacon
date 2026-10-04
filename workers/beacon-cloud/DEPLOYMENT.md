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
initial migration only to the newly created D1 database:

```sh
npx wrangler d1 migrations apply agent-beacon-cloud-db --remote --config .local/wrangler.production.jsonc
npx wrangler deploy --config .local/wrangler.production.jsonc
# Configure different, random 32-byte-or-longer read secrets via interactive prompts.
npx wrangler secret put READ_TOKEN --config .local/wrangler.production.jsonc
npx wrangler secret put MCP_TOKEN --config .local/wrangler.production.jsonc
```

Deployment before read secrets produces a protected but unusable dashboard/MCP,
not an open read endpoint. No devices can upload until their digests are inserted.
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
