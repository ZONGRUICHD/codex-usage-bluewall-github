#!/bin/bash
# AI Coding Blue Wall - Auto Update Script

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Default configuration
CONFIG_FILE="$PROJECT_DIR/config.json"
DAYS=365
AUTO_COMMIT=false
AUTO_PUSH=false

# Function to print colored messages
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check dependencies
check_dependencies() {
    if ! command -v python3 &> /dev/null; then
        print_error "Python 3 is required but not installed."
        exit 1
    fi
}

# Function to load configuration
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        # Read config from JSON file
        USERNAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('username', 'user'))")
        OUTPUT_SVG=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('output_svg', 'assets/ai-blue-wall.svg'))")
        OUTPUT_DATA=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('output_data', 'data/ai-usage.json'))")
        DAYS=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('days', 365))")
    else
        print_warn "Config file not found: $CONFIG_FILE"
        print_info "Using default configuration"
        USERNAME="user"
        OUTPUT_SVG="assets/ai-blue-wall.svg"
        OUTPUT_DATA="data/ai-usage.json"
    fi
}

# Function to scan all supported tools
scan_usage() {
    print_info "Scanning AI coding usage data..."
    python3 "$SCRIPT_DIR/scan_all_tools.py" \
        --days "$DAYS" \
        --output "$PROJECT_DIR/$OUTPUT_DATA"
}

# Function to render SVG
render_svg() {
    print_info "Generating blue wall SVG..."
    python3 "$SCRIPT_DIR/render_blue_wall.py" \
        --data "$PROJECT_DIR/$OUTPUT_DATA" \
        --output "$PROJECT_DIR/$OUTPUT_SVG" \
        --username "$USERNAME" \
        --days "$DAYS"
}

# Function to commit changes
commit_changes() {
    if [ "$AUTO_COMMIT" = true ]; then
        print_info "Committing changes..."
        cd "$PROJECT_DIR"
        git add "$OUTPUT_DATA" "$OUTPUT_SVG"
        git commit -m "Update AI coding blue wall $(date +%Y-%m-%d)" || true
    fi
}

# Function to push changes
push_changes() {
    if [ "$AUTO_PUSH" = true ]; then
        print_info "Pushing changes..."
        cd "$PROJECT_DIR"
        git push
    fi
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --commit)
            AUTO_COMMIT=true
            shift
            ;;
        --push)
            AUTO_PUSH=true
            AUTO_COMMIT=true  # Push requires commit
            shift
            ;;
        --days)
            DAYS="$2"
            shift 2
            ;;
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --commit    Automatically commit changes"
            echo "  --push      Automatically push changes (implies --commit)"
            echo "  --days N    Number of days to scan (default: 365)"
            echo "  --config F  Path to config file"
            echo "  --help      Show this help message"
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Main execution
main() {
    print_info "Starting AI Coding Blue Wall update..."

    check_dependencies
    load_config
    scan_usage
    render_svg
    commit_changes
    push_changes

    print_info "Update complete!"
    print_info "SVG generated: $PROJECT_DIR/$OUTPUT_SVG"
    print_info "Data saved: $PROJECT_DIR/$OUTPUT_DATA"
}

main
