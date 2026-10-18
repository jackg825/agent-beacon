---
paths:
  - "workers/beacon-cloud/**"
  - ".github/workflows/beacon-cloud.yml"
---
<!--
Claude-only layer: Codex never reads .claude/. Fork-only rule (jackg825/agent-beacon); upstream's
CLAUDE.md stays untouched because AGENTS.md sends Codex to it. Loads only for matching files.
-->

# Cloudflare Workers backend (this fork only)

`workers/beacon-cloud` is this fork's sanctioned, opt-in Cloudflare Workers backend (D1/R2, dashboard, read-only remote MCP), fed by its own JSONL forwarder. It changes no upstream collector, adapter, local dashboard, or local MCP; Beacon's own local-only posture still governs Beacon's code. Start from its `README.md`; deployment rules are in `DEPLOYMENT.md`.

- Checks (synthetic credentials and temporary storage, no remote resources): `npm ci && npm run check && npm test && npm run deploy:dry-run`; `npm run test:collector` also needs Go.
- Only the isolated TEST resources (`agent-beacon-cloud-test*`) are authorized. Production deployment, new Cloudflare resources, custom domains, and changes to shared routes or Access policies need the owner's separate approval.
- Keep account and resource IDs in ignored `.local/`, and credentials out of `vars`, git, frontend code, shell arguments, fixtures, screenshots, and logs; keep R2 public access disabled.
- Develop against synthetic JSONL, not real transcripts or installed Beacon logs.
