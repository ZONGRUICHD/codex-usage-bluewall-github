# AI Coding Blue Wall — Maintainer Handoff

Last reviewed: 2026-07-17, Asia/Shanghai.

## Current production

- Repository: `https://github.com/ZONGRUICHD/codex-usage-bluewall-github`
- Primary site: `https://bluewall.zongtech.xyz`
- Primary SVG: `https://bluewall.zongtech.xyz/api/svg`
- Temporary Vercel rollback: `https://codex-usage-bluewall-github.vercel.app`
- Profile: `https://github.com/ZONGRUICHD`

The primary runtime is the standalone Node.js server in `server.js`, packaged by `Dockerfile` and published through Cloudflare Tunnel. `api/svg.js` remains the single renderer and request handler. Vercel continues to run the same handler only as a temporary rollback during the migration observation period. There is no Next.js application and no second TypeScript API.

## Non-negotiable data rules

1. Never commit raw databases, rollout JSONL, prompts, conversations, source snippets, cookies, tokens, passwords, SSH private keys, or `.env` files.
2. Codex `cached_input_tokens` is a subset of `input_tokens`; reasoning is a subset of output. Use the event's authoritative `total_tokens`, falling back to `input + output` only when absent.
3. Cache and reasoning fields remain useful breakdowns but are not added again to the Codex total.
4. Cloud Analytics percentages can mark an active date but never become token counts.
5. Device snapshots merge by stable `device` identity; the newest `generated_at` wins for duplicate device names.
6. The JavaScript implementation in `api/svg.js` is the sole renderer. `server.js` adapts it to Node HTTP, and `scripts/render_blue_wall.js` imports it for the checked-in static asset.

## Live data path

```text
local state_*.sqlite / tool stores
  -> scripts/scan_all_tools.py
  -> data/ai-usage-DEVICE.json
  -> scripts/merge_devices.py
  -> data/ai-usage.json
  -> GitHub main
  -> GitHub Actions verified deploy
  -> home Docker /api/svg (GitHub Raw, bundled fallback)
  -> Cloudflare Tunnel / bluewall.zongtech.xyz
  -> GitHub Camo
```

GitHub-hosted CI and the home server cannot read local tool storage. The active Windows publisher is:

```powershell
.\scripts\update.ps1 -Device windows-main -Commit -Push
```

The updater refuses a dirty worktree or any branch other than `main`. It scans, merges, renders, and tests in a temporary transaction; only validated files replace the checked-in artifacts. Git credential prompts are disabled for scheduled runs, and publishing targets `HEAD:main` explicitly.

Install it at 00:15 daily plus logon:

```powershell
.\scripts\install-windows-task.ps1 -RunNow
```

The scheduled task stores neither the home-server password nor the GitHub Actions deployment key.

## Data files

- `data/ai-usage-windows-main.json`: current local Codex device snapshot.
- `data/ai-usage-ZONGRUICHD.json`: retired device snapshot. It retains only the exact Claude/MiMo per-tool and per-agent totals. The unverifiable Codex portion is omitted because its raw rollouts are unavailable; `data_quality` records that historical gap.
- `data/ai-usage.json`: canonical merge used by production.
- `data/codex-cloud-activity.json`: manually captured activity percentages; no credentials.

If the retired-device Codex rollouts are recovered, regenerate that snapshot with the current scanner and remove the omission note only in the same verified commit.

## SVG behavior

- Default window: 365 days, Sunday-aligned, ending on the latest of the current `Asia/Shanghai` date or known data dates.
- Empty dates stay visible as `#161b22`.
- Token colors use square-root scaling; cloud-only dates use the same palette from the percentage.
- `Total`, `Peak`, and tool totals are recomputed from the displayed window.
- Active/longest/current streaks use the union of token-active and cloud-active dates.
- Data older than `STALE_AFTER_DAYS` renders a stale warning and suppresses the misleading current-streak number.
- Month labels, sync date, and last-active date must remain visible.

## API reliability and security

- Only `GET` and `HEAD` are accepted by `/api/svg`.
- Only `days=7..365` affects rendering.
- Legacy `profile` / `v` query parameters redirect to the canonical URL before fetching data.
- Unknown query parameters and duplicated `days` values return `400` without upstream I/O.
- GitHub Raw reads have a 5-second timeout and 1 MB cap.
- The persistent home process caches validated upstream snapshots for five minutes and coalesces concurrent refreshes, avoiding one GitHub Raw fan-out per Profile request.
- Failed upstream reads fall back to JSON bundled with the container image.
- Repository coordinates come from optional explicit environment variables, then the current repository defaults. They do not depend on Vercel metadata.
- The container publishes only on host loopback `127.0.0.1:13299`; Cloudflare Tunnel is the public ingress.
- `/healthz` must remain independent of GitHub Raw. `/readyz` validates local runtime readiness without exposing secrets.

## CI and deployment

`.github/workflows/ci.yml` pins action commit SHAs. Pull requests run the complete verification suite. A successful push to `main` additionally deploys that exact commit SHA through the protected `home-production` environment.

```bash
npm run verify
```

The deployment key is stored only as the `HOME_DEPLOY_SSH_KEY` GitHub environment secret. The corresponding server-side public key is restricted to `deploy/bluewall-deploy-gate`, which accepts only `deploy <40-hex-commit>`. The root-owned `deploy/bluewall-deploy` script verifies that the commit belongs to `origin/main`, builds an immutable Docker image, checks the candidate, then switches the loopback production container. Do not replace this with a password in Actions or a general-purpose shell key.

Cloudflare Tunnel maps `bluewall.zongtech.xyz` to `http://127.0.0.1:13299`. Do not expose the application through the router management ports or reuse the SSH port as an HTTP endpoint. Do not modify the unrelated `zongrui-activity` service.

Vercel Git integration remains enabled as a temporary rollback. It uses the same `api/svg.js` and `public/` output with `npm run verify:runtime`. Remove it only in a separate, deliberate cleanup after the home endpoint, automated updates, Profile embed, and Camo response have remained healthy through the agreed observation window.

The old SVG-writing bot workflow remains removed: it caused a second data commit and a second deployment for every local update. The local updater commits the data and matching static SVG together.

## Release verification

Before committing:

```bash
git status --short
npm test
npm run render:check
git diff --check
```

After pushing `main`:

1. Confirm GitHub CI and the `home-production` deployment job succeed.
2. Fetch `https://bluewall.zongtech.xyz/healthz` and confirm the reported commit matches the pushed SHA.
3. Fetch `/`, `/readyz`, and `/api/svg`; verify status, content type, security headers, and data-source headers.
4. Parse the SVG cell count, first/last date, total, peak, streak, and freshness line.
5. Fetch the Profile HTML, follow its Camo URL, and confirm the Camo SVG body matches the primary endpoint.
6. Confirm the Vercel rollback still serves `/` and `/api/svg` while observation is active.
7. Confirm no raw data, passwords, private keys, or `.env` files are staged.

Operational setup and rollback commands are in [SELF_HOSTED_DEPLOY.md](SELF_HOSTED_DEPLOY.md). Legacy fallback details are in [VERCEL_DEPLOY.md](VERCEL_DEPLOY.md).

## Historical correction

The pre-2026-07-17 scanner calculated Codex total as:

```text
input + cached input + output + reasoning
```

That double-counted cache and reasoning and inflated observed totals by roughly 1.96×. The fixed scanner uses the payload `total_tokens`. Any future import of an old snapshot must be regenerated with the fixed scanner or omit unverifiable totals and carry an explicit `data_quality` gap; never relabel an estimate as exact.
