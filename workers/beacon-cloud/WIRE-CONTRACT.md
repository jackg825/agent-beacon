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

## Boundaries

The adapter is an explicitly started process alongside the existing collector.
No launchd/systemd job, collector settings, normal Beacon hook path, local MCP
listener or local dashboard behavior is changed. It forwards content already
retained by Beacon; it does not implement a new redaction or metadata-only
policy. Review collection policy before pointing it at real logs.

Central context is a separate workflow: the 0.2 feature branch adds manually
authored candidates, exact event-version sources and explicit reviewer approval.
See [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md). Raw JSONL ingestion does not
generate or approve a candidate. AI generation, file publication and
machine-to-machine memory synchronization remain unimplemented.
