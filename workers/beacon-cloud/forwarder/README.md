# Opt-in local forwarder

This small Node.js shipper reads Beacon's existing runtime/inventory JSONL,
durably queues batches, and sends them to the isolated Worker. It runs beside
the existing collector on each Mac. No tunnel, central Mac service, enrollment
flow, or collector configuration change is needed. Node.js 22 or newer is
required.

No forwarding is started by installing this package or running its tests.
Production deployment and changing real local forwarding settings remain
separate steps requiring authorization.

## Configure outside the checkout

1. Copy `config.example.json` to a private configuration directory outside the
   public repository. Replace every placeholder with an absolute local path or
   the isolated Worker URL. Do not add a token to that JSON.
2. Place the separately provisioned **per-device Worker token** in the file
   named by `tokenFile`; make it mode `0600`. Use a different token on each Mac.
   Do not reuse Beacon's hosted account/enrollment credentials.
3. Choose a private `stateDir` with mode `0700`. It contains retained telemetry,
   durable outbox files and checkpoints. Do not place it in the public checkout,
   a shared directory, or cloud synchronization storage.
4. Review stream scope and project mappings. Runtime defaults to `readFrom:
   "end"`, which skips events already present on the first run. Inventory
   defaults to `"beginning"` to send retained baseline snapshots. Set runtime
   to `"beginning"` only when historical backfill is intentional. Each stream
   follows the active file plus five numbered archives by default.

Paths are literal: there is no `~` or environment-variable expansion. The usual
user-mode source files are `~/.beacon/endpoint/logs/runtime.jsonl` and
`~/.beacon/endpoint/logs/inventory_state.jsonl`; write their expanded absolute
paths into your private config. System-mode files are usually
`/var/log/beacon-agent/runtime.jsonl` and its inventory sibling. The adapter only
reads them.

An explicit `projectMappings` entry can map each Mac's distinct checkout path
to the same Git remote. It uses the longest matching prefix, respects observed
Git remotes in `project.remote`, `vcs.repository.url.full`, `repository` and
`run.repository`, and keeps all source fields. Local paths and `file://` context
can be enriched with a mapping. Do not embed credentials
in remotes. See [WIRE-CONTRACT.md](../WIRE-CONTRACT.md).

## Run deliberately

From this package's directory, using a config you reviewed:

```sh
node forwarder/forwarder.mjs /ABSOLUTE/PRIVATE/PATH/config.json --once
node forwarder/forwarder.mjs /ABSOLUTE/PRIVATE/PATH/config.json
```

`--once` reads currently available complete lines, queues them and attempts to
drain the outbox. The long-running form repeats and retries with capped
exponential delay during failures. SIGINT/SIGTERM allow it to finish the current
pass, then release the lock. Installation as a launchd/systemd service is not
performed or verified by this implementation.

Output contains only counts and fixed failure codes. A result's `blocked` field
means outstanding data remains queued, including for authentication failures.
It never prints a credential, event body, response body, endpoint URL, or local
path. `full: true` means the queue cap prevented reading more source data; that
pass can still send already queued batches. Fix the underlying failure and
allow the next pass to resume.

The HTTPS requirement can be relaxed **only** for loopback synthetic testing:
`"allowLocalHttp": true` together with a localhost/127.0.0.1/[::1] endpoint.
Non-loopback HTTP and credential-bearing endpoint URLs are rejected. Redirects
are rejected so a bearer token cannot be forwarded to a different service.

## Durability and recovery

Each immutable queue file is written, synced and atomically renamed before
its source offset is checkpointed. Checkpoints are atomically replaced and
synced. A crash between these operations may re-read an event; server duplicate
protection by device, stream and `event.id` prevents duplicate indexed events.
A successful response is acknowledged by deleting and syncing the queue file.
An uncertain acknowledgement resends the identical batch.

Physical device/inode identity follows rename rotation. Stored file prefixes
and offsets detect ordinary copytruncate and reused inodes; the new generation
is replayed from the beginning and duplicate protection handles overlap. An
unfinished final JSONL line stays unread until a newline arrives. A runtime
connection initialized inside a prior unfinished line skips that prior line
when it finishes, preserving the connection's consent boundary.

Only one process may use a state directory. Normal shutdown releases
`forwarder.lock`; an abrupt kill may leave it. If startup reports
`FORWARDER_LOCKED`, inspect the local lock's `pid`, confirm that process is not
running the forwarder, and remove **only** `forwarder.lock` before restarting.
Retain `checkpoint.json` and `outbox/`. Stale lock recovery is deliberately
manual; automatically deleting another process's lock risks concurrent readers.

Invalid JSON, malformed events, corrupt checkpoints/outbox, and oversized
individual events stop the pass and retain the checkpoint. Fix the source or
configuration under an explicit recovery decision; the forwarder does not
silently discard a poison record or split an individual event. Non-2xx server
responses retain the queue even when they require operator action.

The 512 MiB queue cap is configurable. When full, sources stop advancing.
Beacon still independently rotates its own logs, so an offline period longer
than both available outbox capacity and local archive retention can lose
unread source data. This MVP does not promise unlimited offline retention or
detect every missed rotation. Copytruncate with an identical prefix and a
rewritten file already longer than its old offset is indistinguishable from
append; Beacon's normal rename rotation is the supported path. The adapter
does not change retention or delete source logs. Checkpoint entries are kept to
recognize retained rotations and may grow over long deployments.

Keep outbox and checkpoints together when migrating or backing up this process.
Resetting checkpoints with `readFrom: "end"` can skip unqueued source history;
resetting them with `"beginning"` replays retained logs. Queued batches retain
the project mapping selected when they were queued.

## Synthetic validation

```sh
node --test forwarder/forwarder.test.mjs
```

The tests use temporary files, synthetic telemetry and a synthetic credential;
they do not inspect your Beacon logs or contact a real cloud service. They cover
durable retries and restart, uncertain acknowledgement, checkpoint recovery,
rotation/copytruncate, partial lines, the runtime start boundary, inventory IDs,
project mapping, batch/queue limits, HTTP failures and private file permissions.
The package's integration suite can import `runOnce(configPath)` to exercise
synthetic producer → forwarder → local workerd → D1/R2 → query end to end.

An additional shipping-producer check requires the repository's Go toolchain:

```sh
npm run test:collector
```

It compiles the unchanged `cli/beacon-hooks` binary into ignored `dist/`, invokes
its real `session-start` and `post-tool` commands with synthetic Claude-shaped
JSON stdin under an isolated temporary child HOME/config/workspace, and forwards
the resulting JSONL into actual local workerd D1/R2. It verifies retained command
and call identity, queries the data, recreates the Worker runtime against the
same persisted storage, and checks that restarting the shipper does not duplicate
events. No installed agent configuration or existing collector logs are read.
The supplied runtime envelopes describe synthetic activity; no Claude Code
session is started. This verifies the shipping hook capture/writer path, without
claiming a running OTLP Collector or real agent-runtime integration was exercised.
The generic upstream Claude hook mapper currently retains the command and call
ID but does not promote this fixture's `tool_response.stdout`/`exit_code` into
`command.*`; the test preserves that actual behavior.

The unchanged shipping hook and exporter module suites were also run successfully
for this review:

```sh
go -C ../../cli/beacon-hooks test ./...
go -C ../../collector-builder/exporter/beaconjsonexporter test ./...
```

The synthetic shipper suite passed 21 tests; the compiled hook/workerd acceptance
passed 1 test. Go's module suites passed all packages that contain tests.

No paid sandbox run, live deployment, real Mac collector/service installation,
real transcript upload, or power-loss filesystem test is claimed by these tests.
