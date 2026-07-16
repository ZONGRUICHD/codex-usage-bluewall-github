#!/usr/bin/env bash
# Create a local device snapshot, then merge snapshots copied from other devices.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEVICE_NAME="$(hostname)"
DAYS=365
SCAN_ONLY=false
MERGE_ONLY=false
INPUTS=()

usage() {
    cat <<'EOF'
Usage: scripts/update-multi-device.sh [OPTIONS]

Options:
  --device NAME    Name for this device snapshot (default: hostname)
  --input FILE     Snapshot from a device; repeat for multiple devices
  --days N         Number of days to scan
  --scan-only      Create this device snapshot without merging
  --merge-only     Merge snapshots without scanning this device
  --help           Show this help

Run --scan-only once on each device, transfer or commit the generated
data/ai-usage-<device>.json files, then run --merge-only with --input files.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --device) DEVICE_NAME="$2"; shift 2 ;;
        --input) INPUTS+=("$2"); shift 2 ;;
        --days) DAYS="$2"; shift 2 ;;
        --scan-only) SCAN_ONLY=true; shift ;;
        --merge-only) MERGE_ONLY=true; shift ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if [[ "$SCAN_ONLY" == true && "$MERGE_ONLY" == true ]]; then
    echo "--scan-only and --merge-only cannot be used together" >&2
    exit 1
fi

mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/assets"
SNAPSHOT="$PROJECT_DIR/data/ai-usage-${DEVICE_NAME}.json"

if [[ "$MERGE_ONLY" == false ]]; then
    python3 "$SCRIPT_DIR/scan_all_tools.py" \
        --days "$DAYS" \
        --device-name "$DEVICE_NAME" \
        --output "$SNAPSHOT"
    INPUTS+=("$SNAPSHOT")
fi

if [[ "$SCAN_ONLY" == true ]]; then
    echo "Created device snapshot: $SNAPSHOT"
    exit 0
fi

if [[ ${#INPUTS[@]} -eq 0 ]]; then
    while IFS= read -r file; do
        INPUTS+=("$file")
    done < <(find "$PROJECT_DIR/data" -maxdepth 1 -type f -name 'ai-usage-*.json' | sort)
fi

if [[ ${#INPUTS[@]} -eq 0 ]]; then
    echo "No device snapshots found. Pass one or more --input files." >&2
    exit 1
fi

python3 "$SCRIPT_DIR/merge_devices.py" \
    --inputs "${INPUTS[@]}" \
    --output "$PROJECT_DIR/data/ai-usage.json"

node "$SCRIPT_DIR/render_blue_wall.js" \
    --data "$PROJECT_DIR/data/ai-usage.json" \
    --output "$PROJECT_DIR/assets/ai-blue-wall.svg" \
    --days "$DAYS"

echo "Merged ${#INPUTS[@]} snapshot file(s) into data/ai-usage.json"
