# Agent Beacon on Cloudflare Workers

An opt-in backend for this fork. The server executes as a Cloudflare Worker and
accesses **D1 and R2 bindings directly**. MBP and Mac mini keep their existing
local Beacon collectors and each run an explicitly configured JSONL forwarder.
There is no central Mac/VPS process or Cloudflare Tunnel. This package requires
no changes to upstream collectors, adapters, local dashboard or local MCP.

**Review state:** the base ingest service (0.1) is merged and deployed to isolated
**TEST** Workers/D1/R2; its cloud evidence is in [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md).
The 0.2 project/task/manual-review milestone and the 0.3 background-processing
milestone built on it are reviewable changes validated **locally only** with
synthetic data. Neither has been migrated (`0002`–`0004`) or deployed to
Cloudflare, no cron has run in the cloud, and no external evaluator has been called.
Production rollout and real collector
configuration remain separate. Start with
[VALIDATION.md](VALIDATION.md), [WIRE-CONTRACT.md](WIRE-CONTRACT.md) and
[DEPLOYMENT.md](DEPLOYMENT.md). For two-Mac setup, see [MAC-SETUP.md](MAC-SETUP.md).
For central task handoffs and reviewed notes, see [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md);
for the opt-in background pipeline, see [BACKGROUND-PROCESSING.md](BACKGROUND-PROCESSING.md);
the staged remaining work is in [ROADMAP.md](ROADMAP.md).

## What is implemented

| Capability | Implementation |
| --- | --- |
| Device ingest | Per-device bearer key; D1 stores SHA-256 digest only; revocation and rotation retain the device namespace |
| Raw history | Content-addressed, private R2 NDJSON batches; gzip and decoded bodies bounded to 1 MiB |
| Central queries | D1 devices/projects/sessions/events/versions; transactional index writes and keyset pagination |
| Replay | Logical dedup by device + stream + upstream `event.id`, including retries with different batch boundaries |
| Session identity | Device + harness + native session ID; missing session IDs remain individual explicitly unscoped records |
| Projects | SSH/HTTPS Git remote normalization, `.git` suffix and default ports; path-only records use explicit mappings or a device-local namespace |
| Project relationships | Explicit groups and directed dependency/shared-service/fork relations; repositories remain independent |
| Task handoffs | Explicit cross-device/repository session links, open/completed state, group/task filters and atomic audit records |
| Reviewed context | Manual or pipeline-generated summary/memory candidates with exact event/version sources and an `origin`; pending/approved/rejected/superseded states, immutable revisions and atomic review audit |
| Background processing | Off by default. Workspace-ceiling policies with field classes, redacted projections, coverage-based durable jobs (leases, fenced completion, retry/dismiss) and `beacon.extractive.v1` rule summaries that become pending 「自動整理・待審」 candidates; optional signal-only Jev behind the `EXTERNAL_PROCESSING_PROJECTS` deploy gate, a dedicated key and an atomic daily call budget. No model generation |
| Scheduled maintenance | Two crons; a task runs only when `MAINTENANCE_TASKS` names it (`processing` is the only task today), within metered per-task D1/R2/fetch allotments and a shared time budget; reports carry codes and counts only |
| Dashboard | Protected views for activity, project relations, handoffs/memory and 背景整理 (policies, jobs, budget/usage, uncalibrated signals); all recorded and authored content renders as text |
| Remote MCP | Official TypeScript SDK, current and legacy Streamable HTTP; 15 read-only tools, default context recall requires valid approved scope |
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
and apply all migrations locally. To try group/task creation and context review,
uncomment `REVIEW_TOKEN` and replace its placeholder with a third independent
random private value. Omitting it keeps writes denied:

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
For writes, enter that independent reviewer value in the dashboard's
「管理與審閱權限」 field; it lasts only for the current page.
Forwarder config paths must be absolute; use a temporary **synthetic** JSONL
source during review. Never point development at real transcripts accidentally.

## HTTP surfaces and authorization

| Route | Access |
| --- | --- |
| `GET /health` | Public liveness only; no data or dependency state |
| `GET /v1/ingest/health` | Device token |
| `POST /v1/ingest/runtime`, `/v1/ingest/inventory` | Device token; NDJSON, 1–100 events and ≤1 MiB |
| `GET /`, `/dashboard`, `/dashboard.js`, `/api/*` | Verified Access JWT or separate dashboard read secret |
| `GET /api/processing/policy`, `/jobs`, `/jobs/:id`, `/usage` | Same read authority; identifiers, states, counts, hashes and short codes only, never event content |
| `POST /api/project-groups*`, `/api/project-relations`, `/api/tasks*`, `/api/context*` | Separate `REVIEW_TOKEN`; bounded JSON and same-origin browser requests |
| `POST /api/processing/policies`, `/budget`, `/run`, `/jobs/:id/retry`, `/jobs/:id/dismiss` | Same `REVIEW_TOKEN` rules; none can approve a candidate or open the deploy gate |
| `POST /mcp` | Dedicated manual MCP token, or configured OAuth resource-server mode |
| OAuth protected-resource metadata | Public, only when valid OAuth resource-server configuration is present |
| Cron `*/15 * * * *`, `17 * * * *` | No HTTP surface; runs only the tasks named in the `MAINTENANCE_TASKS` var (none by default) |

Read APIs are `/api/devices`, `/api/projects`, `/api/sessions`, and
`/api/sessions/:central_id/events`. Sessions filter by `device_id`, `project_id`
and `harness`, plus `project_group_id` and `task_id`; use returned `next_cursor` as `before`. Events use `after`.
Page size is 1–40; timelines also stop at 2 MiB of payloads and return a cursor.
Device/project pickers return at most 1,000 entries.
Inventory has a raw store and event index, but no separate inventory browser.
Additional read APIs cover groups, relations, tasks and reviewed context; see
[the workflow contract](CONTEXT-WORKFLOWS.md). Exact variant reads use
`GET /api/events/:central_id?payload_hash=...`; `/versions` lists variant hashes.
Background processing reads and writes are listed in
[BACKGROUND-PROCESSING.md](BACKGROUND-PROCESSING.md#api).
MCP additionally lists/reads groups, tasks, context and processing jobs, and reads
exact event versions. The 15 tools are `beacon_list_sessions`, `beacon_get_timeline`,
`beacon_list_projects`, `beacon_list_devices`, `beacon_list_project_groups`,
`beacon_get_project_group`, `beacon_list_project_relations`, `beacon_list_tasks`,
`beacon_get_task`, `beacon_list_context`, `beacon_get_context`, `beacon_get_event`,
`beacon_list_event_versions`, `beacon_list_processing_jobs` and `beacon_get_processing_job`.
Every tool is read-only; none can approve, publish, configure, run processing or write.
Only context with `authoritative:true` is eligible as reviewed knowledge; even
approved prose is data, never a permission grant or instruction override. Pending
pipeline candidates and uncalibrated evaluator signals are not approved knowledge.

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
first indexed capture and a `versions` count. Exact variant reads verify the
stored hash and expose whether its raw repo/session/harness matches the logical
index. Context creation/approval rejects mismatched variants. Variant selection
on the general timeline and semantic reconciliation remain future work.
Do not interpret dedup as proof all payloads were identical.
Session project attribution upgrades unknown→path→remote and cannot downgrade a
remote. Conflicting remotes for the same native session return 409 atomically.

Background processing tables (`0004`) are additive and separate from ingest:
ingest never reads or writes them, so a failing job, evaluator or dropped
processing table cannot change an acknowledgement. Jobs track **coverage** per
scope instead of a timestamp watermark, so backfilled or late-linked events are
still summarized; planning reads only D1 and a job reads R2 only after claiming
its lease and rechecking policy and scope. A candidate, its sources, coverage and
the job's completion commit in one fenced D1 batch, and `context_generation.job_id`
is unique, so a retry cannot create a second candidate. The processing call budget
is the only quota enforced beyond per-request/forwarder limits.

No retention policy, deletion workflow or backup scheduler is installed; the
hourly cron is reserved for later maintenance and runs nothing today. R2/D1 data
must remain private; do not enable R2 public access. Local redaction policy still
determines retained content. The uploader does not add a metadata-only/privacy
transform; background processing redacts only its own projections and summaries
and never rewrites stored raw history.

## Memory boundary

The 0.2 milestone implements manually authored candidates and explicit reviewer
approval/rejection with exact source versions and audit records. A revision is a
new pending record; its parent stays approved until the new version is approved.
Concurrent approvals cannot both replace the same current parent. Invalid source
scope is excluded from default recall, and lost/corrupt raw evidence blocks approval.

Review writes require a separate secret; Access/read/device/MCP authorization
does not confer review authority. The shared secret identifies a reviewer role,
not a named person's identity or cryptographic proof of human review.

The 0.3 milestone adds the opt-in background pipeline. Its output is always a
**pending** `summary` candidate (`origin:"pipeline"`, actor
`pipeline:beacon.extractive@1`, no `supersedes_id`) built by local rules from the
redacted projection with numbered citations to exact source versions. It goes
through the same reviewer approval as a manual candidate; a 0004 trigger stops any
`pipeline:` actor from approving or rejecting. Jev, when an operator and reviewer
both enable it, only stores uncalibrated signals: it never approves, edits,
deletes or (by default) skips anything. Model generation is deferred until a
provider, model, dedicated secret, sendable data scope and daily USD cap are
recorded; there is no `GENERATOR_*` configuration. Publication and cross-Mac
memory application are not implemented; see [ROADMAP.md](ROADMAP.md) and
[BACKGROUND-PROCESSING.md](BACKGROUND-PROCESSING.md).

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
