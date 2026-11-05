"""Run a sandbox case through the hosted desk and poll PayPal for its outcome."""
import json
import http.cookiejar
import os
import sys
import time
import urllib.error
import urllib.request

DESK_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import day_one as d
import pool
from paths import DESK, SECRETS



def owner_key():
    with open(os.path.join(SECRETS, "dispute-desk-owner.local.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("DESK_OWNER_KEY="):
                return line.rstrip("\r\n").split("=", 1)[1]
    raise RuntimeError("owner key is missing")


def desk_post(path, key, body=None):
    req = urllib.request.Request(DESK + path, data=json.dumps(body or {}).encode("utf-8"), method="POST",
                                 headers={"content-type": "application/json", "x-desk-key": key, "user-agent": "DisputeDeskTools/1.0"})
    try:
        with DESK_OPENER.open(req, timeout=60) as response:
            raw = response.read().decode("utf-8", "replace")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return e.code, {}
    except (urllib.error.URLError, OSError):
        return 0, {}


def stage(name, started):
    print(f"{name}: {time.monotonic() - started:.1f}s", flush=True)


def main():
    started = time.monotonic()
    dispute = None
    if "--dispute" in sys.argv:
        dispute = sys.argv[sys.argv.index("--dispute") + 1]
        stage("creation skipped", started)
    else:
        dispute = pool.one("accept", "6.00", "Kiln log template, digital download", custom_prefix="dd-e2e", add_to_pool=False)
        if not dispute:
            print("failure stage creation HTTP 0", flush=True)
            return 1
        stage("created " + dispute, started)

    try:
        key = owner_key()
    except (OSError, RuntimeError):
        print("failure stage owner key HTTP 0", flush=True)
        return 1

    code, result = desk_post(f"/api/disputes/{dispute}/analyse", key)
    if code != 200:
        print(f"failure stage analyse HTTP {code}", flush=True)
        return 1
    run = result.get("run", {})
    verdict = (run.get("decision") or {}).get("verdict", "")
    if not verdict:
        print("failure stage analyse HTTP 200", flush=True)
        return 1
    print("verdict:", verdict, flush=True)
    stage("analyse", started)

    code, result = desk_post(f"/api/disputes/{dispute}/approve", key, {"version": run.get("version")})
    filed = result.get("filed") or {}
    if code != 200 or not filed.get("ok"):
        print(f"failure stage approve HTTP {code}", flush=True)
        return 1
    print("filing:", filed.get("call", "filed"), flush=True)
    stage("approve", started)

    token = d.tok()
    deadline = time.monotonic() + 15 * 60
    while time.monotonic() < deadline:
        code, outcome = d.http("GET", f"/v1/customer/disputes/{dispute}", token)
        if code != 200:
            print(f"failure stage PayPal poll HTTP {code}", flush=True)
            return 1
        if outcome.get("status") == "RESOLVED":
            print("final outcome_code:", (outcome.get("dispute_outcome") or {}).get("outcome_code", ""), flush=True)
            stage("resolved", started)
            print(f"total: {time.monotonic() - started:.1f}s", flush=True)
            return 0
        time.sleep(15)
    print("failure stage PayPal poll HTTP 0", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
