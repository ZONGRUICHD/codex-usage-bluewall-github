#!/usr/bin/env python3
"""Merge aggregated AI usage snapshots produced on multiple devices."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable

try:
    from .scan_all_tools import add_usage, calculate_statistics, empty_usage, expand_path
except ImportError:
    from scan_all_tools import add_usage, calculate_statistics, empty_usage, expand_path


def load_usage_file(file_path: Path) -> Dict[str, Any]:
    with file_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def merge_daily_usage(all_data: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    for data in all_data:
        for date_str, usage in data.get("daily_usage", {}).items():
            if date_str not in merged:
                merged[date_str] = {**empty_usage(), "tools": {}, "agents": {}}
            add_usage(merged[date_str], usage)
            for tool, tokens in usage.get("tools", {}).items():
                merged[date_str]["tools"][tool] = (
                    merged[date_str]["tools"].get(tool, 0) + int(tokens or 0)
                )
            for agent, tokens in usage.get("agents", {}).items():
                merged[date_str]["agents"][agent] = (
                    merged[date_str]["agents"].get(agent, 0) + int(tokens or 0)
                )
    return merged


def merge_summary(all_data: Iterable[Dict[str, Any]], key: str) -> Dict[str, int]:
    merged: Dict[str, int] = {}
    for data in all_data:
        for name, total in data.get(key, {}).items():
            merged[name] = merged.get(name, 0) + int(total or 0)
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge multi-device AI usage snapshots")
    parser.add_argument("--inputs", nargs="+", required=True)
    parser.add_argument("--output", default="data/ai-usage.json")
    parser.add_argument("--device-names", nargs="+")
    args = parser.parse_args()

    snapshots_by_device: Dict[str, tuple[Dict[str, Any], str]] = {}
    for index, raw_path in enumerate(args.inputs):
        path = expand_path(raw_path)
        if not path.exists():
            print(f"Warning: file not found: {path}")
            continue
        data = load_usage_file(path)
        device = (
            args.device_names[index]
            if args.device_names and index < len(args.device_names)
            else data.get("device", path.stem)
        )
        existing = snapshots_by_device.get(device)
        if existing:
            existing_time = existing[0].get("generated_at", "")
            incoming_time = data.get("generated_at", "")
            if incoming_time <= existing_time:
                print(f"Warning: ignoring older duplicate snapshot for device {device}: {path}")
                continue
            print(f"Warning: replacing older duplicate snapshot for device {device}")
        snapshots_by_device[device] = (data, str(path))

    if not snapshots_by_device:
        parser.error("no valid input files")

    devices = list(snapshots_by_device)
    snapshots = [value[0] for value in snapshots_by_device.values()]
    source_files = [value[1] for value in snapshots_by_device.values()]
    daily_usage = merge_daily_usage(snapshots)
    output = {
        "schema_version": 2,
        "generated_at": datetime.now().astimezone().isoformat(),
        "merged_from": devices,
        "source_files": source_files,
        "tools_scanned": sorted(
            {tool for data in snapshots for tool in data.get("tools_scanned", [])}
        ),
        "per_tool_summary": merge_summary(snapshots, "per_tool_summary"),
        "per_agent_summary": merge_summary(snapshots, "per_agent_summary"),
        "statistics": calculate_statistics(daily_usage),
        "daily_usage": daily_usage,
    }
    output_path = expand_path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved merged data from {len(snapshots)} devices to {output_path}")
    print(f"Total tokens: {output['statistics']['total_tokens']:,}")


if __name__ == "__main__":
    main()
