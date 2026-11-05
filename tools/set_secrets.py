r"""Put the PayPal sandbox keys into the deployed Worker with `wrangler secret put`, read from the secrets folder by
code. Prints the names only, never a value. Deploys to the hackathon Cloudflare account named in
hackathon-cf-account.local.txt.

Usage: python tools/set_secrets.py [NAME=value-from-state ...]
  With no arguments: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.
  PAYPAL_WEBHOOK_ID is set from tools/out/state.json when present.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import SECRETS, REPO, OUT  # noqa: E402


def read_kv(name):
    kv = {}
    with open(os.path.join(SECRETS, name), encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\r\n").split("=", 1)
                kv[k] = v
    return kv


def main():
    pp = read_kv("paypal-sandbox.local.txt")
    cf = read_kv("hackathon-cf-account.local.txt")
    env = dict(os.environ, CLOUDFLARE_ACCOUNT_ID=cf["CLOUDFLARE_ACCOUNT_ID"], CLOUDFLARE_API_TOKEN=cf["CLOUDFLARE_API_TOKEN"])
    values = {"PAYPAL_CLIENT_ID": pp["PAYPAL_SANDBOX_CLIENT_ID"], "PAYPAL_CLIENT_SECRET": pp["PAYPAL_SANDBOX_SECRET"]}
    try:
        with open(os.path.join(OUT, "state.json"), encoding="utf-8") as f:
            wid = json.load(f).get("webhook_id")
        if wid:
            values["PAYPAL_WEBHOOK_ID"] = wid
    except FileNotFoundError:
        pass
    wanted = sys.argv[1:] or list(values)
    for name in wanted:
        r = subprocess.run("npx wrangler secret put " + name, input=values[name], text=True, cwd=REPO, env=env,
                           shell=True, capture_output=True, encoding="utf-8", errors="replace")
        ok = "Success" in r.stdout or r.returncode == 0
        print(name, "set" if ok else f"FAILED exit {r.returncode}: {r.stderr.strip().splitlines()[-1:]}")


if __name__ == "__main__":
    main()
