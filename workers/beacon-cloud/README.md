# Agent Beacon on Cloudflare Workers

An opt-in backend for this fork. The server executes as a Cloudflare Worker and
accesses **D1 and R2 bindings directly**. MBP and Mac mini keep their existing
local Beacon collectors and each run an explicitly configured JSONL forwarder.
There is no central Mac/VPS process or Cloudflare Tunnel. This package requires
no changes to upstream collectors, adapters, local dashboard or local MCP.

**Review state:** independently reviewed and verified locally with workerd and
synthetic data. The first authorized cloud rollout uses isolated **TEST** resources;
production rollout and real collector configuration remain separate. Start with
[VALIDATION.md](VALIDATION.md), [WIRE-CONTRACT.md](WIRE-CONTRACT.md) and
[DEPLOYMENT.md](DEPLOYMENT.md). For two-Mac setup, see [MAC-SETUP.md](MAC-SETUP.md).

## What is implemented

| Capability | Implementation |
| --- | --- |
| Device ingest | Per-device bearer key; D1 stores SHA-256 digest only; revocation and rotation retain the device namespace |
| Raw history | Content-addressed, private R2 NDJSON batches; gzip and decoded bodies bounded to 1 MiB |
| Central queries | D1 devices/projects/sessions/events/versions; transactional index writes and keyset pagination |
| Replay | Logical dedup by device + stream + upstream `event.id`, including retries with different batch boundaries |
| Session identity | Device + harness + native session ID; missing session IDs remain individual explicitly unscoped records |
| Projects | SSH/HTTPS Git remote normalization, `.git` suffix and default ports; path-only records use explicit mappings or a device-local namespace |
| Dashboard | Protected session list, device/project/harness filters and paginated event timeline; raw content only enters DOM text nodes |
| Remote MCP | Official TypeScript SDK, current per-request protocol and legacy Streamable HTTP; four read-only tools |
| Local forwarding | Private durable outbox/checkpoint bound to authenticated Worker/device, exact batch acknowledgement, bounded retry/rotation, explicit start point and queue cap |

No account OAuth/device-enrollment APIs from proprietary Beacon Cloud are
emulated. `beacon endpoint connect --dashboard-url` is therefore not a setup
command for this backend. Use the separate [forwarder](forwarder/README.md).
The central service is a single private workspace, not a multi-tenant SaaS.
Registered device names are authoritative; a payload's hostname, repository or
transcript is untrusted observed metadata, not a claim of ownership.

## Local review

Requires Node 22+; the optional genuine hook producer check also requires Go.

```sh
cd workers/beacon-cloud
npm ci
npm run check
npm test
npm run deploy:dry-run
```

These commands use synthetic credentials and temporary isolated storage. They
do not read installed Beacon logs or create remote resources. The dry run
bundles only. The checked-in Wrangler file disables workers.dev and previews,
sets no routes and uses a placeholder database UUID.

For a manually started local dashboard, copy `dev-secrets.example` to ignored
`.dev.vars`, replace both placeholders with different random private values,
and apply the migration locally:

```sh
npx wrangler d1 migrations apply agent-beacon-cloud-db --local
npm run device:prepare -- synthetic-mbp "Synthetic MBP"
# The prepare command writes a private token file and enroll.sql; prints no token.
# Replace PREPARED_DIRECTORY with its displayed local directory.
npx wrangler d1 execute agent-beacon-cloud-db --local --file PREPARED_DIRECTORY/enroll.sql
npm run dev
```

Open the local dashboard and use browser Basic authentication: username
`beacon`, password your private `READ_TOKEN`. The HTML, script and APIs require
read authorization. No token is placed in URLs, HTML, localStorage or logs.
Forwarder config paths must be absolute; use a temporary **synthetic** JSONL
source during review. Never point development at real transcripts accidentally.

## HTTP surfaces and authorization

| Route | Access |
| --- | --- |
| `GET /health` | Public liveness only; no data or dependency state |
| `GET /v1/ingest/health` | Device token |
| `POST /v1/ingest/runtime`, `/v1/ingest/inventory` | Device token; NDJSON, 1–100 events and ≤1 MiB |
| `GET /`, `/dashboard`, `/dashboard.js`, `/api/*` | Verified Access JWT or separate dashboard read secret |
| `POST /mcp` | Dedicated manual MCP token, or configured OAuth resource-server mode |
| OAuth protected-resource metadata | Public, only when valid OAuth resource-server configuration is present |

Read APIs are `/api/devices`, `/api/projects`, `/api/sessions`, and
`/api/sessions/:central_id/events`. Sessions filter by `device_id`, `project_id`
and `harness`; use returned `next_cursor` as `before`. Events use `after`.
Page size is 1–40; timelines also stop at 2 MiB of payloads and return a cursor.
Device/project pickers return at most 1,000 entries.
Inventory has a raw store and event index, but no separate inventory browser.
Query tools are `beacon_list_sessions`, `beacon_get_timeline`,
`beacon_list_projects`, `beacon_list_devices`; there are no write/configuration
or memory tools.

The dashboard can verify Cloudflare Access assertions against a configured
team issuer/JWKS and exact application audience. A header alone never grants
access. Manual dashboard/MCP secrets are separate from device keys. Configure
only the methods you intend to allow; omit `READ_TOKEN` when using Access only.
Same-origin browser requests are enforced. Native clients can omit Origin.
Use an explicit `PUBLIC_URL` on deployment so origin checks do not rely on the
incoming URL. There is no cross-origin CORS grant.

MCP manual-token mode supports clients that can send a provisioned bearer
header. It does not provide OAuth login or discovery. The optional configured
OAuth resource-server mode advertises RFC9728 metadata and verifies external
JWTs against its trusted issuer/JWKS, exact `/mcp` audience and `beacon:read`
scope. Provisioning an OAuth authorization server and verifying a real provider
login are separate deployment work; dashboard Access is not automatically that
authorization server. Do not claim an unconfigured OAuth deployment is ready.

## Storage and consistency

R2 raw objects are written before a single D1 index transaction. Only after both
succeed does ingest return 2xx. A crash or conflicting project can leave an R2
orphan without an indexed batch; retrying identical bytes completes the index
without creating duplicate logical events. There is no distributed transaction
across R2/D1 and no automatic orphan garbage collection in this version. Missing
raw objects fail queries with 503 rather than pretending a timeline is complete.

Upstream hook and OTLP captures can share `event.id` while carrying different
fields. `event_versions` preserves those raw variants; the timeline returns the
first indexed capture and a `versions` count. Variant browsing and reconciliation
are not implemented. Do not interpret dedup as proof all payloads were identical.
Session project attribution upgrades unknown→path→remote and cannot downgrade a
remote. Conflicting remotes for the same native session return 409 atomically.

No retention policy, deletion workflow, backups scheduler or quota enforcement
beyond per-request/forwarder limits is installed. R2/D1 data must remain private;
do not enable R2 public access. Local redaction policy still determines retained
content. The uploader does not add a metadata-only/privacy transform.

## Memory boundary

This release provides read-only evidence for a future reviewed memory workflow.
It does **not** generate, approve, publish, synchronize or apply memories.

The proposed future states are candidate → reviewed → approved → optionally
published, with rejected/superseded terminal states. Candidates must reference
immutable device/session/event/version identities, retain provenance and scope,
and remain untrusted until a human reviewer approves them. Approval must be a
separate authenticated write and audit record; machine collection or an MCP read
must never imply approval. Revisions require a new version and review. Cross-Mac
memory publication needs explicit destinations and opt-in, rather than merging
local SQLite/JSONL files. No such schema, endpoint or UI is implemented here.

## Sources and license

Wire sources are pinned to upstream commit
`5937da1cd812660d256c367374b9752316f51cbc` (see WIRE-CONTRACT).
Runtime integration follows [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[R2 Workers bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and
[Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
MCP uses the [official Web Standard SDK integration](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.html),
[current transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) and
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
The repository's original [MIT license](../../LICENSE) and copyright notices are
retained unchanged.
