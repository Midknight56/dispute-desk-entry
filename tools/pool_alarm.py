"""Daily local check of the judge sandbox pool."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

LOW_AT = 2


def is_low(counts: list[dict]) -> list[str]:
    by_kind = {row.get("kind"): row.get("free", 0) for row in counts}
    return [name for kind, name in (("fight", "fight"), ("accept", "refund")) if by_kind.get(kind, 0) <= LOW_AT]


def pool_line(counts: list[dict], now: datetime) -> str:
    by_kind = {row.get("kind"): row.get("free", 0) for row in counts}
    values = [f"{name} {by_kind.get(kind, 0)} free" for kind, name in (("fight", "fight"), ("accept", "refund"), ("ship", "ship"))]
    low = is_low(counts)
    suffix = f"LOW: {', '.join(low)}" if low else "OK"
    return f"- {now:%Y-%m-%d %H:%M}: {', '.join(values)}. {suffix}"


def fail_line(error: object, now: datetime) -> str:
    clean = " ".join(str(error).splitlines())[:120]
    return f"- {now:%Y-%m-%d %H:%M}: could not read the pool ({clean}). CHECK"


def read_pool() -> list[dict]:
    request = Request(f"{paths.DESK}/api/judge/pool", headers={"User-Agent": "Mozilla/5.0 DisputeDeskCheck/pool-alarm"})
    with urlopen(request, timeout=60) as response:
        payload = json.load(response)
    return payload if isinstance(payload, list) else payload["results"]


def append_line(state: Path, line: str) -> None:
    state.parent.mkdir(parents=True, exist_ok=True)
    if not state.exists():
        state.write_text("# Judge pool state\n\nOne line a day from tools/pool_alarm.py. LOW means fight or refund is at 2 free or below: refill with tools/pool.py (docs/POOL.md).\n\n", encoding="utf-8")
    with state.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(line + "\n")


def main(argv: list[str] | None = None, reader: Callable[[], list[dict]] | None = None, now: datetime | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path)
    args = parser.parse_args(argv)
    state = args.state or Path(paths.REPO) / "docs" / "STATE.md"
    current = now or datetime.now().astimezone()
    try:
        counts = (reader or read_pool)()
        line = pool_line(counts, current)
        code = 2 if is_low(counts) else 0
    except Exception as error:
        line = fail_line(error, current)
        code = 1
    append_line(state, line)
    print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
