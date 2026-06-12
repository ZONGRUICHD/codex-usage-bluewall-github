import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from scripts.merge_devices import merge_daily_usage
from scripts.scan_all_tools import (
    scan_claude_code,
    scan_codex,
    scan_hermes,
    scan_mimocode,
    scan_opencode,
)


class UsageScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.now = datetime.now(timezone.utc)
        self.iso_now = self.now.isoformat().replace("+00:00", "Z")
        self.epoch = int(self.now.timestamp())
        self.epoch_ms = self.epoch * 1000

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_message_db(self, name="usage.db"):
        path = self.root / name
        connection = sqlite3.connect(path)
        connection.executescript(
            """
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            """
        )
        return path, connection

    def test_claude_includes_cache_tokens(self):
        project = self.root / "claude" / "project"
        project.mkdir(parents=True)
        record = {
            "type": "assistant",
            "uuid": "assistant-1",
            "timestamp": self.iso_now,
            "message": {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 20,
                }
            },
        }
        (project / "session.jsonl").write_text(json.dumps(record) + "\n")

        result = scan_claude_code(30, self.root / "claude")
        usage = next(iter(result.daily.values()))
        self.assertEqual(usage["total_tokens"], 135)
        self.assertEqual(usage["cache_read_tokens"], 100)
        self.assertEqual(usage["cache_write_tokens"], 20)

    def test_codex_uses_cumulative_high_water_mark(self):
        rollout = self.root / "rollout.jsonl"
        events = []
        for total, input_tokens, output_tokens in (
            (100, 80, 20),
            (100, 80, 20),
            (150, 120, 30),
        ):
            events.append(
                {
                    "timestamp": self.iso_now,
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "total_token_usage": {
                                "input_tokens": input_tokens,
                                "output_tokens": output_tokens,
                                "total_tokens": total,
                            }
                        },
                    },
                }
            )
        rollout.write_text("\n".join(json.dumps(event) for event in events))

        db_path = self.root / "state.sqlite"
        connection = sqlite3.connect(db_path)
        connection.execute(
            """
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                tokens_used INTEGER,
                source TEXT
            )
            """
        )
        connection.execute(
            "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)",
            ("thread-1", str(rollout), self.epoch, self.epoch, 150, "cli"),
        )
        connection.commit()
        connection.close()

        result = scan_codex(30, db_path)
        self.assertEqual(sum(day["total_tokens"] for day in result.daily.values()), 150)
        self.assertEqual(result.agents["cli"], 150)

    def test_mimocode_counts_subagents_and_excludes_claude_imports(self):
        db_path, connection = self.create_message_db("mimocode.db")
        connection.execute(
            "CREATE TABLE claude_import (source_uuid TEXT, session_id TEXT)"
        )
        connection.execute(
            "INSERT INTO claude_import VALUES (?, ?)", ("claude-1", "imported")
        )
        messages = [
            (
                "native-main",
                "native",
                "main",
                {"role": "assistant", "tokens": {"input": 10, "output": 5}},
            ),
            (
                "native-agent",
                "native",
                "checkpoint-writer",
                {
                    "role": "assistant",
                    "tokens": {
                        "input": 20,
                        "output": 4,
                        "reasoning": 2,
                        "cache": {"read": 30, "write": 1},
                    },
                },
            ),
            (
                "imported-message",
                "imported",
                "main",
                {"role": "assistant", "tokens": {"input": 999, "output": 999}},
            ),
        ]
        connection.executemany(
            "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
            [
                (message_id, session_id, agent, self.epoch_ms, json.dumps(data))
                for message_id, session_id, agent, data in messages
            ],
        )
        connection.commit()
        connection.close()

        result = scan_mimocode(30, db_path)
        self.assertEqual(sum(day["total_tokens"] for day in result.daily.values()), 72)
        self.assertEqual(result.agents["main"], 15)
        self.assertEqual(result.agents["checkpoint-writer"], 57)

    def test_opencode_sqlite_tokens(self):
        db_path, connection = self.create_message_db("opencode.db")
        connection.execute(
            "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
            (
                "message-1",
                "session-1",
                "reviewer",
                self.epoch_ms,
                json.dumps(
                    {
                        "role": "assistant",
                        "tokens": {
                            "input": 12,
                            "output": 8,
                            "cache": {"read": 40},
                        },
                    }
                ),
            ),
        )
        connection.commit()
        connection.close()

        result = scan_opencode(30, db_path)
        self.assertEqual(sum(day["total_tokens"] for day in result.daily.values()), 60)
        self.assertEqual(result.agents["reviewer"], 60)

    def test_hermes_session_columns(self):
        db_path = self.root / "state.db"
        connection = sqlite3.connect(db_path)
        connection.execute(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                started_at REAL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_read_tokens INTEGER,
                cache_write_tokens INTEGER,
                reasoning_tokens INTEGER
            )
            """
        )
        connection.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("session-1", "telegram", self.epoch, 10, 5, 20, 2, 3),
        )
        connection.commit()
        connection.close()

        result = scan_hermes(30, [db_path])
        self.assertEqual(sum(day["total_tokens"] for day in result.daily.values()), 40)
        self.assertEqual(result.agents["telegram"], 40)

    def test_multi_device_merge_preserves_tool_and_agent_breakdown(self):
        snapshots = [
            {
                "daily_usage": {
                    "2026-01-01": {
                        "input_tokens": 5,
                        "output_tokens": 5,
                        "total_tokens": 10,
                        "tools": {"codex": 10},
                        "agents": {"codex:cli": 10},
                    }
                }
            },
            {
                "daily_usage": {
                    "2026-01-01": {
                        "input_tokens": 20,
                        "output_tokens": 10,
                        "total_tokens": 30,
                        "tools": {"hermes": 30},
                        "agents": {"hermes:telegram": 30},
                    }
                }
            },
        ]
        merged = merge_daily_usage(snapshots)["2026-01-01"]
        self.assertEqual(merged["total_tokens"], 40)
        self.assertEqual(merged["tools"], {"codex": 10, "hermes": 30})
        self.assertEqual(
            merged["agents"], {"codex:cli": 10, "hermes:telegram": 30}
        )


if __name__ == "__main__":
    unittest.main()
