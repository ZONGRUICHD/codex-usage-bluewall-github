#!/usr/bin/env python3
"""
Generate a GitHub-style blue wall SVG from aggregated AI coding usage.
"""

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional


def expand_path(path: str) -> Path:
    """Expand ~ and environment variables in path."""
    return Path(os.path.expanduser(os.path.expandvars(path)))


def load_usage_data(data_path: Path) -> dict:
    """Load usage data from JSON file."""
    with open(data_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_color_intensity(tokens: int, max_tokens: int) -> str:
    """
    Get blue color intensity based on token count.

    Returns CSS color string with varying blue intensity.
    """
    if tokens == 0:
        return "#161b22"  # Dark gray for no activity

    if max_tokens == 0:
        return "#0e4429"  # Default low activity

    # Calculate intensity (0-1)
    intensity = min(tokens / max_tokens, 1.0)

    # Blue color palette (dark to light)
    colors = [
        (15, 50, 100),   # Very low - deep blue
        (25, 80, 160),   # Low - medium blue
        (40, 120, 200),  # Medium - bright blue
        (66, 165, 245),  # High - light blue
        (144, 202, 249), # Very high - very light blue
    ]

    # Interpolate between colors
    idx = intensity * (len(colors) - 1)
    lower_idx = int(idx)
    upper_idx = min(lower_idx + 1, len(colors) - 1)
    fraction = idx - lower_idx

    r = int(colors[lower_idx][0] + (colors[upper_idx][0] - colors[lower_idx][0]) * fraction)
    g = int(colors[lower_idx][1] + (colors[upper_idx][1] - colors[lower_idx][1]) * fraction)
    b = int(colors[lower_idx][2] + (colors[upper_idx][2] - colors[lower_idx][2]) * fraction)

    return f"#{r:02x}{g:02x}{b:02x}"


def generate_svg(
    daily_usage: dict,
    statistics: dict,
    username: str,
    days: int = 365,
    per_tool_summary: Optional[dict] = None,
) -> str:
    """
    Generate a GitHub-style blue wall SVG.

    Args:
        daily_usage: Dict of {date_str: {total_tokens, ...}}
        statistics: Dict with summary statistics
        username: GitHub username
        days: Number of days to show

    Returns:
        SVG string
    """
    # SVG dimensions
    cell_size = 12
    cell_padding = 3
    header_height = 80
    footer_height = 40
    side_padding = 20

    # Calculate grid dimensions (7 rows for days of week)
    weeks = min(days // 7 + 1, 53)  # Max 53 weeks
    grid_width = weeks * (cell_size + cell_padding)
    grid_height = 7 * (cell_size + cell_padding)

    total_width = grid_width + side_padding * 2
    total_height = header_height + grid_height + footer_height

    # Find max tokens for color scaling
    max_tokens = max((day["total_tokens"] for day in daily_usage.values()), default=0)

    # Generate grid cells
    cells = []
    today = datetime.now().date()
    start_date = today - timedelta(days=days)

    # Adjust to start on a Sunday
    while start_date.weekday() != 6:  # 6 = Sunday
        start_date -= timedelta(days=1)

    current_date = start_date
    week = 0

    while current_date <= today:
        day_of_week = current_date.weekday()

        # Convert Monday=0 to Sunday=0 format
        if day_of_week == 6:
            day_of_week = 0
        else:
            day_of_week += 1

        date_str = current_date.strftime("%Y-%m-%d")
        tokens = daily_usage.get(date_str, {}).get("total_tokens", 0)
        color = get_color_intensity(tokens, max_tokens)

        x = side_padding + week * (cell_size + cell_padding)
        y = header_height + day_of_week * (cell_size + cell_padding)

        cells.append(f'<rect x="{x}" y="{y}" width="{cell_size}" height="{cell_size}" '
                    f'fill="{color}" rx="2" ry="2">'
                    f'<title>{date_str}: {tokens:,} tokens</title></rect>')

        # Move to next day
        current_date += timedelta(days=1)
        if current_date.weekday() == 6:  # Sunday = new week
            week += 1

    # Format statistics
    total_tokens = f"{statistics['total_tokens']:,}"
    peak_tokens = f"{statistics['peak_tokens']:,}"
    current_streak = str(statistics['current_streak'])
    longest_streak = str(statistics['longest_streak'])
    tool_breakdown = " | ".join(
        f"{tool}: {tokens:,}"
        for tool, tokens in (per_tool_summary or {}).items()
        if tokens > 0
    )

    # Generate SVG
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="{total_width}" height="{total_height}" viewBox="0 0 {total_width} {total_height}"
     xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">

  <!-- Background -->
  <rect width="{total_width}" height="{total_height}" fill="#0d1117" rx="6" ry="6"/>

  <!-- Title -->
  <text x="{side_padding}" y="25" fill="#e6edf3" font-size="16" font-weight="600">
    AI Coding Activity
  </text>
  <text x="{side_padding}" y="45" fill="#8b949e" font-size="12">
    {username}'s token usage across devices, tools, and agents
  </text>
  <text x="{side_padding}" y="65" fill="#58a6ff" font-size="11">
    {tool_breakdown}
  </text>

  <!-- Day labels -->
  <text x="{side_padding - 5}" y="{header_height + 10}" fill="#8b949e" font-size="10" text-anchor="end">Sun</text>
  <text x="{side_padding - 5}" y="{header_height + 10 + (cell_size + cell_padding) * 2}" fill="#8b949e" font-size="10" text-anchor="end">Tue</text>
  <text x="{side_padding - 5}" y="{header_height + 10 + (cell_size + cell_padding) * 4}" fill="#8b949e" font-size="10" text-anchor="end">Thu</text>
  <text x="{side_padding - 5}" y="{header_height + 10 + (cell_size + cell_padding) * 6}" fill="#8b949e" font-size="10" text-anchor="end">Sat</text>

  <!-- Grid cells -->
  {"".join(cells)}

  <!-- Statistics -->
  <text x="{side_padding}" y="{header_height + grid_height + 20}" fill="#8b949e" font-size="11">
    Total: <tspan fill="#e6edf3">{total_tokens}</tspan> tokens
  </text>
  <text x="{side_padding + 200}" y="{header_height + grid_height + 20}" fill="#8b949e" font-size="11">
    Peak: <tspan fill="#e6edf3">{peak_tokens}</tspan> tokens
  </text>
  <text x="{side_padding + 400}" y="{header_height + grid_height + 20}" fill="#8b949e" font-size="11">
    Current streak: <tspan fill="#58a6ff">{current_streak}</tspan> days
  </text>
  <text x="{side_padding + 600}" y="{header_height + grid_height + 20}" fill="#8b949e" font-size="11">
    Longest streak: <tspan fill="#58a6ff">{longest_streak}</tspan> days
  </text>

  <!-- Legend -->
  <text x="{total_width - side_padding - 200}" y="{header_height + grid_height + 20}" fill="#8b949e" font-size="10">
    Less
  </text>
  <rect x="{total_width - side_padding - 170}" y="{header_height + grid_height + 10}" width="10" height="10" fill="#161b22" rx="2" ry="2"/>
  <rect x="{total_width - side_padding - 155}" y="{header_height + grid_height + 10}" width="10" height="10" fill="#0f3264" rx="2" ry="2"/>
  <rect x="{total_width - side_padding - 140}" y="{header_height + grid_height + 10}" width="10" height="10" fill="#1976d2" rx="2" ry="2"/>
  <rect x="{total_width - side_padding - 125}" y="{header_height + grid_height + 10}" width="10" height="10" fill="#2878c8" rx="2" ry="2"/>
  <rect x="{total_width - side_padding - 110}" y="{header_height + grid_height + 10}" width="10" height="10" fill="#42a5f5" rx="2" ry="2"/>
  <rect x="{total_width - side_padding - 95}" y="{header_height + grid_height + 10}" width="10" height="10" fill="#90caf9" rx="2" ry="2"/>
  <text x="{total_width - side_padding - 80}" y="{header_height + grid_height + 20}" fill="#8b949e" font-size="10">
    More
  </text>

</svg>'''

    return svg


def save_svg(svg_content: str, output_path: Path):
    """Save SVG content to file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(svg_content)

    print(f"Saved SVG to: {output_path}")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Generate blue wall SVG")
    parser.add_argument("--data", type=str, default="data/codex-usage.json", help="Input data file path")
    parser.add_argument("--output", type=str, default="assets/codex-blue-wall.svg", help="Output SVG file path")
    parser.add_argument("--username", type=str, default="user", help="GitHub username")
    parser.add_argument("--days", type=int, default=365, help="Number of days to show")
    args = parser.parse_args()

    # Load data
    data_path = expand_path(args.data)
    if not data_path.exists():
        print(f"Error: Data file not found: {data_path}")
        print("Run scan_codex.py first to generate usage data.")
        sys.exit(1)

    print(f"Loading usage data from: {data_path}")
    data = load_usage_data(data_path)

    # Generate SVG
    svg_content = generate_svg(
        data["daily_usage"],
        data["statistics"],
        args.username,
        args.days,
        data.get("per_tool_summary"),
    )

    # Save SVG
    output_path = expand_path(args.output)
    save_svg(svg_content, output_path)

    print("Done!")


if __name__ == "__main__":
    main()
