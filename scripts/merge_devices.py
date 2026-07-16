#!/usr/bin/env python3
"""Merge aggregated AI usage snapshots produced on multiple devices."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping

try:
    from .scan_all_tools import add_usage, calculate_statistics, empty_usage, expand_path
except ImportError:
    from scan_all_tools import add_usage, calculate_statistics, empty_usage, expand_path


def load_usage_file(file_path: Path) -> Dict[str, Any]:
    with file_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _non_negative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _token_map(value: Any, label: str) -> Dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")

    result: Dict[str, int] = {}
    for name, total in value.items():
        if not isinstance(name, str) or not name:
            raise ValueError(f"{label} keys must be non-empty strings")
        result[name] = _non_negative_int(total, f"{label}.{name}")
    return result


def _summary_from_daily(
    daily_usage: Mapping[str, Dict[str, Any]], breakdown_key: str
) -> Dict[str, int]:
    summary: Dict[str, int] = {}
    for usage in daily_usage.values():
        for name, total in usage.get(breakdown_key, {}).items():
            summary[name] = summary.get(name, 0) + int(total)
    return summary


def _stable_source_name(source_file: str) -> str:
    """Return a publishable source label without leaking a local directory."""

    normalized = str(source_file).replace("\\", "/")
    source_name = normalized.rsplit("/", 1)[-1]
    if not source_name:
        raise ValueError("source file must include a file name")
    return source_name


def validate_snapshot(data: Dict[str, Any], source: str = "snapshot") -> None:
    """Reject snapshots whose declared totals cannot be reconciled exactly."""

    if not isinstance(data, dict):
        raise ValueError(f"{source}: snapshot root must be an object")

    schema_version = data.get("schema_version")
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version < 3
    ):
        raise ValueError(f"{source}: schema_version must be at least 3")

    device = data.get("device")
    if not isinstance(device, str) or not device.strip():
        raise ValueError(f"{source}: device must be a non-empty string")

    generated_at = data.get("generated_at")
    if not isinstance(generated_at, str):
        raise ValueError(f"{source}: generated_at must be an ISO 8601 timestamp")
    try:
        parsed_generated_at = datetime.fromisoformat(
            generated_at.replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise ValueError(
            f"{source}: generated_at must be an ISO 8601 timestamp"
        ) from exc
    if parsed_generated_at.tzinfo is None:
        raise ValueError(f"{source}: generated_at must include a timezone")

    daily_usage = data.get("daily_usage")
    if not isinstance(daily_usage, dict):
        raise ValueError(f"{source}: daily_usage must be an object")

    for date_str, usage in daily_usage.items():
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{source}: invalid daily_usage date {date_str!r}") from exc
        if not isinstance(usage, dict):
            raise ValueError(f"{source}: daily_usage.{date_str} must be an object")

        total = _non_negative_int(
            usage.get("total_tokens"),
            f"{source}: daily_usage.{date_str}.total_tokens",
        )
        tools = _token_map(
            usage.get("tools"), f"{source}: daily_usage.{date_str}.tools"
        )
        agents = _token_map(
            usage.get("agents"), f"{source}: daily_usage.{date_str}.agents"
        )
        tool_total = sum(tools.values())
        agent_total = sum(agents.values())
        if total != tool_total:
            raise ValueError(
                f"{source}: {date_str} total_tokens ({total}) does not equal "
                f"the tools total ({tool_total})"
            )
        if total != agent_total:
            raise ValueError(
                f"{source}: {date_str} total_tokens ({total}) does not equal "
                f"the agents total ({agent_total})"
            )

        for field in (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
            "sessions",
        ):
            if field in usage:
                _non_negative_int(
                    usage[field], f"{source}: daily_usage.{date_str}.{field}"
                )

    for summary_key, breakdown_key in (
        ("per_tool_summary", "tools"),
        ("per_agent_summary", "agents"),
    ):
        declared = _token_map(data.get(summary_key), f"{source}: {summary_key}")
        expected = _summary_from_daily(daily_usage, breakdown_key)
        # A scanner may report a scanned-but-unused tool with a zero summary.
        # Ignore zero-only keys on either side while requiring every token to
        # reconcile exactly.
        declared_nonzero = {key: value for key, value in declared.items() if value}
        expected_nonzero = {key: value for key, value in expected.items() if value}
        if declared_nonzero != expected_nonzero:
            raise ValueError(
                f"{source}: {summary_key} does not reconcile with daily_usage"
            )


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


def merge_data_quality(
    snapshots_by_device: Mapping[str, tuple[Dict[str, Any], str]],
) -> Dict[str, Any]:
    """Carry source caveats into the canonical snapshot with attribution."""

    complete = True
    notes: list[Dict[str, Any]] = []
    sources: list[Dict[str, Any]] = []

    for device, (data, source_file) in snapshots_by_device.items():
        source_name = _stable_source_name(source_file)
        quality = data.get("data_quality")
        if quality is None:
            source_complete = True
            source_status = "complete"
            source_notes: list[Any] = []
        elif isinstance(quality, dict):
            complete_value = quality.get("complete", True)
            if not isinstance(complete_value, bool):
                raise ValueError(
                    f"{source_name}: data_quality.complete must be a boolean"
                )
            source_status = str(
                quality.get(
                    "status", "complete" if complete_value else "incomplete"
                )
            )
            raw_notes = quality.get("notes", [])
            if not isinstance(raw_notes, list):
                raise ValueError(f"{source_name}: data_quality.notes must be an array")
            source_notes = raw_notes
            note_declares_omission = any(
                isinstance(note, dict)
                and str(note.get("code", "")).lower().endswith("_omitted")
                for note in source_notes
            )
            source_complete = (
                complete_value
                and source_status.lower() not in {"historical_gap", "incomplete"}
                and not note_declares_omission
            )
            if not source_complete and source_status == "complete":
                source_status = "incomplete"
        else:
            raise ValueError(f"{source_name}: data_quality must be an object")

        complete = complete and source_complete
        sources.append(
            {
                "device": device,
                "source_file": source_name,
                "complete": source_complete,
                "status": source_status,
            }
        )

        if not source_complete and not source_notes:
            source_notes = [
                {
                    "code": "source_incomplete",
                    "message": "The source snapshot is marked incomplete.",
                }
            ]

        for note in source_notes:
            if isinstance(note, str):
                copied_note: Dict[str, Any] = {"message": note}
            elif isinstance(note, dict):
                copied_note = dict(note)
            else:
                raise ValueError(
                    f"{source_name}: data_quality notes must be strings or objects"
                )
            copied_note["device"] = device
            copied_note["source_file"] = source_name
            notes.append(copied_note)

    return {
        "complete": complete,
        "status": "complete" if complete else "historical_gap",
        "notes": notes,
        "sources": sources,
    }


def build_merged_output(
    snapshots_by_device: Mapping[str, tuple[Dict[str, Any], str]],
) -> Dict[str, Any]:
    devices = list(snapshots_by_device)
    snapshots = [value[0] for value in snapshots_by_device.values()]
    source_files = [
        _stable_source_name(value[1]) for value in snapshots_by_device.values()
    ]
    daily_usage = merge_daily_usage(snapshots)
    return {
        "schema_version": 3,
        "generated_at": datetime.now().astimezone().isoformat(),
        "merged_from": devices,
        "source_files": source_files,
        "token_accounting": {
            "status": "exact_for_included_data",
            "codex_total": "payload.total_tokens or input_tokens + output_tokens",
            "codex_cache_and_reasoning": "diagnostic subsets, not added to total",
        },
        "data_quality": merge_data_quality(snapshots_by_device),
        "tools_scanned": sorted(
            {tool for data in snapshots for tool in data.get("tools_scanned", [])}
        ),
        "per_tool_summary": _summary_from_daily(daily_usage, "tools"),
        "per_agent_summary": _summary_from_daily(daily_usage, "agents"),
        "statistics": calculate_statistics(daily_usage),
        "daily_usage": daily_usage,
    }


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
        try:
            validate_snapshot(data, str(path))
        except ValueError as exc:
            parser.error(str(exc))
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

    try:
        output = build_merged_output(snapshots_by_device)
    except ValueError as exc:
        parser.error(str(exc))
    output_path = expand_path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(output, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(
        f"Saved merged data from {len(snapshots_by_device)} devices to {output_path}"
    )
    print(f"Total tokens: {output['statistics']['total_tokens']:,}")


if __name__ == "__main__":
    main()
