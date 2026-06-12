#!/usr/bin/env python3
"""Collect token usage from supported local AI coding agents."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "total_tokens",
    "sessions",
)


def expand_path(path: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(path)))


def empty_usage() -> Dict[str, int]:
    return {field: 0 for field in USAGE_FIELDS}


def number(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))
    return 0


def local_date(value: Any, milliseconds: bool = False) -> Optional[str]:
    try:
        if isinstance(value, (int, float)):
            timestamp = float(value) / (1000 if milliseconds else 1)
            return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone()
            return parsed.strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError):
        pass
    return None


def within_days(date_str: Optional[str], days: int) -> bool:
    if not date_str:
        return False
    cutoff = datetime.now().date() - timedelta(days=days)
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").date() >= cutoff
    except ValueError:
        return False


def add_usage(target: Dict[str, int], usage: Dict[str, int]) -> None:
    for field in USAGE_FIELDS:
        target[field] = target.get(field, 0) + number(usage.get(field, 0))


def parsed_usage(
    value: Any,
    *,
    cache_is_additional: bool = True,
    reasoning_is_additional: bool = True,
) -> Optional[Dict[str, int]]:
    """Normalize Anthropic, OpenCode, MiMo Code, and generic usage objects."""
    if not isinstance(value, dict):
        return None

    cache = value.get("cache") if isinstance(value.get("cache"), dict) else {}
    input_tokens = number(value.get("input_tokens", value.get("input", 0)))
    output_tokens = number(value.get("output_tokens", value.get("output", 0)))
    cache_read = number(
        value.get(
            "cache_read_input_tokens",
            value.get("cache_read_tokens", cache.get("read", cache.get("read_tokens", 0))),
        )
    )
    cache_write = number(
        value.get(
            "cache_creation_input_tokens",
            value.get("cache_write_tokens", cache.get("write", cache.get("write_tokens", 0))),
        )
    )
    reasoning = number(
        value.get(
            "reasoning_tokens",
            value.get("reasoning_output_tokens", value.get("reasoning", 0)),
        )
    )
    explicit_total = number(value.get("total_tokens", value.get("total", 0)))

    if explicit_total:
        total = explicit_total
    else:
        total = input_tokens + output_tokens
        if cache_is_additional:
            total += cache_read + cache_write
        if reasoning_is_additional:
            total += reasoning

    if total <= 0:
        return None
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
        "total_tokens": total,
        "sessions": 1,
    }


@dataclass
class ScanResult:
    daily: Dict[str, Dict[str, int]] = field(default_factory=dict)
    daily_agents: Dict[str, Dict[str, int]] = field(
        default_factory=lambda: defaultdict(lambda: defaultdict(int))
    )
    agents: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    sources: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add(self, date_str: str, usage: Dict[str, int], agent: str = "default") -> None:
        if date_str not in self.daily:
            self.daily[date_str] = empty_usage()
        add_usage(self.daily[date_str], usage)
        self.agents[agent or "default"] += usage["total_tokens"]
        self.daily_agents[date_str][agent or "default"] += usage["total_tokens"]


def open_readonly_sqlite(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}


def first_existing(paths: Iterable[Path]) -> Optional[Path]:
    return next((path for path in paths if path.exists()), None)


def codex_db_candidates() -> list[Path]:
    root = expand_path(os.environ.get("CODEX_HOME", "~/.codex"))
    return [root / f"state_{version}.sqlite" for version in range(9, 2, -1)]


def codex_cumulative_usage(payload: Any) -> Optional[Dict[str, int]]:
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    info = payload.get("info")
    if not isinstance(info, dict):
        return None
    usage = info.get("total_token_usage")
    return parsed_usage(
        usage,
        cache_is_additional=False,
        reasoning_is_additional=False,
    )


def scan_codex(days: int = 365, db_path: Optional[Path] = None) -> ScanResult:
    result = ScanResult()
    path = db_path or first_existing(codex_db_candidates())
    if not path:
        result.warnings.append("database not found")
        return result

    result.sources.append(str(path))
    connection = open_readonly_sqlite(path)
    columns = table_columns(connection, "threads")
    select_columns = ["id", "rollout_path", "created_at", "tokens_used"]
    for optional in ("agent_nickname", "agent_role", "source"):
        if optional in columns:
            select_columns.append(optional)

    cutoff = int((datetime.now() - timedelta(days=days)).timestamp())
    rows = connection.execute(
        f"SELECT {', '.join(select_columns)} FROM threads "
        "WHERE created_at >= ? OR updated_at >= ?",
        (cutoff, cutoff),
    ).fetchall()
    connection.close()

    for row in rows:
        fallback_date = local_date(row["created_at"])
        agent = "main"
        for key in ("agent_nickname", "agent_role", "source"):
            if key in row.keys() and row[key]:
                agent = str(row[key])
                break

        event_count = 0
        high_water = empty_usage()
        rollout_path = Path(row["rollout_path"]) if row["rollout_path"] else None
        if rollout_path and rollout_path.exists():
            try:
                with rollout_path.open("r", encoding="utf-8", errors="ignore") as handle:
                    for line in handle:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        cumulative = codex_cumulative_usage(record.get("payload"))
                        date_str = local_date(record.get("timestamp"))
                        if cumulative:
                            usage = {
                                field: max(
                                    0,
                                    cumulative.get(field, 0) - high_water.get(field, 0),
                                )
                                for field in USAGE_FIELDS
                            }
                            for field in USAGE_FIELDS:
                                high_water[field] = max(
                                    high_water[field], cumulative.get(field, 0)
                                )
                            usage["sessions"] = 1
                            if (
                                usage["total_tokens"] <= 0
                                or not within_days(date_str, days)
                            ):
                                continue
                            result.add(date_str, usage, agent)
                            event_count += 1
            except OSError as error:
                result.warnings.append(f"{rollout_path}: {error}")

        # Older sessions may not contain token_count events.
        if event_count == 0 and within_days(fallback_date, days):
            total = number(row["tokens_used"])
            if total:
                result.add(
                    fallback_date,
                    {
                        "input_tokens": int(total * 0.7),
                        "output_tokens": total - int(total * 0.7),
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "reasoning_tokens": 0,
                        "total_tokens": total,
                        "sessions": 1,
                    },
                    agent,
                )
    return result


def claude_dir_default() -> Path:
    return expand_path(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")) / "projects"


def scan_claude_code(days: int = 365, sessions_dir: Optional[Path] = None) -> ScanResult:
    result = ScanResult()
    root = sessions_dir or claude_dir_default()
    if not root.exists():
        result.warnings.append("sessions directory not found")
        return result

    result.sources.append(str(root))
    seen: set[str] = set()
    for jsonl_file in root.rglob("*.jsonl"):
        try:
            with jsonl_file.open("r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if record.get("type") != "assistant":
                        continue
                    message = record.get("message")
                    if not isinstance(message, dict):
                        continue
                    usage = parsed_usage(message.get("usage"))
                    date_str = local_date(record.get("timestamp"))
                    if not usage or not within_days(date_str, days):
                        continue
                    record_id = str(
                        record.get("uuid")
                        or message.get("id")
                        or record.get("requestId")
                        or f"{jsonl_file}:{record.get('timestamp')}:{usage['total_tokens']}"
                    )
                    if record_id in seen:
                        continue
                    seen.add(record_id)
                    agent = str(
                        record.get("agentId")
                        or record.get("agent_id")
                        or ("subagent" if record.get("isSidechain") else "main")
                    )
                    result.add(date_str, usage, agent)
        except OSError as error:
            result.warnings.append(f"{jsonl_file}: {error}")
    return result


def xdg_data_home() -> Path:
    return expand_path(os.environ.get("XDG_DATA_HOME", "~/.local/share"))


def sqlite_message_scan(
    path: Path,
    days: int,
    *,
    exclude_imported_claude: bool = False,
) -> ScanResult:
    result = ScanResult(sources=[str(path)])
    connection = open_readonly_sqlite(path)
    columns = table_columns(connection, "message")
    required = {"id", "session_id", "time_created", "data"}
    if not required.issubset(columns):
        connection.close()
        result.warnings.append("unsupported message table schema")
        return result

    imported_sessions: set[str] = set()
    if exclude_imported_claude:
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "claude_import" in tables:
            imported_sessions = {
                row[0] for row in connection.execute("SELECT session_id FROM claude_import")
            }

    agent_expr = "agent_id" if "agent_id" in columns else "'main' AS agent_id"
    cutoff_ms = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)
    rows = connection.execute(
        f"SELECT id, session_id, {agent_expr}, time_created, data "
        "FROM message WHERE time_created >= ?",
        (cutoff_ms,),
    ).fetchall()
    connection.close()

    for row in rows:
        if row["session_id"] in imported_sessions:
            continue
        try:
            record = json.loads(row["data"])
        except (TypeError, json.JSONDecodeError):
            continue
        if record.get("role") not in (None, "assistant"):
            continue
        usage = parsed_usage(record.get("tokens") or record.get("usage"))
        date_str = local_date(row["time_created"], milliseconds=True)
        if usage and within_days(date_str, days):
            result.add(date_str, usage, str(row["agent_id"] or "main"))
    return result


def scan_json_message_storage(root: Path, days: int) -> ScanResult:
    result = ScanResult(sources=[str(root)])
    seen: set[str] = set()
    for path in root.rglob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict) or record.get("role") not in (None, "assistant"):
            continue
        usage = parsed_usage(record.get("tokens") or record.get("usage"))
        time_data = record.get("time") if isinstance(record.get("time"), dict) else {}
        timestamp = (
            record.get("time_created")
            or time_data.get("created")
            or record.get("created_at")
            or record.get("timestamp")
        )
        date_str = local_date(timestamp, milliseconds=isinstance(timestamp, (int, float)) and timestamp > 10**11)
        record_id = str(record.get("id") or path)
        if usage and within_days(date_str, days) and record_id not in seen:
            seen.add(record_id)
            result.add(
                date_str,
                usage,
                str(record.get("agent_id") or record.get("agent") or "main"),
            )
    return result


def scan_mimocode(days: int = 365, db_path: Optional[Path] = None) -> ScanResult:
    path = db_path or first_existing(
        [
            xdg_data_home() / "mimocode" / "mimocode.db",
            expand_path("~/.local/share/mimocode/mimocode.db"),
        ]
    )
    if not path:
        return ScanResult(warnings=["database not found"])
    return sqlite_message_scan(path, days, exclude_imported_claude=True)


def scan_opencode(days: int = 365, storage_path: Optional[Path] = None) -> ScanResult:
    candidates = [
        storage_path,
        xdg_data_home() / "opencode" / "opencode.db",
        xdg_data_home() / "opencode" / "storage.db",
        expand_path("~/.local/share/opencode/opencode.db"),
    ]
    path = first_existing(candidate for candidate in candidates if candidate)
    if path and path.is_file():
        return sqlite_message_scan(path, days)

    root = storage_path or xdg_data_home() / "opencode" / "storage"
    if root.exists():
        return scan_json_message_storage(root, days)
    return ScanResult(warnings=["storage not found"])


def hermes_db_candidates() -> list[Path]:
    root = expand_path(os.environ.get("HERMES_HOME", "~/.hermes"))
    paths = [root / "state.db"]
    profiles = root / "profiles"
    if profiles.exists():
        paths.extend(sorted(profiles.glob("*/state.db")))
    return paths


def scan_hermes(days: int = 365, db_paths: Optional[list[Path]] = None) -> ScanResult:
    result = ScanResult()
    paths = db_paths or [path for path in hermes_db_candidates() if path.exists()]
    if not paths:
        result.warnings.append("state.db not found")
        return result

    seen: set[tuple[str, str]] = set()
    cutoff = (datetime.now() - timedelta(days=days)).timestamp()
    for path in paths:
        result.sources.append(str(path))
        connection = open_readonly_sqlite(path)
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "sessions" not in tables:
            connection.close()
            result.warnings.append(f"{path}: sessions table not found")
            continue
        columns = table_columns(connection, "sessions")
        token_columns = [
            field
            for field in (
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "reasoning_tokens",
            )
            if field in columns
        ]
        if not {"id", "started_at"}.issubset(columns) or not token_columns:
            connection.close()
            result.warnings.append(f"{path}: unsupported sessions schema")
            continue
        source_expr = "source" if "source" in columns else "'main' AS source"
        rows = connection.execute(
            f"SELECT id, started_at, {source_expr}, {', '.join(token_columns)} "
            "FROM sessions WHERE started_at >= ?",
            (cutoff,),
        ).fetchall()
        connection.close()
        for row in rows:
            identity = (str(path), str(row["id"]))
            if identity in seen:
                continue
            seen.add(identity)
            raw = {column: row[column] for column in token_columns}
            usage = parsed_usage(raw)
            date_str = local_date(row["started_at"])
            if usage and within_days(date_str, days):
                result.add(date_str, usage, str(row["source"] or "main"))
    return result


def scan_all_tools(
    days: int = 365,
    *,
    codex_db: Optional[Path] = None,
    claude_dir: Optional[Path] = None,
    mimocode_db: Optional[Path] = None,
    opencode_path: Optional[Path] = None,
    hermes_dbs: Optional[list[Path]] = None,
) -> Dict[str, ScanResult]:
    return {
        "codex": scan_codex(days, codex_db),
        "claude_code": scan_claude_code(days, claude_dir),
        "mimocode": scan_mimocode(days, mimocode_db),
        "opencode": scan_opencode(days, opencode_path),
        "hermes": scan_hermes(days, hermes_dbs),
    }


def merge_tool_data(tool_data: Dict[str, ScanResult]) -> Dict[str, Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    for tool_name, result in tool_data.items():
        for date_str, usage in result.daily.items():
            if date_str not in merged:
                merged[date_str] = {**empty_usage(), "tools": {}, "agents": {}}
            add_usage(merged[date_str], usage)
            merged[date_str]["tools"][tool_name] = usage["total_tokens"]
            merged[date_str]["agents"].update(
                {
                    f"{tool_name}:{agent}": total
                    for agent, total in result.daily_agents.get(date_str, {}).items()
                }
            )
    return merged


def calculate_statistics(daily_usage: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    active = {
        date_str: usage
        for date_str, usage in daily_usage.items()
        if usage.get("total_tokens", 0) > 0
    }
    if not active:
        return {
            "total_tokens": 0,
            "peak_day": None,
            "peak_tokens": 0,
            "current_streak": 0,
            "longest_streak": 0,
            "total_days_active": 0,
        }

    peak_day, peak_usage = max(
        active.items(), key=lambda item: item[1]["total_tokens"]
    )
    dates = sorted(datetime.strptime(value, "%Y-%m-%d").date() for value in active)
    longest_streak = current_run = 1
    for previous, current in zip(dates, dates[1:]):
        current_run = current_run + 1 if (current - previous).days == 1 else 1
        longest_streak = max(longest_streak, current_run)

    today = datetime.now().date()
    current_streak = 0
    while (today - timedelta(days=current_streak)).strftime("%Y-%m-%d") in active:
        current_streak += 1

    return {
        "total_tokens": sum(day["total_tokens"] for day in active.values()),
        "peak_day": peak_day,
        "peak_tokens": peak_usage["total_tokens"],
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "total_days_active": len(active),
    }


def build_output(
    tool_data: Dict[str, ScanResult],
    merged_data: Dict[str, Dict[str, Any]],
    statistics: Dict[str, Any],
    device_name: str,
) -> Dict[str, Any]:
    return {
        "schema_version": 2,
        "generated_at": datetime.now().astimezone().isoformat(),
        "device": device_name,
        "tools_scanned": list(tool_data.keys()),
        "per_tool_summary": {
            tool: sum(day["total_tokens"] for day in result.daily.values())
            for tool, result in tool_data.items()
        },
        "per_agent_summary": {
            f"{tool}:{agent}": total
            for tool, result in tool_data.items()
            for agent, total in result.agents.items()
        },
        "scan_status": {
            tool: {
                "available": bool(result.sources),
                "warning_count": len(result.warnings),
            }
            for tool, result in tool_data.items()
        },
        "statistics": statistics,
        "daily_usage": merged_data,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan AI coding tool usage")
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--output", default="data/ai-usage.json")
    parser.add_argument("--tools", nargs="+")
    parser.add_argument("--device-name", default=socket.gethostname())
    parser.add_argument("--codex-db")
    parser.add_argument("--claude-dir")
    parser.add_argument("--mimocode-db")
    parser.add_argument("--opencode-path")
    parser.add_argument("--hermes-db", action="append")
    args = parser.parse_args()

    tool_data = scan_all_tools(
        args.days,
        codex_db=expand_path(args.codex_db) if args.codex_db else None,
        claude_dir=expand_path(args.claude_dir) if args.claude_dir else None,
        mimocode_db=expand_path(args.mimocode_db) if args.mimocode_db else None,
        opencode_path=expand_path(args.opencode_path) if args.opencode_path else None,
        hermes_dbs=[expand_path(path) for path in args.hermes_db]
        if args.hermes_db
        else None,
    )
    if args.tools:
        requested = set(args.tools)
        unknown = requested.difference(tool_data)
        if unknown:
            parser.error(f"unknown tools: {', '.join(sorted(unknown))}")
        tool_data = {tool: result for tool, result in tool_data.items() if tool in requested}

    merged_data = merge_tool_data(tool_data)
    statistics = calculate_statistics(merged_data)
    output = build_output(tool_data, merged_data, statistics, args.device_name)
    output_path = expand_path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Saved usage data to {output_path}")
    for tool, total in output["per_tool_summary"].items():
        warning = "; ".join(tool_data[tool].warnings)
        suffix = f" ({warning})" if warning else ""
        print(f"  {tool}: {total:,} tokens{suffix}")
    print(f"  total: {statistics['total_tokens']:,} tokens")


if __name__ == "__main__":
    main()
