# Cloudflare isolation inventory

## Authorized isolated test deployment — 2026-10-05

Fresh authenticated GET-only snapshots were taken before deployment and after
the same-source redeployment. Private snapshots and the detailed comparison are
in ignored `.local/` files with mode 0600 beneath a 0700 directory; they contain
no authentication token. Local credential retrieval disabled Wrangler debug
logs and metrics. This inventory did not mutate any Cloudflare resource.

The only new registry entries were the authorized test resources:

| Purpose | New isolated name | Worker binding |
| --- | --- | --- |
| Worker | `agent-beacon-cloud-test` | N/A |
| D1 database | `agent-beacon-cloud-test-db` | `DB` |
| R2 bucket | `agent-beacon-cloud-test-raw` | `RAW` |

| Account-1 resource | Before → after | Comparison |
| --- | --- | --- |
| Worker scripts/services | 21 → 22 | Only the test Worker was added |
| D1 databases | 8 → 9 | Existing metadata unchanged; only the test database was added |
| R2 buckets | 15 → 16 | Existing metadata unchanged; only the test bucket was added |
| KV namespaces | 9 → 9 | Unchanged |
| DNS zones | 7 → 7 | Zone metadata unchanged |
| Worker routes | 1 → 1 | Existing wildcard route unchanged across all 7 zones |
| Worker custom domains | 8 → 8 | Unchanged; no domain attached to the test Worker |
| Visible account-level Access applications | 0 → 0 | API results unchanged |
| Existing workers.dev subdomain | Available → available | Unchanged; private value omitted |
| DNS records | HTTP 403 in all 7 zones → HTTP 403 | Contents remain **unverified** |

All 21 existing Workers had complete version and deployment histories captured
and compared. **Twenty were unchanged. One existing Worker had an earlier
dashboard-origin change**, with one added version/deployment and changed
script/service modification metadata. That version was created at
**01:02:37 Asia/Taipei** and its deployment at **01:02:39**; the API marked the
source `dash`. The first operation in this project's deployment record was at
**01:17:12**, about 14 minutes later. These timestamps establish that the observed
drift preceded this project's cloud writes; the inventory does not identify who
made the earlier change. No existing Worker was rolled back or modified to erase
that separate activity. The detailed evidence remains private.

The final test Worker modification was at **01:20:08 Asia/Taipei**. The after
snapshot at **01:21:34–01:21:39** therefore includes the completed same-source
redeployment; it recorded three test versions and three test deployments.
The new R2 bucket's managed public-access API explicitly returned
**`enabled: false`**, and its custom-domain list was empty. Raw R2 data is not
publicly exposed through either of those mechanisms.

The comparison verifies resource registries and deployment metadata, not the
contents of unrelated databases/buckets or inaccessible DNS records. Combined
with the deployment controller's exact test resource names, selected account,
and single D1/R2 bindings, the evidence supports isolated test operations.
Cloud acceptance results are recorded separately in `VALIDATION.md`; this
inventory does not imply that real MBP/Mac mini collectors were reconfigured.

## Initial read-only inventory — 2026-10-04

Checked on **2026-10-04 (Asia/Taipei)** using the locally authenticated Wrangler
OAuth session. This was a **read-only inventory**; no Cloudflare resource,
configuration, DNS record, route, credential, or local collector configuration
was created or changed. At this initial check, Cloudflare deployment had not
yet been authorized. The later authorized test deployment is recorded above.

Account names, account/resource IDs, user emails, existing domain names, tokens,
and unrelated project names are deliberately excluded from this public file.
`account-1` is a review alias for the single account visible to this session.

Credential values were handled only inside a local subprocess and were never
included in tool output or repository files. Wrangler's token-output command
also writes debug logs by default: exact credential occurrences from the
initial current-task reads were sanitized locally, then log writing was disabled
for subsequent credential retrieval. A value-specific scan found zero remaining
occurrences in those logs or the new/changed workspace files. Authentication
state was not revoked or rotated.

## Verified inventory

| Resource in account-1 | Result | `agent-beacon` name conflicts |
| --- | --- | --- |
| Worker scripts | 21; API GET succeeded | None found |
| Worker services | 21; complete single page | None found |
| D1 databases | 8; complete single page | None found |
| R2 buckets | 15; no continuation returned | None found |
| KV namespaces | 9; complete single page | None found |
| DNS zones | 7; complete single page | None found in zone names |
| Worker routes across all 7 zones | 1 existing wildcard route | No Beacon script match |
| Worker custom domains | 8; API GET succeeded | No Beacon hostname/service match |
| Account-level Access applications | 0 returned; complete page | None visible |
| DNS records | All 7 zone queries denied: HTTP 403, code 10000 | **Unverified** |

The Access result describes only applications returned by this account-level
API and credential. It is not proof that no other account, account policy,
zone-level configuration, or organization-level Access configuration exists.
The existing wildcard route must remain untouched. DNS permission failure is
not an empty DNS inventory and must not be treated as clearance for a custom
domain change.

## Independent resource proposal

These names had no matches in the accessible resource lists:

| Purpose | Proposed new name | Worker binding |
| --- | --- | --- |
| Worker | `agent-beacon-cloud` | N/A |
| D1 query/index database | `agent-beacon-cloud-db` | `DB` |
| R2 raw batch storage | `agent-beacon-cloud-raw` | `RAW` |

Use separate deployment and runtime credentials scoped to this project. Keep
all resource IDs and sensitive deployment configuration in ignored local
configuration or the relevant Cloudflare secret store. Start with an isolated
`workers.dev` endpoint if deployment is later authorized; do not attach a
shared wildcard route, modify existing websites/DNS, or change organization
Access settings. A custom hostname needs a new authorized DNS inventory and a
separately scoped application/route decision.

Recheck account selection, names, and permissions immediately before creation:
this inventory is a point-in-time review artifact and does not reserve names.
No Cloudflare Tunnel or centrally running Mac/VPS service is part of this plan.

## Free upstream sandbox prerequisite check

Read `beacon-sandbox/AGENTS.md`, then ran only:

```sh
cd beacon-sandbox
go run ./cmd/beacon-sandbox doctor
```

The check exited 1: **not ready**. Go was available, but Modal authentication,
an Anthropic credential, the Linux Beacon binary, and the Linux collector
binary were missing. The freshness check reported the collector sources
matched, but the required collector binary itself was absent; this is not an
end-to-end capture verification. No prerequisites were provisioned or changed
and no paid sandbox scenario was run. That sandbox is Linux-only and cannot
verify macOS-specific collector behavior.
