# Cloudflare TEST acceptance

This records the **0.1 base service** only, not the 0.2 project/task/context, 0.3
background-processing or 0.4 Mac sync and data-operations milestones, none of which
has been deployed. For their local-only validation see [VALIDATION.md](VALIDATION.md).

Completed **2026-10-05 (Asia/Taipei)**. The owner authorized review, merge and a
test rollout. [PR #1](https://github.com/jackg825/agent-beacon/pull/1) is merged
into the owner's public fork. Deployed runtime source:
`8dd9e837a19b213f11d7ea355c960f2ada3e4fbc`.

Dashboard: [Open TEST dashboard](https://agent-beacon-cloud-test.jackg825.workers.dev/dashboard)

Read-only MCP: [TEST MCP endpoint](https://agent-beacon-cloud-test.jackg825.workers.dev/mcp)

Browser login uses username `beacon` and the separately supplied private read
secret. MCP uses its own bearer secret. Dashboard/MCP secrets are in Cloudflare
Secrets; device digests are in D1. Plaintext bootstrap credentials remain in
private ignored local files, never this report, vars or frontend.

## Verified

| Acceptance | Evidence |
| --- | --- |
| Review and CI | Two independent code reviews; 55/55 local tests, shipping-hook and authenticated desktop/mobile browser checks pass. Both new backend workflows and all 18 upstream CI jobs passed before merge |
| Deployment | Fresh isolated Worker, D1 and R2; migration applied remotely; two dedicated synthetic device credentials enrolled as SHA-256 digests |
| Actual cloud pipeline | Unchanged shipping hook binary with synthetic input → private synthetic JSONL → forwarder → deployed HTTPS Worker → D1/R2 → query/dashboard/MCP |
| Authorization | Anonymous reads/ingest and cross-role tokens rejected; a device cannot claim another device's namespace |
| Retries and identity | Concurrent exact/regrouped replay retains 5 logical events; equal native session IDs on two devices remain separate; SSH/HTTPS repositories share 1 project |
| R2 evidence | Timelines return exact synthetic payloads, including the two captured hook events |
| Remote MCP | Official current and legacy clients discover 4 read-only tools and retrieve the same deployed timeline |
| Browser | Direct HTTPS Chromium with browser authentication renders actual stored evidence and device filtering; 375px layout fits with no page script errors |
| Persistence | Another same-source Worker deployment produced a distinct version. Read-only verification retrieved the same session/event identities and exact R2 payloads, then repeated MCP/browser checks |

Cloud seed: **7/7 acceptance groups passed**. After redeployment:
**5/5 verification groups passed**. D1 after redeployment contains 2 synthetic
devices, 1 project, 3 sessions, 5 events, 4 indexed raw batches and 5 event versions.
Every uploaded payload was synthetic; installed Beacon logs were never read.

CI evidence: [backend PR run](https://github.com/jackg825/agent-beacon/actions/runs/37219187668),
[backend push run](https://github.com/jackg825/agent-beacon/actions/runs/37219176055),
[upstream CI run](https://github.com/jackg825/agent-beacon/actions/runs/37219187689).
Private result files and deployment version records remain in ignored `.local/`.

## Shared-account isolation

Only these new resources were created:

| Resource | Name | Binding |
| --- | --- | --- |
| Worker | `agent-beacon-cloud-test` | N/A |
| D1 | `agent-beacon-cloud-test-db` | `DB` |
| R2 | `agent-beacon-cloud-test-raw` | `RAW` |

The deployment controller checked the account, clean merged source, absent test
names, exact Worker/configuration, and unique D1/R2 bindings before writes.
No DNS, shared route, custom domain, Access application/policy or subscription
write was performed. Test R2 managed public access is disabled and it has no
custom domains. Account/resource IDs and unrelated project names stay private.

Before/after comparison: 20 of 21 existing Workers have identical metadata,
versions and deployments. The other Worker had a dashboard-origin version and
deployment at **17:02:37–39 UTC**, before this project's first cloud resource
write at **17:17:12 UTC**. That earlier activity is recorded separately; it was
not reverted. Existing resource identities, routes, custom domains, visible
Access applications, D1/R2/KV lists and zones otherwise match. DNS-record reads
remain denied (403); no custom-domain clearance is claimed. See [INVENTORY.md](INVENTORY.md).

## Using the two Macs

Follow [MAC-SETUP.md](MAC-SETUP.md). Each Mac retains a local collector, has its
own enrolled device key and local state, and opts in by starting the forwarder
against the same Worker. Use equivalent Git remotes/project mappings across
checkouts. Dashboard/MCP can then query both devices. No central Mac/VPS or
Cloudflare Tunnel is required.

This rollout's device keys are synthetic acceptance keys. Provision new unique
keys before a real-device pilot. No collector installation/settings, launchd
job, real transcript upload or Mac mini connection was performed. On the MBP,
the readonly PATH check did not find `beacon`; this does not establish whether
an existing collector is installed elsewhere.

## Remaining verification and features

Production rollout, real MBP/Mac mini capture/sleep/wake/offline behavior,
external Access/OAuth login and real Claude sessions remain unverified.
The test uses manual dashboard/MCP credentials. The deployed 0.1 version has no
memory candidates, human approval, publication or cross-device memory sync, and no
retention, scheduled backups or data health. Later milestones implement several of
these locally only; none is part of this deployment or its evidence. Automated R2
cleanup/reindex, load/CPU and quota tests, and actual cloud rollback/restore remain
future work.
Recovery instructions are in [DEPLOYMENT.md](DEPLOYMENT.md); Worker code rollback
does not restore D1/R2 data.
