# Beacon local logs to the isolated Worker

This adapter uses Beacon's existing customer-managed JSONL handoff. It does not
replace a collector, modify an agent integration, or implement Beacon Cloud
account enrollment. `beacon endpoint connect --dashboard-url ...` cannot configure
this Worker: that command expects the upstream OAuth and enrollment APIs.

## Verified upstream contract

The sources for these decisions are the checked-out upstream files, rather than
an assumed compatibility layer:

| Contract | Repository source |
| --- | --- |
| JSONL event shape and validation | `pkg/asymptoteobserve/event.go` |
| Stable event identity is **`event.id`**, not top-level `event_id` | `pkg/asymptoteobserve/identity.go` |
| HTTP transport, auth, buffering and endpoints | `cli/beacon/internal/endpoint/asymptote/pack/vector.toml.tmpl` |
| User and system log locations, numbered rotation | `docs/log-forwarding/local-jsonl.mdx` |
| Customer-managed shipper ownership boundary | `docs/concepts/vector-forwarding.mdx` |
| Inventory log path | `cli/beacon/internal/endpoint/inventory/heartbeat.go` |

Beacon emits `vendor: "beacon"`, `product: "endpoint-agent"`,
`schema_version: "1.0"`; events carry `timestamp`, `event.kind`, `event.action`,
`severity`, `endpoint.os`, and `harness.name`. Runtime records can also carry
`session.id`, `session.working_directory`, `trace`, `gen_ai`, and locally retained
content. The adapter preserves those fields. Stable IDs in current logs are
nested in `event.id`; Beacon derives them with a namespaced UUID v5 function.
The adapter preserves existing IDs exactly and does not attempt to reproduce
upstream's call-ID normalization. In upstream's call-ID mode, the same session,
normalized action/target and tool call ID produce the same `event.id` across
hook and OTLP reports, even when timestamps, harness labels or retained payloads
differ. In its content mode, the serialized event supplies identity. Therefore
equal `event.id` does not require equal JSON payload bytes. The shipper forwards
all records, including these variants; it does not suppress them locally.

The managed Vector template sends each retained line as newline-delimited text,
with bearer device authentication, `Content-Type: application/x-ndjson`, gzip,
and `POST /v1/ingest/runtime` or `/v1/ingest/inventory`. Its authenticated health
endpoint is `GET /v1/ingest/health`. It starts runtime at the connection point and
inventory at the beginning, maintains file checkpoints, and uses a durable disk
buffer. The template's 5 MB / 5,000-event batch settings are larger than this
Worker MVP accepts, so copying that template unchanged is not a supported setup.

## MVP adapter contract

The standalone `forwarder/forwarder.mjs` sends uncompressed NDJSON to the same
two ingest paths using a credential provisioned specifically for this Worker.
It does not use or copy an upstream Beacon account token or `bcn_device_*` key.
Each request is at most 100 events and 1 MiB including newlines; the Worker also
supports bounded gzip requests. A non-2xx response or uncertain network outcome
leaves the exact batch in the outbox for retry. A successful response means the
Worker acknowledged ingestion; a subsequent retry must be harmless.

The forwarder first verifies authenticated `GET /v1/ingest/health` and binds
its checkpoints/outbox to the returned device ID and Worker origin. A previously
bound source can spool locally offline, but cannot upload with an unverified
replacement credential. A fresh state waits for its first successful health
check before initialization. Same-device token rotation retains its namespace;
different-device tokens or different Worker origins fail closed.

Ingest acknowledgement must be a bounded JSON response with the exact event
count in `accepted` and expected `batch_id`. The batch ID is
`sha256(JSON.stringify([device_id, stream, sha256(outgoing_utf8_ndjson_bytes)]))`,
which matches the Worker's stable-JSON hashing of this array of strings.
Generic HTTP 2xx, HTML, malformed JSON and mismatched acknowledgements never
clear the outbox. Both health and ingest reject redirects.

The device's authoritative identity comes from its bearer token, never from
`endpoint.hostname` or payload assertions. The Worker scopes duplicate event
IDs by authenticated device and stream; it scopes sessions by device, harness,
and session ID. Two Macs can therefore use the same local session ID without
merging sessions. Different per-device credentials are required.

The Worker indexes one logical event per device, stream and upstream `event.id`.
Its `event_versions` table separately retains distinct canonical JSON payload
hashes with their R2 batch/line references. Raw R2 batches retain every incoming
line, including same-ID hook/OTLP variants. The timeline currently returns the
first indexed payload and a `versions` count, rather than merging the payloads
or returning every variant inline. Exact repeated batches use stable hashes
scoped by device and stream, making retries idempotent without dropping a
different payload version. Version browsing/merging is not implemented.

Legacy or inventory records without `event.id` receive
`forwarder-sha256:<hex digest>` derived from the original UTF-8 JSON line before
any enrichment. This is a transport fallback, not upstream UUID v5 parity.
Re-reading the same line after rotation, changing a local project mapping, or
retrying a queued body does not change the fallback ID. Changing serialized
bytes of an ID-less event does change it; two byte-identical ID-less records are
indistinguishable and deduplicate. Keep current Beacon writers' IDs when available.

## Project identity

Beacon can expose a credential-stripped Git remote as
`vcs.repository.url.full`, with additional context in `repository` or
`run.repository`. Some events expose only a local `file://...` repository path or
`session.working_directory`. A local path alone cannot establish that two Macs
mean the same project.

The adapter accepts explicit `projectMappings` from an absolute checkout path
to a safe Git remote. It uses the longest path-prefix match and adds
`project.remote` only when no supported Git URL/SCP remote is present in
`project.remote`, `vcs.repository.url.full`, `repository` or `run.repository`.
Local paths and `file://` values can be enriched. Existing fields remain intact;
no Git commands or filesystem project
discovery run implicitly. Configure corresponding paths on both Macs with the
same repository identity. The Worker normalizes HTTPS and SSH remotes, `.git`
suffixes and local checkout differences into its project key. Events without
an observed remote or explicit mapping remain device-local projects.

An uploader can report any project metadata under its own device identity;
repository attribution is not a Git ownership proof. SSH URLs in configuration
must use `git` as the username, and HTTPS URLs must have no credentials, query
or fragment. Never embed tokens in a repository URL.

## Device sync read contract (0.4)

This is a Worker-defined contract, not an upstream Beacon one: upstream has no
equivalent, and only `forwarder/sync.mjs` consumes it. It is the one capability a
device key has beyond ingest, and it is read-only. Every request uses the same
bearer device key as ingest and is `GET`; another method answers `405`, an unknown
`/v1/sync/` path `404`, and a missing or revoked key `401`. Read, MCP and review
credentials cannot use these paths, and a device key cannot use `/api/*`.

`GET /v1/sync/subscriptions` takes no query (any parameter answers `400`) and
returns `{"device_id": ..., "subscriptions": [...]}`: only this device's active
grants, at most 100, ordered by creation time then ID, each
`{id, project_id, kinds, include_shared, created_at}`. `kinds` is a non-empty subset
of `["memory","summary"]` in that order.

`GET /v1/sync/snapshot?project_id=<64 lowercase hex>` accepts only `project_id`;
`kind` or any other parameter answers `400`, because the subscription alone decides
the kinds and whether shared memories are included. No active grant for this device
and project, a grant belonging to another device, a revoked grant and a project that
does not exist all answer the **same** `403` body. A snapshot above 500 entries or
2 MiB of UTF-8 title plus content answers `413` before any content is read; it is
never truncated. A successful response is
`{"snapshot": {schema, project_id, kinds, include_shared, entry_count, content_bytes, reviewed_through, snapshot_sha256, entries, subscription_id}}`:

| Field | Meaning |
| --- | --- |
| `schema` | `beacon.context.snapshot.v1` |
| `entries` | The project's approved, authoritative notes of the granted kinds (the same set default recall returns), decided at read time, ordered by `kind`, creation time, then `id`. Each is `{id, kind, title, content, content_sha256, task_id, supersedes_id, reviewed_at, valid_from}`, with `valid_from` equal to `reviewed_at` |
| Shared entries | Only when the grant has `include_shared`: memories a reviewer shared to this project from another one, while the share is active and the note is still approved with valid sources. They carry two extra fields, `shared_from_project_id` (never this project) and `share_id`; own entries never carry them, and summaries are never shared |
| `content_sha256` | Lowercase hex SHA-256 of the entry's `content` as UTF-8 |
| `snapshot_sha256` | Lowercase hex SHA-256 of the UTF-8 sorted-key JSON (the same `stableJSON` used for batch IDs: object keys sorted, arrays in order, scalars as `JSON.stringify`) of `{schema, project_id, kinds, entries}` |
| `reviewed_through` | The newest `reviewed_at` among the entries, or `null` |

`include_shared`, `entry_count`, `content_bytes`, `reviewed_through` and
`subscription_id` are outside the hash. Because own entries keep exactly this shape,
a snapshot with no shared entry hashes the same whether or not the grant includes
shared memories. A new pending candidate leaves the hash unchanged; an approval, a
supersession, a source-scope change and, under an `include_shared` grant, a new or
revoked share alter it. The sync tool
recomputes every `content_sha256` and the `snapshot_sha256`, rejects a shared marker
that is malformed, names this project or sits on a summary, and refuses redirects.
Reviewers create and revoke grants through `/api/sync/*`; see [MAC-SYNC.md](MAC-SYNC.md).

## Boundaries

The adapter is an explicitly started process alongside the existing collector.
No launchd/systemd job, collector settings, normal Beacon hook path, local MCP
listener or local dashboard behavior is changed. It forwards content already
retained by Beacon; it does not implement a new redaction or metadata-only
policy. Review collection policy before pointing it at real logs.

Central context is a separate workflow: manually authored or rule-generated
candidates, exact event-version sources and explicit reviewer approval. See
[CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md). Raw JSONL ingestion does not
generate or approve a candidate. AI generation and automatic publication remain
unimplemented; the only machine-bound copy of approved notes is the explicit,
user-run sync above, which writes a Beacon-owned `.beacon.md` file and never an
agent instruction file or collector setting.
