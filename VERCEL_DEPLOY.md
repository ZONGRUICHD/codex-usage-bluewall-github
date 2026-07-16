# Vercel temporary rollback

The primary runtime is now the home Docker service at `https://bluewall.zongtech.xyz`. Keep the existing Vercel project and Git integration active during the migration observation period so it remains a fast rollback path:

- Site: `https://codex-usage-bluewall-github.vercel.app`
- SVG: `https://codex-usage-bluewall-github.vercel.app/api/svg`

Do not delete or disconnect this project until daily deployments, Cloudflare Tunnel, the GitHub Profile embed, and GitHub Camo have been verified over the agreed observation window.

## Project settings

Import `ZONGRUICHD/codex-usage-bluewall-github` and keep the project root at the repository root.

The checked-in `vercel.json` is authoritative:

- Framework: `Other`
- Node.js: `24.x`
- Build command: `npm run verify:runtime`
- Install command: skipped
- Static output: `public/`
- Function: `api/svg.js`

Do not set the Root Directory to the removed `vercel/` folder. That was an obsolete Next.js implementation. Do not deploy `server.js` as a Vercel Function; the legacy fallback continues to use the compatible root `api/svg.js` handler.

## Environment

No secrets are required. Runtime coordinates are explicit optional environment variables with repository defaults:

```text
GITHUB_USERNAME=ZONGRUICHD
GITHUB_REPO=codex-usage-bluewall-github
GITHUB_BRANCH=main
TIME_ZONE=Asia/Shanghai
STALE_AFTER_DAYS=2
```

Only add overrides in Vercel Project Settings when deploying a fork. Do not commit `.env` files. Vercel-specific Git metadata is no longer required by the handler.

## Rollback deployment flow

Vercel's existing Git integration continues to deploy every `main` push. This keeps the fallback data and renderer aligned with the primary home image without adding a Vercel token to GitHub Actions.

After a push, verify:

```bash
curl -fsSL https://codex-usage-bluewall-github.vercel.app/api/svg -o live-vercel.svg
curl -fsSL https://codex-usage-bluewall-github.vercel.app/ -o index-vercel.html
```

Expected:

- `/` returns `200` with the static status page;
- `/api/svg` returns `200` and `Content-Type: image/svg+xml`;
- the SVG ends on the current `Asia/Shanghai` date;
- `Synced` and `last active` reflect the latest committed snapshot;
- `X-Data-Source` is normally `github` and may be `bundled` during an upstream outage.

The API accepts only:

```text
GET /api/svg
HEAD /api/svg
GET /api/svg?days=7..365
```

Legacy `profile` / `v` parameters receive a canonical redirect before any upstream fetch.

## Emergency use

If the home origin or Tunnel is unavailable, the Vercel URLs can be used directly while the incident is diagnosed. Changing the GitHub Profile embed or DNS is a separate operator decision; do not automatically rewrite public traffic from an untrusted deployment job.

Once the home deployment has proven stable, retire this fallback in a separate change. That cleanup may remove the Vercel project, legacy documentation, and Vercel-only configuration, but must not alter the shared data collector or `api/svg.js` rendering semantics.
