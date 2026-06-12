# AI Coding Blue Wall

Track token usage across devices, operating systems, coding tools, and sub-agents, then display it as a blue activity wall on your GitHub Profile.

## Features

- 📊 Scan Codex, Claude Code, MiMo Code, OpenCode, and Hermes Agent
- 🖥️ Merge snapshots from Windows, Linux, and macOS devices
- 🤖 Preserve per-tool and per-agent usage summaries
- 🎨 Generate GitHub-style blue heatmap SVG
- ☁️ Deploy to Vercel for automatic updates
- 🔒 Secure: only aggregated data, no secrets

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Windows PC     │     │  Linux PC       │     │  macOS          │
│  - Codex        │     │  - Codex        │     │  - Codex        │
│  - Claude Code  │     │  - Claude Code  │     │  - Claude Code  │
│  - MimoCode     │     │  - MimoCode     │     │  - MimoCode     │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   GitHub Repository    │
                    │  data/ai-usage.json    │
                    │  assets/ai-blue-wall.svg│
                    └────────────┬───────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   Vercel Deployment    │
                    │  /api/svg (SVG API)    │
                    │  / (Preview Page)      │
                    └────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  GitHub Profile README │
                    │  <img src="vercel/svg">│
                    └────────────────────────┘
```

## Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/zong1024/codex-usage-bluewall-github.git
cd codex-usage-bluewall-github
```

### 2. Scan Your Tools

```bash
# Scan all tools on current device
python3 scripts/scan_all_tools.py --days 365 --output data/ai-usage.json

# Or use the update script
./scripts/update-full.sh --commit --push
```

### 3. Deploy to Vercel

1. Push to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Import your repository
4. Set environment variables:
   - `GITHUB_USERNAME`: your-github-username
   - `GITHUB_REPO`: codex-usage-bluewall-github
5. Deploy!

### 4. Embed in GitHub Profile

Add to your GitHub Profile README:

```markdown
## AI Coding Activity

![AI Coding Blue Wall](https://your-project.vercel.app/api/svg)
```

## Multi-Device Setup

Create one snapshot on each device:

```bash
./scripts/update-multi-device.sh --device desktop --scan-only
```

Windows PowerShell:

```powershell
.\scripts\update-multi-device.ps1 -Device desktop -ScanOnly
```

This creates `data/ai-usage-desktop.json`. Transfer or commit each device
snapshot, then merge them on one machine:

```bash
./scripts/update-multi-device.sh --merge-only \
  --input data/ai-usage-desktop.json \
  --input data/ai-usage-laptop.json
```

Duplicate snapshots with the same device name are not double-counted; the newest
snapshot wins.

### Custom Storage Paths

```bash
python3 scripts/scan_all_tools.py \
  --codex-db /path/to/state_5.sqlite \
  --claude-dir /path/to/.claude/projects \
  --mimocode-db /path/to/mimocode.db \
  --opencode-path /path/to/opencode.db \
  --hermes-db /path/to/state.db
```

## Supported Tools

| Tool | Data Source | Status |
|------|------------|--------|
| Codex | `~/.codex/state_*.sqlite` + rollout JSONL | ✅ Supported |
| Claude Code | `~/.claude/projects/*.jsonl` | ✅ Supported |
| MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ Supported |
| OpenCode | `~/.local/share/opencode/` SQLite or JSON storage | ✅ Supported |
| Hermes Agent | `~/.hermes/state.db` and profile databases | ✅ Supported |

Cache-read, cache-write, reasoning, and sub-agent tokens are included when the
source tool records them. MiMo Code sessions imported from Claude Code are
excluded to prevent double counting.

## Configuration

Edit `config.json`:

```json
{
  "username": "your-github-username",
  "days": 365,
  "output_svg": "assets/ai-blue-wall.svg",
  "output_data": "data/ai-usage.json"
}
```

## Security

- ✅ Only aggregated token counts are stored
- ✅ No API keys or secrets in repository
- ✅ No source code or prompts uploaded
- ✅ `.gitignore` blocks sensitive files

## Requirements

- Python 3.8+
- Git
- Vercel account (free)

## License

MIT
