import json
import unittest
from pathlib import Path

from scripts.merge_devices import (
    _stable_source_name,
    build_merged_output,
    validate_snapshot,
)
from scripts.scan_all_tools import calculate_statistics


def exact_snapshot(
    *,
    device="device-a",
    date="2026-07-17",
    tool="codex",
    agent="codex:cli",
    total=10,
    data_quality=None,
):
    snapshot = {
        "schema_version": 3,
        "generated_at": "2026-07-17T00:00:00+08:00",
        "device": device,
        "token_accounting": {"status": "exact_for_included_data"},
        "tools_scanned": [tool],
        "per_tool_summary": {tool: total},
        "per_agent_summary": {agent: total},
        "daily_usage": {
            date: {
                "input_tokens": total,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "reasoning_tokens": 0,
                "total_tokens": total,
                "sessions": 1,
                "tools": {tool: total},
                "agents": {agent: total},
            }
        },
    }
    if data_quality is not None:
        snapshot["data_quality"] = data_quality
    return snapshot


class MergeDeviceValidationTests(unittest.TestCase):
    def test_accepts_exact_schema_three_snapshot(self):
        snapshot = exact_snapshot()
        snapshot["per_tool_summary"]["scanned_but_unused"] = 0
        validate_snapshot(snapshot, "fixture")

    def test_rejects_legacy_schema(self):
        snapshot = exact_snapshot()
        snapshot["schema_version"] = 2
        with self.assertRaisesRegex(ValueError, "schema_version must be at least 3"):
            validate_snapshot(snapshot, "fixture")

    def test_source_name_is_safe_on_windows_and_posix(self):
        self.assertEqual(
            _stable_source_name(r"C:\Users\private\Temp\snapshot.json"),
            "snapshot.json",
        )
        self.assertEqual(
            _stable_source_name("/home/private/tmp/snapshot.json"),
            "snapshot.json",
        )

    def test_requires_device_and_timezone_aware_generated_at(self):
        invalid_values = (
            ("device", ""),
            ("generated_at", "not-a-timestamp"),
            ("generated_at", "2026-07-17T00:00:00"),
        )
        for field, invalid in invalid_values:
            with self.subTest(field=field, invalid=invalid):
                snapshot = exact_snapshot()
                snapshot[field] = invalid
                with self.assertRaises(ValueError):
                    validate_snapshot(snapshot, "fixture")

    def test_rejects_unreconciled_daily_totals(self):
        mutations = {
            "tools": lambda value: value["daily_usage"]["2026-07-17"][
                "tools"
            ].update(codex=9),
            "agents": lambda value: value["daily_usage"]["2026-07-17"][
                "agents"
            ].update({"codex:cli": 9}),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                snapshot = exact_snapshot()
                mutate(snapshot)
                with self.assertRaisesRegex(ValueError, f"{label} total"):
                    validate_snapshot(snapshot, "fixture")

    def test_rejects_unreconciled_summaries(self):
        for summary_key in ("per_tool_summary", "per_agent_summary"):
            with self.subTest(summary_key=summary_key):
                snapshot = exact_snapshot()
                first_key = next(iter(snapshot[summary_key]))
                snapshot[summary_key][first_key] += 1
                with self.assertRaisesRegex(ValueError, "does not reconcile"):
                    validate_snapshot(snapshot, "fixture")

    def test_rejects_negative_or_non_integer_token_counts(self):
        for invalid in (-1, 1.5, True):
            with self.subTest(invalid=invalid):
                snapshot = exact_snapshot()
                snapshot["daily_usage"]["2026-07-17"]["tools"]["codex"] = invalid
                with self.assertRaisesRegex(ValueError, "non-negative integer"):
                    validate_snapshot(snapshot, "fixture")

    def test_merge_preserves_and_attributes_historical_gap(self):
        incomplete = exact_snapshot(
            device="retired",
            tool="claude_code",
            agent="claude_code:main",
            total=10,
            data_quality={
                "complete": False,
                "status": "historical_gap",
                "notes": [
                    {
                        "code": "retired_codex_omitted",
                        "message": "Unverifiable retired Codex history was omitted.",
                    }
                ],
            },
        )
        current = exact_snapshot(
            device="current", tool="codex", agent="codex:cli", total=25
        )
        snapshots = {
            "retired": (
                incomplete,
                r"C:\Users\private\AppData\Local\Temp\retired.json",
            ),
            "current": (current, r"D:\scratch\current.json"),
        }

        for data, source in snapshots.values():
            validate_snapshot(data, source)
        merged = build_merged_output(snapshots)

        self.assertEqual(merged["statistics"]["total_tokens"], 35)
        self.assertEqual(
            merged["per_tool_summary"], {"claude_code": 10, "codex": 25}
        )
        self.assertEqual(
            merged["token_accounting"]["status"], "exact_for_included_data"
        )
        self.assertFalse(merged["data_quality"]["complete"])
        self.assertEqual(merged["data_quality"]["status"], "historical_gap")
        note = merged["data_quality"]["notes"][0]
        self.assertEqual(note["code"], "retired_codex_omitted")
        self.assertEqual(note["device"], "retired")
        self.assertEqual(note["source_file"], "retired.json")
        self.assertEqual(
            merged["source_files"], ["retired.json", "current.json"]
        )
        self.assertTrue(
            all("\\" not in name and ":" not in name for name in merged["source_files"])
        )

    def test_omission_note_cannot_be_published_as_complete(self):
        snapshot = exact_snapshot(
            data_quality={
                "complete": True,
                "status": "complete",
                "notes": [
                    {
                        "code": "retired_codex_omitted",
                        "message": "Historical data was omitted.",
                    }
                ],
            }
        )
        merged = build_merged_output(
            {"device-a": (snapshot, r"C:\Temp\snapshot.json")}
        )
        self.assertFalse(merged["data_quality"]["complete"])
        self.assertEqual(merged["data_quality"]["status"], "historical_gap")
        self.assertEqual(
            merged["data_quality"]["sources"][0]["status"], "incomplete"
        )

    def test_legacy_archive_retains_only_exact_non_codex_totals(self):
        path = Path(__file__).parents[1] / "data" / "ai-usage-ZONGRUICHD.json"
        archive = json.loads(path.read_text(encoding="utf-8"))

        validate_snapshot(archive, str(path))
        self.assertFalse(archive["data_quality"]["complete"])
        self.assertEqual(
            archive["data_quality"]["notes"][0]["code"],
            "retired_codex_omitted",
        )
        self.assertNotIn("codex", archive["per_tool_summary"])
        self.assertEqual(archive["statistics"]["total_tokens"], 126_716_605)
        self.assertEqual(
            archive["statistics"], calculate_statistics(archive["daily_usage"])
        )

        for usage in archive["daily_usage"].values():
            self.assertNotIn("codex", usage["tools"])
            self.assertFalse(any(name.startswith("codex:") for name in usage["agents"]))
            self.assertEqual(usage["sessions"], 0)
            self.assertEqual(
                sum(
                    usage[field]
                    for field in (
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_write_tokens",
                        "reasoning_tokens",
                    )
                ),
                0,
            )


if __name__ == "__main__":
    unittest.main()
