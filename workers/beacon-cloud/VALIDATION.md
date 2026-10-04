# Review evidence

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
`BEACON_CHROMIUM_EXECUTABLE` to the browser binary, then run `npm test` for the
real Worker-backed helper or `npm run test:browser` for fixture interaction
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
- **Memory:** candidate generation, human review/approval, promotion, publication
  and cross-machine synchronization are not implemented. The README defines
  their future evidence/approval boundary only.
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
