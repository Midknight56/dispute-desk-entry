import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from tools.pool_alarm import fail_line, main, pool_line


class PoolAlarmTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 5, 9, 0)

    def test_pool_lines(self):
        self.assertEqual(pool_line([
            {"kind": "fight", "total": 10, "free": 8},
            {"kind": "accept", "total": 10, "free": 8},
            {"kind": "ship", "total": 20, "free": 13},
        ], self.now), "- 2026-11-05 09:00: fight 8 free, refund 8 free, ship 13 free. OK")
        self.assertEqual(pool_line([
            {"kind": "fight", "total": 10, "free": 2},
            {"kind": "accept", "total": 10, "free": 5},
            {"kind": "ship", "total": 20, "free": 13},
        ], datetime(2026, 11, 20, 9, 0)), "- 2026-11-20 09:00: fight 2 free, refund 5 free, ship 13 free. LOW: fight")
        self.assertEqual(pool_line([
            {"kind": "fight", "total": 10, "free": 0},
            {"kind": "accept", "total": 10, "free": 1},
            {"kind": "ship", "total": 20, "free": 13},
        ], datetime(2026, 11, 20, 9, 0)), "- 2026-11-20 09:00: fight 0 free, refund 1 free, ship 13 free. LOW: fight, refund")
        self.assertEqual(pool_line([], datetime(2026, 11, 20, 9, 0)), "- 2026-11-20 09:00: fight 0 free, refund 0 free, ship 0 free. LOW: fight, refund")

    def test_fail_line_sanitizes_and_cuts_error(self):
        line = fail_line("x" * 130 + "\nnext", datetime(2026, 11, 20, 9, 0))
        self.assertEqual(line, "- 2026-11-20 09:00: could not read the pool (" + "x" * 120 + "). CHECK")
        self.assertNotIn("\n", line)

    def test_main_appends_header_once_and_returns_status(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.md"
            now = datetime(2026, 11, 20, 9, 0)
            for counts, expected in [
                ([{"kind": "fight", "free": 8}, {"kind": "accept", "free": 8}, {"kind": "ship", "free": 13}], 0),
                ([{"kind": "fight", "free": 2}, {"kind": "accept", "free": 5}, {"kind": "ship", "free": 13}], 2),
            ]:
                self.assertEqual(main(["--state", str(state)], reader=lambda counts=counts: counts, now=now), expected)
            self.assertEqual(main(["--state", str(state)], reader=lambda: (_ for _ in ()).throw(RuntimeError("offline")), now=now), 1)
            content = state.read_text(encoding="utf-8")
            self.assertEqual(content.count("# Judge pool state"), 1)
            self.assertEqual(content.count("One line a day from tools/pool_alarm.py."), 1)
            self.assertEqual(len([line for line in content.splitlines() if line.startswith("- ")]), 3)
            self.assertIn("CHECK", content)


if __name__ == "__main__":
    unittest.main()
