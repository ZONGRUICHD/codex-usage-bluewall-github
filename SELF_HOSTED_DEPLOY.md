# Self-hosted deployment

This is the production runbook for `https://bluewall.zongtech.xyz`. The runtime is a Dockerized Node.js server on the home host, reachable publicly only through Cloudflare Tunnel.

## Architecture and boundaries

```text
GitHub main
  -> GitHub Actions verification
  -> restricted SSH command: deploy <commit SHA>
  -> root-owned deploy script
  -> Docker container on 127.0.0.1:13299
  -> Cloudflare Tunnel
  -> https://bluewall.zongtech.xyz
```

- Keep the application bound to loopback. Do not publish it on `0.0.0.0` or route it through the public router-management ports.
- Cloudflare Tunnel is outbound-only ingress; the home router does not need an HTTP/HTTPS port forward for this service.
- SSH is management transport only, never an application endpoint.
- Do not alter the unrelated `zongrui-activity` service or its loopback port.
- Never put the server password, a private key, or a Cloudflare tunnel token in this repository.
- Keep the Vercel project active as a temporary rollback until the home endpoint and GitHub Camo have passed the observation window.

## Runtime layout

| Item | Value |
|---|---|
| Public origin | `https://bluewall.zongtech.xyz` |
| Tunnel origin | `http://127.0.0.1:13299` |
| Container port | `3000` |
| Deployment root | `/opt/codex-usage-bluewall` |
| Repository cache | `/opt/codex-usage-bluewall/repository` |
| Temporary build worktrees | `/opt/codex-usage-bluewall/worktrees/` |
| Privileged deploy script | `/usr/local/sbin/bluewall-deploy` |
| Forced-command gate | `/usr/local/sbin/bluewall-deploy-gate` |
| GitHub environment | `home-production` |
| GitHub secret | `HOME_DEPLOY_SSH_KEY` |

The server needs Docker with image-build support, Git, `flock`, and passwordless `sudo` only for the narrowly controlled forced-command path. The application itself runs as the unprivileged `node` user inside a read-only container with dropped capabilities.

## One-time server bootstrap

Run the bootstrap from a trusted administrator session. Copy only the two public repository scripts to the host, then install them as root-owned executables:

```bash
sudo install -o root -g root -m 0755 deploy/bluewall-deploy /usr/local/sbin/bluewall-deploy
sudo install -o root -g root -m 0755 deploy/bluewall-deploy-gate /usr/local/sbin/bluewall-deploy-gate
sudo mkdir -p /opt/codex-usage-bluewall/worktrees
sudo chown -R root:root /opt/codex-usage-bluewall
```

Review both scripts before installation. The gate must accept exactly `deploy <40-hex-commit>` and pass only the validated commit to the root deploy script. The deploy script must independently verify that the commit is reachable from `origin/main`; never rely on the caller alone.

Create a dedicated key pair outside the repository. The private key is for GitHub Actions; only its public half belongs on the server:

```bash
ssh-keygen -t ed25519 -N '' -f bluewall-home-deploy -C bluewall-home-deploy
```

Append the public key to the deploy user's `~/.ssh/authorized_keys` with a forced command and restrictions:

```text
restrict,command="/usr/local/sbin/bluewall-deploy-gate" ssh-ed25519 PUBLIC_KEY bluewall-home-deploy
```

The forced key must not open an interactive shell, forward ports, or execute arbitrary commands. Preserve existing authorized keys and keep directory/file permissions at `0700`/`0600`.

Add the private key to the protected GitHub environment without printing it:

```bash
gh secret set HOME_DEPLOY_SSH_KEY --env home-production < bluewall-home-deploy
```

Delete the local private-key copy after confirming the GitHub secret and storing any approved offline recovery copy. `deploy/known_hosts` contains only the verified public host key and is safe to commit; update it only after independently checking a legitimate server host-key rotation.

## Cloudflare Tunnel

Add a public hostname to the existing remotely managed tunnel:

```text
Hostname: bluewall.zongtech.xyz
Service:  http://127.0.0.1:13299
```

Keep the ingress rule before the final catch-all `http_status:404` rule. Create the proxied CNAME for `bluewall.zongtech.xyz` to the selected tunnel's `<tunnel-id>.cfargotunnel.com` target. Preserve every existing hostname and ingress rule when updating tunnel configuration.

Verify both the local origin and the tunnel before changing the GitHub Profile:

```bash
curl -fsS http://127.0.0.1:13299/healthz
curl -fsS https://bluewall.zongtech.xyz/healthz
curl -fsSI https://bluewall.zongtech.xyz/api/svg
```

## Normal deployment

Every `main` push runs the full verification suite. Only a successful test job can invoke the protected `home-production` deployment job. The workflow sends a single forced command containing `${GITHUB_SHA}`; it does not upload a mutable working tree or use password authentication.

The root deploy script:

1. takes an exclusive deployment lock;
2. fetches the public repository and verifies the requested SHA belongs to `origin/main`;
3. creates an immutable release worktree and image tagged by SHA;
4. starts and health-checks a candidate container;
5. switches the loopback production container only after the candidate is healthy;
6. restores the previous image if the replacement fails.

For a manual, authorized redeploy or rollback, run the same root script with a known-good commit from `main`:

```bash
sudo /usr/local/sbin/bluewall-deploy <40-hex-commit>
```

Do not deploy an unreviewed branch, a shortened SHA, or an image tag such as `latest`.

## Verification after each release

```bash
curl -fsS https://bluewall.zongtech.xyz/healthz
curl -fsS https://bluewall.zongtech.xyz/readyz
curl -fsSI https://bluewall.zongtech.xyz/
curl -fsSI https://bluewall.zongtech.xyz/api/svg
curl -fsSI 'https://bluewall.zongtech.xyz/api/svg?days=30'
```

Confirm:

- health reports the deployed commit SHA;
- the status page and SVG return `200`;
- `/api/svg` returns `Content-Type: image/svg+xml` plus the expected data-source headers;
- unsupported methods and query parameters still return `405` and `400`;
- `Synced`, `active`, total, peak, and streak match the committed aggregate;
- the GitHub Profile's Camo response matches the primary SVG body;
- the Vercel rollback remains available while observation is active.

Useful read-only diagnostics on the host:

```bash
sudo docker ps --filter label=com.zongtech.bluewall.service=codex-usage-bluewall
sudo docker logs --tail 200 codex-usage-bluewall
sudo docker inspect codex-usage-bluewall
```

If the public URL fails but loopback health succeeds, inspect the Cloudflare Tunnel hostname, connector health, and DNS record. If loopback health fails, inspect the container logs and redeploy the last known-good main commit. Do not change router or unrelated reverse-proxy services as a first response.

## Retiring the Vercel fallback

Vercel removal is not part of the initial migration. Consider it only after all of the following remain true through the chosen observation window:

1. daily Windows data pushes repeatedly trigger successful home deployments;
2. Cloudflare Tunnel stays healthy across host and network restarts;
3. Profile HTML points to `bluewall.zongtech.xyz` and Camo serves the same SVG;
4. a deliberate rollback test succeeds;
5. an operator still has a documented recovery path.

Disconnect or delete Vercel only in a separate change so rollback capacity is not lost during the migration itself.
