# AI Coding Blue Wall — Maintainer Handoff

Last reviewed: 2026-07-17, Asia/Shanghai.

## Current production

- Repository: `https://github.com/ZONGRUICHD/codex-usage-bluewall-github`
- Site: `https://codex-usage-bluewall-github.vercel.app`
- SVG: `https://codex-usage-bluewall-github.vercel.app/api/svg`
- Profile: `https://github.com/ZONGRUICHD`

Production is the root Vercel Function `api/svg.js`. There is no Next.js application and no second TypeScript API.

## Non-negotiable data rules

1. Never commit raw databases, rollout JSONL, prompts, conversations, source snippets, cookies, tokens, SSH keys, or `.env` files.
2. Codex `cached_input_tokens` is a subset of `input_tokens`; reasoning is a subset of output. Use the event's authoritative `total_tokens`, falling back to `input + output` only when absent.
3. Cache and reasoning fields remain useful breakdowns but are not added again to the Codex total.
4. Cloud Analytics percentages can mark an active date but never become token counts.
5. Device snapshots merge by stable `device` identity; the newest `generated_at` wins for duplicate device names.
6. The JavaScript implementation in `api/svg.js` is the sole renderer. `scripts/render_blue_wall.js` imports it for the checked-in static asset.

## Live data path

```text
local state_*.sqlite / tool stores
  -> scripts/scan_all_tools.py
  -> data/ai-usage-DEVICE.json
  -> scripts/merge_devices.py
  -> data/ai-usage.json
  -> GitHub main
  -> Vercel /api/svg (GitHub Raw, bundled fallback)
  -> GitHub Camo
```

GitHub-hosted CI and Vercel cannot read local tool storage. The active Windows publisher is:

```powershell
.\scripts\update.ps1 -Device windows-main -Commit -Push
```

The updater refuses a dirty worktree or any branch other than `main`. It scans, merges, renders, and tests in a temporary transaction; only validated files replace the checked-in artifacts. Git credential prompts are disabled for scheduled runs, and publishing targets `HEAD:main` explicitly.

Install it at 00:15 daily plus logon:

```powershell
.\scripts\install-windows-task.ps1 -RunNow
```

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

- Only `GET` and `HEAD` are accepted.
- Only `days=7..365` affects rendering.
- Legacy `profile` / `v` query parameters redirect to the canonical URL before fetching data.
- Unknown query parameters return `400` without upstream I/O.
- GitHub Raw reads have a 5-second timeout and 1 MB cap.
- Failed upstream reads fall back to JSON bundled with the deployment.
- Repository coordinates come from Vercel Git env, optional explicit env, then the current repository defaults.

## CI and deployment

`.github/workflows/ci.yml` is read-only and pins action commit SHAs. It runs:

```bash
npm run verify
```

The old SVG-writing bot workflow was removed because it caused a second commit and a second Vercel Production Deployment for each data update. The local updater now commits the data and matching static SVG together.

Vercel uses Node.js 24, `framework: null`, no install step, the Node-only `npm run verify:vercel` build gate, `public/` static output, and root `api/*.js` functions. Never restore the removed nested Next app without deliberately replacing the production architecture.

## Release verification

Before committing:

```bash
git status --short
npm test
npm run render:check
git diff --check
```

After pushing:

1. Confirm GitHub CI succeeds.
2. Confirm the latest GitHub Deployment status is `success`.
3. Fetch `/` and `/api/svg` directly.
4. Parse the SVG cell count, first/last date, total, peak, streak, and freshness line.
5. Fetch the Profile HTML, follow its Camo URL, and confirm it matches production.
6. Confirm no raw data or secrets are staged.

## Historical correction

The pre-2026-07-17 scanner calculated Codex total as:

```text
input + cached input + output + reasoning
```

That double-counted cache and reasoning and inflated observed totals by roughly 1.96×. The fixed scanner uses the payload `total_tokens`. Any future import of an old snapshot must be regenerated with the fixed scanner or omit unverifiable totals and carry an explicit `data_quality` gap; never relabel an estimate as exact.
