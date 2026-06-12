#!/bin/bash
# AI Coding Blue Wall - Full Update Script
# Scans all tools, generates SVG, commits and pushes to GitHub

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

DAYS=365
AUTO_COMMIT=false
AUTO_PUSH=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --commit) AUTO_COMMIT=true; shift ;;
        --push) AUTO_PUSH=true; AUTO_COMMIT=true; shift ;;
        --days) DAYS="$2"; shift 2 ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --commit    Automatically commit changes"
            echo "  --push      Automatically push changes"
            echo "  --days N    Number of days to scan"
            echo "  --help      Show this help"
            exit 0
            ;;
        *) print_error "Unknown option: $1"; exit 1 ;;
    esac
done

main() {
    print_info "Starting AI Coding Blue Wall update..."
    
    # Scan all tools
    print_info "Scanning all AI coding tools..."
    python3 "$SCRIPT_DIR/scan_all_tools.py" --days "$DAYS" --output "$PROJECT_DIR/data/ai-usage.json"
    
    # Generate SVG (using Python)
    print_info "Generating SVG..."
    python3 "$SCRIPT_DIR/render_blue_wall.py" --data "$PROJECT_DIR/data/ai-usage.json" --output "$PROJECT_DIR/assets/ai-blue-wall.svg"
    
    # Commit and push
    if [ "$AUTO_COMMIT" = true ]; then
        print_info "Committing changes..."
        cd "$PROJECT_DIR"
        git add data/ai-usage.json assets/ai-blue-wall.svg
        git commit -m "Update AI coding usage $(date +%Y-%m-%d)" || true
    fi
    
    if [ "$AUTO_PUSH" = true ]; then
        print_info "Pushing to GitHub..."
        cd "$PROJECT_DIR"
        git push
    fi
    
    print_info "Done!"
    print_info "Vercel will auto-deploy and update the SVG."
    print_info "Embed URL: https://your-project.vercel.app/api/svg"
}

main
