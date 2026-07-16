# Vercel Deployment

## Project settings

Import `ZONGRUICHD/codex-usage-bluewall-github` and keep the project root at the repository root.

The checked-in `vercel.json` is authoritative:

- Framework: `Other`
- Node.js: `24.x`
- Build command: `npm run verify:vercel` (Node-only API tests plus deterministic SVG check)
- Install command: skipped
- Static output: `public/`
- Function: `api/svg.js`

Do not set the Root Directory to the removed `vercel/` folder. That was an obsolete Next.js implementation.

## Environment

No secrets are required. Vercel Git metadata supplies the repository owner/name automatically, with these fallbacks:

```text
GITHUB_USERNAME=ZONGRUICHD
GITHUB_REPO=codex-usage-bluewall-github
GITHUB_BRANCH=main
TIME_ZONE=Asia/Shanghai
STALE_AFTER_DAYS=2
```

Only add overrides in Vercel Project Settings when deploying a fork. Do not commit `.env` files.

## Git deployment flow

Vercel's Git integration deploys every `main` push to Production. Every deployment first runs the Node-only API/render gate; data-only pushes do not need a custom Vercel token or GitHub Actions deploy job.

After a push, verify:

```bash
curl -fsSL https://codex-usage-bluewall-github.vercel.app/api/svg -o live.svg
curl -fsSL https://codex-usage-bluewall-github.vercel.app/ -o index.html
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
