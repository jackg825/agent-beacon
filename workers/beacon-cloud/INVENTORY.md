# Cloudflare predeployment inventory

Checked on **2026-10-04 (Asia/Taipei)** using the locally authenticated Wrangler
OAuth session. This was a **read-only inventory**; no Cloudflare resource,
configuration, DNS record, route, credential, or local collector configuration
was created or changed. No production deployment has been authorized.

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
