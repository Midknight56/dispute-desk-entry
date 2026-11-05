r"""Fill the judge pool with real sandbox disputes, one at a time.

For each new case: create an order, the sandbox buyer approves it (headless browser), capture it, add tracking and
mark it delivered for a fight case, the buyer opens Item Not Received, then wait until the dispute shows and add it
to the pool table in D1.

Usage: python tools/pool.py --fight 3 --accept 2 [--first-buyer 2]
Amounts stay under $11.00: PayPal's sandbox escalates a dispute of $11.00 or more to the claim stage at once (seen
twice on 22 Oct, both $48.00 disputes arrived as CHARGEBACK and UNDER_REVIEW), and it simulates escalation days for
$5.00 to $5.99 and $9.00 to $9.99 (docs, "Escalation simulation"). So those ranges are skipped too.
Every browser step runs under the PC wide browser lock (tools/browser.sh), each well under its 45 minute hold.
The sandbox buyers take turns (1, 2, 3), so the pool's disputes do not all come from one account.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import day_one as d  # noqa: E402
from paths import REPO, SECRETS  # noqa: E402

FIGHT = [("8.00", "Ceramic spoon rest"), ("10.50", "Small bud vase"), ("7.25", "Glazed coaster, set of four"),
         ("10.00", "Hand thrown mug"), ("8.75", "Ring dish")]
ACCEPT = [("6.00", "Glaze recipe PDF, digital download"), ("7.50", "Pottery class video, digital download"),
          ("6.50", "Kiln log template, digital download")]
REASON_NOT_RECEIVED = "13.1"


def case_plan(n_fight, n_accept, n_offer=0, first_buyer=1):
    """Return the pool jobs, preserving the item rotation and buyer turns."""
    if min(n_fight, n_accept, n_offer) < 0:
        raise ValueError("case counts must be zero or greater")
    if first_buyer not in (1, 2, 3):
        raise ValueError("first buyer must be 1, 2, or 3")
    jobs = [("fight", *FIGHT[i % len(FIGHT)]) for i in range(n_fight)] + \
           [("accept", *ACCEPT[i % len(ACCEPT)]) for i in range(n_accept)] + \
           [("offer", *FIGHT[i % len(FIGHT)]) for i in range(n_offer)]
    return [(kind, value, desc, 1 + (i + first_buyer - 1) % 3) for i, (kind, value, desc) in enumerate(jobs)]


def shipment_sql(custom, order_id, capture_id, tracking_number, delivered_at, created_at):
    """Build the shipment insert used for delivered fight cases."""
    def quote(value):
        return "'" + str(value).replace("'", "''") + "'"

    return ("INSERT OR REPLACE INTO shipments (custom_id, order_id, capture_id, carrier, tracking_number, delivered_at, "
            f"created_at) VALUES ({quote(custom)}, {quote(order_id)}, {quote(capture_id)}, 'UPS', "
            f"{quote(tracking_number)}, {quote(delivered_at)}, {quote(created_at)})")


def wait_for_dispute(reader, attempts=80, interval=15, sleeper=time.sleep):
    """Poll a dispute reader until the seller can respond to its chargeback."""
    for attempt in range(attempts):
        code, dispute = reader()
        if (code == 200 and dispute.get("status") == "WAITING_FOR_SELLER_RESPONSE" and
                dispute.get("dispute_life_cycle_stage") == "CHARGEBACK"):
            return dispute
        if attempt + 1 < attempts:
            sleeper(interval)
    return None


def one_chargeback(kind, value, desc, add_to_pool=True):
    """Create one API-funded sale and wait for its 13.1 chargeback to reach the desk."""
    import chargeback_probe as probe

    started = time.monotonic()
    custom = next_custom(d.load_state())
    capture = probe.card_sale(value, custom, desc)
    order_id, capture_id = capture["order_id"], capture["id"]
    state = d.load_state()
    state.setdefault("orders", {})[custom] = {"order_id": order_id, "capture_id": capture_id, "value": value,
                                               "created": time.time()}
    state["last"] = custom
    d.save_state(state)

    if kind == "fight":
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        number = "1Z999AA1" + str(int(time.time()))[-8:]
        d1(shipment_sql(custom, order_id, capture_id, number, now, now))
    dispute_id = probe.open_chargeback(capture, value, REASON_NOT_RECEIVED)
    token = d.tok()
    dispute = wait_for_dispute(lambda: d.http("GET", f"/v1/customer/disputes/{dispute_id}", token))
    elapsed = time.monotonic() - started
    if not dispute:
        d.receipt("pool", f"wait chargeback {custom}", 0, f"{dispute_id} did not reach WAITING_FOR_SELLER_RESPONSE/CHARGEBACK")
        print(f"{kind} ${value} {desc}: dispute {dispute_id} not ready after {elapsed:.0f}s")
        return None

    if add_to_pool:
        d1(f"INSERT OR IGNORE INTO pool (dispute_id, kind, position, added_at) VALUES ('{dispute_id}', '{kind}', "
           f"{int(time.time())}, '{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}')")
    state = d.load_state()
    state.setdefault("disputes", {})[dispute_id] = {"found": time.time(), "custom": custom,
                                                    "pool": kind if add_to_pool else None}
    d.save_state(state)
    d.receipt("pool", f"pool add {custom} {kind} ${value}", 200,
              f"{dispute_id} {dispute.get('status')} {dispute.get('dispute_life_cycle_stage')}")
    print(f"{kind} ${value} {desc}: dispute {dispute_id} in {elapsed:.0f}s")
    return dispute_id


def one_ship(value, desc):
    """Create a card sale and keep its shipping record without opening a dispute."""
    import chargeback_probe as probe

    custom = next_custom(d.load_state(), "dd-s")
    capture = probe.card_sale(value, custom, desc)
    order_id, capture_id = capture["order_id"], capture["id"]
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    captured = capture.get("create_time", now)
    state = d.load_state()
    state.setdefault("orders", {})[custom] = {"order_id": order_id, "capture_id": capture_id,
                                               "value": value, "created": time.time()}
    state["last"] = custom
    d.save_state(state)
    number = "1Z999AA1" + str(int(time.time()))[-8:]

    def quote(value):
        return "'" + str(value).replace("'", "''") + "'"

    d1("INSERT OR REPLACE INTO shipments (custom_id, order_id, capture_id, carrier, tracking_number, created_at) "
       f"VALUES ({quote(custom)}, {quote(order_id)}, {quote(capture_id)}, 'UPS', {quote(number)}, {quote(now)}); "
       "INSERT OR IGNORE INTO sales (capture_id, order_id, custom_id, amount, currency, captured_at, added_at) "
       f"VALUES ({quote(capture_id)}, {quote(order_id)}, {quote(custom)}, {quote(value)}, 'USD', {quote(captured)}, {quote(now)}); "
       # For ship rows pool.dispute_id holds the capture id.
       "INSERT OR IGNORE INTO pool (dispute_id, kind, position, added_at) "
       f"VALUES ({quote(capture_id)}, 'ship', {int(time.time())}, {quote(now)})")
    print(f"ship ${value} {desc}: capture {capture_id}, custom_id {custom}, shipping record {number}")
    return capture_id


def cf_env():
    kv = {}
    with open(os.path.join(SECRETS, "hackathon-cf-account.local.txt"), encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\r\n").split("=", 1)
                kv[k] = v
    return dict(os.environ, CLOUDFLARE_ACCOUNT_ID=kv["CLOUDFLARE_ACCOUNT_ID"], CLOUDFLARE_API_TOKEN=kv["CLOUDFLARE_API_TOKEN"])


def d1(sql):
    r = subprocess.run(f'npx wrangler d1 execute dispute-desk --remote --command "{sql}"', shell=True, cwd=REPO,
                       env=cf_env(), capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit(f"d1 failed: {r.stderr.strip().splitlines()[-1:]}")


def run(cmd, timeout=600, buyer=1):
    env = dict(os.environ, BUYER=str(buyer))
    r = subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env=env)
    return r.returncode, (r.stdout + r.stderr)


def next_custom(s, prefix="dd-p"):
    n = 1 + max([int(k[len(prefix):]) for k in s.get("orders", {}) if k.startswith(prefix) and k[len(prefix):].isdigit()] or [0])
    return f"{prefix}{n:03d}"


def one(kind, value, desc, buyer=1, custom_prefix="dd-p", add_to_pool=True):
    s = d.load_state()
    custom = next_custom(s, custom_prefix)
    sys.argv = ["day_one.py", "order", "--value", value, "--custom", custom, "--desc", desc]
    d.cmd_order()
    code, out = run(f"bash tools/browser.sh timeout -k 5 300 node tools/buyer.mjs approve {custom}", timeout=3300, buyer=buyer)
    print(" ", out.strip().splitlines()[-1] if out.strip() else f"approve exit {code}")
    if "approved" not in out or "not approved" in out:
        d.receipt("pool", f"approve {custom} as buyer {buyer}", code, " ".join(out.strip().splitlines()[-2:])[:200])
        return None
    sys.argv = ["day_one.py", "capture", "--custom", custom]
    d.cmd_capture()
    if kind in ("fight", "offer"):
        # The seller's shipping record stays in the desk until the desk files evidence: a tracker already on
        # PayPal sends the buyer straight to a PayPal claim, where the seller can no longer file evidence.
        o = d.load_state()["orders"][custom]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        number = "1Z999AA1" + str(int(time.time()))[-8:]
        delivered = now if kind == "fight" else None
        d1("INSERT OR REPLACE INTO shipments (custom_id, order_id, capture_id, carrier, tracking_number, delivered_at, "
           f"created_at) VALUES ('{custom}', '{o['order_id']}', '{o['capture_id']}', 'UPS', '{number}', "
           f"{'NULL' if delivered is None else chr(39) + delivered + chr(39)}, '{now}')")
        print("  shipping record", number, "delivered", delivered or "not delivered")
    return finish(custom, kind, value, buyer, add_to_pool)


def finish(custom, kind, value, buyer, add_to_pool=True):
    """The buyer opens the dispute on an approved and captured sale, then the dispute joins the pool."""
    item = "Physical product" if kind in ("fight", "offer") else "Digital download"
    for attempt in range(3):
        # a sale paid a minute ago may not be in the buyer's list yet: try again a few minutes later
        code, out = run(f'bash tools/open_inr.sh {custom} {value} "{item}"', timeout=3300, buyer=buyer)
        print(" ", " ".join(out.strip().splitlines()[-2:]))
        if "/complete" in out:
            break
        if attempt < 2:
            time.sleep(180)
    if "/complete" not in out:
        d.receipt("pool", f"open dispute {custom} as buyer {buyer}", code, " ".join(out.strip().splitlines()[-2:])[:200])
        return None
    # The buyer's list can hold two of our sales with the same store and amount, and the row match takes the newest,
    # so the dispute may land on a sister sale (seen 23 Oct: dd-p017's filing went to dd-p020). Any new dispute on
    # one of our captures of this amount counts, and the sale it really landed on is recorded.
    st = d.load_state()
    captures = {o["capture_id"]: c for c, o in st["orders"].items() if o.get("capture_id") and o.get("value") == value}
    known = set(st.get("disputes", {}))
    t = d.tok()
    for _ in range(80):  # up to 20 minutes
        code, j = d.list_disputes(t)
        for item in j.get("items", []) if code == 200 else []:
            if item["dispute_id"] in known:
                continue
            c2, full = d.http("GET", f"/v1/customer/disputes/{item['dispute_id']}", t)
            hit = next((captures[tx.get("seller_transaction_id")] for tx in full.get("disputed_transactions", [])
                        if tx.get("seller_transaction_id") in captures), None)
            if hit:
                did = full["dispute_id"]
                if add_to_pool and kind != "offer":
                    d1(f"INSERT OR IGNORE INTO pool (dispute_id, kind, position, added_at) VALUES ('{did}', '{kind}', "
                       f"{int(time.time())}, '{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}')")
                label = "offer case" if kind == "offer" else "pool add"
                if not add_to_pool and kind != "offer":
                    label = "case found"
                d.receipt("pool", f"{label} {hit} {kind} ${value}" + ("" if hit == custom else f" (filed from {custom})"),
                          200, f"{did} {full.get('status')} {full.get('dispute_life_cycle_stage')}")
                st = d.load_state()
                st.setdefault("disputes", {})[did] = {"found": time.time(), "custom": hit, "pool": kind if add_to_pool and kind != "offer" else None}
                if kind == "offer":
                    st.setdefault("offer_cases", []).append(did)
                d.save_state(st)
                if kind == "offer":
                    print("offer dispute", did)
                return did
        time.sleep(15)
    d.receipt("pool", f"pool add {custom}", 0, "dispute did not show in 20 minutes")
    return None


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print("Usage: python tools/pool.py [--chargeback] --fight N --accept N [--offer N] [--ship N] [--first-buyer 1|2|3] [--dry]\n"
              "Default: create disputes with the sandbox buyer in a headless browser.\n"
              "--chargeback: create card-funded 13.1 disputes through the sandbox API (fight and accept only).\n"
              "--dry: print the case plan without network calls.")
        return
    if "--finish" in sys.argv:
        # --finish <custom> <kind> <value> <buyer>: a sale that is approved and captured but has no dispute yet
        i = sys.argv.index("--finish")
        custom, kind, value, buyer = sys.argv[i + 1:i + 5]
        value = d.load_state()["orders"].get(custom, {}).get("value", value)  # the saved order's amount wins
        finish(custom, kind, value, int(buyer))
        return
    n_ship = int(d.arg("--ship", "0"))
    if n_ship < 0:
        raise ValueError("case counts must be zero or greater")
    n_fight = int(d.arg("--fight", "0"))
    n_accept = int(d.arg("--accept", "0"))
    n_offer = int(d.arg("--offer", "0"))
    first = int(d.arg("--first-buyer", "1"))  # read once: one() overwrites sys.argv
    jobs = case_plan(n_fight, n_accept, n_offer, first)
    chargeback = "--chargeback" in sys.argv
    if chargeback and n_offer:
        raise SystemExit("--chargeback supports fight and accept cases; offer cases use the browser path")
    if "--dry" in sys.argv:
        mode = "card sale" if n_ship and not jobs else "chargeback API" if chargeback else "browser"
        print(f"Plan ({mode}): {len(jobs) + n_ship} case(s)")
        tag_start = int(next_custom(d.load_state())[len("dd-p"):])
        for i, (kind, value, desc, buyer) in enumerate(jobs):
            print(f"{kind} ${value} {desc} (buyer {buyer}, custom_id dd-p{tag_start + i:03d})")
        ship_start = int(next_custom(d.load_state(), "dd-s")[len("dd-s"):])
        for i in range(n_ship):
            value, desc = FIGHT[i % len(FIGHT)]
            print(f"ship ${value} {desc} (card sale, custom_id dd-s{ship_start + i:03d}, shipping record, sales row, pool ship; no dispute or tracking call)")
        return
    for i in range(n_ship):
        one_ship(*FIGHT[i % len(FIGHT)])
    for kind, value, desc, buyer in jobs:
        print(f"{kind} ${value} {desc} (buyer {buyer})")
        if chargeback:
            one_chargeback(kind, value, desc)
        else:
            one(kind, value, desc, buyer)


if __name__ == "__main__":
    main()
