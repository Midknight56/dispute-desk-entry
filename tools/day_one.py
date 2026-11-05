r"""Day one checks for Dispute Desk against the PayPal sandbox. Prints the call, the HTTP code and an id or an error
name. Never prints a key, a token or an email address.

Usage:
  python tools/day_one.py token
  python tools/day_one.py order [--value 48.00] [--custom dd-0001]   create an order (CAPTURE intent)
  python tools/day_one.py capture [--custom dd-0001]                   capture an approved order
  python tools/day_one.py track [--custom dd-0001]                     add tracking to the capture
  python tools/day_one.py disputes                                     list disputes once
  python tools/day_one.py opened                                       write down the time the buyer opened a dispute
  python tools/day_one.py poll [--every 30] [--max 3600]               poll until a dispute on our order appears
  python tools/day_one.py show <dispute_id>                            the fields the agent will use

State (order id, capture id, timings) is kept in tools/out/state.json, which git ignores. Every result line is
appended to tools/out/receipts.jsonl with the time.
"""
import base64
import calendar
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import DESK, SECRETS, OUT  # noqa: E402

BASE = "https://api-m.sandbox.paypal.com"
STATE = os.path.join(OUT, "state.json")
RECEIPTS = os.path.join(OUT, "receipts.jsonl")


def secrets():
    kv = {}
    with open(os.path.join(SECRETS, "paypal-sandbox.local.txt"), encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                kv[k] = v
    return kv


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(s):
    os.makedirs(OUT, exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)


def receipt(check, call, code, note):
    os.makedirs(OUT, exist_ok=True)
    row = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "check": check, "call": call, "http": code, "note": note}
    with open(RECEIPTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    print(f"[{check}] {call} -> {code} {note}")


def http(method, path, token=None, body=None, headers=None, raw=None, tries=4):
    h = dict(headers or {})
    if token:
        h["Authorization"] = "Bearer " + token
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    if method == "POST":
        h.setdefault("PayPal-Request-Id", str(uuid.uuid4()))
    url = BASE + path if path.startswith("/") else path
    req = urllib.request.Request(url, method=method, data=data, headers=h)
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                t = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(t) if t.strip() else {})
        except urllib.error.HTTPError as e:
            t = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(t)
            except Exception:
                return e.code, {"raw": t[:200]}
        except (urllib.error.URLError, OSError) as e:
            # this PC drops about one new connection in ten (MACHINE.md); nothing was sent, so a retry is safe
            if attempt == tries - 1:
                return 0, {"name": f"no connection: {type(e).__name__}"}
            time.sleep(1.5)


def err_name(j):
    if not isinstance(j, dict):
        return ""
    name = j.get("name") or j.get("error") or ""
    issues = [d.get("issue", "") for d in j.get("details", []) if isinstance(d, dict)]
    issues = [i for i in issues if i]
    return (name + (" " + ",".join(issues) if issues else "")).strip()


def token():
    kv = secrets()
    basic = base64.b64encode(f"{kv['PAYPAL_SANDBOX_CLIENT_ID']}:{kv['PAYPAL_SANDBOX_SECRET']}".encode()).decode()
    code, j = http("POST", "/v1/oauth2/token", headers={"Authorization": "Basic " + basic,
                   "Content-Type": "application/x-www-form-urlencoded"}, raw=b"grant_type=client_credentials")
    if code != 200:
        receipt(1, "POST /v1/oauth2/token", code, err_name(j))
        sys.exit(1)
    return code, j


def tok():
    return token()[1]["access_token"]


def arg(name, default):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def cmd_token():
    code, j = token()
    receipt(1, "POST /v1/oauth2/token", code,
            f"expires_in {j.get('expires_in')} s; {len(j.get('scope', '').split())} scopes")


def cmd_order():
    value = arg("--value", "48.00")
    custom = arg("--custom", "dd-0001")
    desc = arg("--desc", "Hand thrown mug, set of two")
    body = {
        "intent": "CAPTURE",
        "purchase_units": [{
            "reference_id": custom,
            "custom_id": custom,
            "invoice_id": custom + "-" + str(int(time.time())),
            "description": desc,
            "amount": {"currency_code": "USD", "value": value},
        }],
        "payment_source": {"paypal": {"experience_context": {
            # a digital item has nothing to ship
            "shipping_preference": "NO_SHIPPING" if "digital" in desc.lower() else "GET_FROM_FILE",
            "user_action": "PAY_NOW",
            "return_url": "https://example.com/return",
            "cancel_url": "https://example.com/cancel",
        }}},
    }
    code, j = http("POST", "/v2/checkout/orders", tok(), body)
    if code not in (200, 201):
        receipt(2, "POST /v2/checkout/orders", code, err_name(j))
        sys.exit(1)
    approve = next((l["href"] for l in j.get("links", []) if l.get("rel") in ("payer-action", "approve")), None)
    s = load_state()
    s.setdefault("orders", {})[custom] = {"order_id": j["id"], "approve": approve, "value": value,
                                          "created": time.time()}
    s["last"] = custom
    save_state(s)
    receipt(2, f"POST /v2/checkout/orders ({custom}, {value} USD)", code, f"order {j['id']} status {j.get('status')}")


def cmd_capture():
    s = load_state()
    custom = arg("--custom", s.get("last"))
    o = s["orders"][custom]
    code, j = http("POST", f"/v2/checkout/orders/{o['order_id']}/capture", tok(), {})
    if code not in (200, 201):
        receipt(2, f"POST /v2/checkout/orders/{{id}}/capture ({custom})", code, err_name(j))
        sys.exit(1)
    cap = j["purchase_units"][0]["payments"]["captures"][0]
    o["capture_id"] = cap["id"]
    o["captured"] = time.time()
    save_state(s)
    receipt(2, f"POST /v2/checkout/orders/{{id}}/capture ({custom})", code,
            f"capture {cap['id']} status {cap.get('status')}")


def cmd_track():
    s = load_state()
    custom = arg("--custom", s.get("last"))
    o = s["orders"][custom]
    number = arg("--number", "1Z999AA10123456784")
    t = tok()
    # The plan's path first (reference/disputes-refunds.md names POST /v2/shipping/trackers), then the Orders v2
    # track call, then the v1 batch call. Every try is recorded.
    # POST /v2/shipping/trackers gave a bare 404 on 22 Oct (no such route); the Orders v2 track call gave 201.
    tries = [
        ("POST /v2/checkout/orders/{id}/track", f"/v2/checkout/orders/{o['order_id']}/track",
         {"capture_id": o["capture_id"], "tracking_number": number, "carrier": "UPS", "notify_payer": False}),
    ]
    for label, path, body in tries:
        code, j = http("POST", path, t, body)
        note = err_name(j)
        if code in (200, 201):
            if "purchase_units" in j:
                trk = j["purchase_units"][0].get("shipping", {}).get("trackers", [])
                note = f"order {j.get('id')} trackers {len(trk)}" + (f" id {trk[0].get('id')}" if trk else "")
                if trk:
                    o["tracker_id"] = trk[0].get("id")
            elif "tracker_identifiers" in j:
                note = f"tracker_identifiers {len(j['tracker_identifiers'])} errors {len(j.get('errors', []))}"
            o["tracking"] = {"path": label, "number": number, "carrier": "UPS", "at": time.time()}
            save_state(s)
            receipt(3, label, code, note)
            if o.get("tracker_id") and "--shipped" not in sys.argv:
                body = {"transaction_id": o["capture_id"], "tracking_number": number, "status": "DELIVERED",
                        "carrier": "UPS"}
                c2, j2 = http("PUT", f"/v1/shipping/trackers/{o['tracker_id']}", t, body)
                receipt(3, "PUT /v1/shipping/trackers/{id} status DELIVERED", c2, err_name(j2))
            return
        receipt(3, label, code, note)
    sys.exit(1)


def list_disputes(t):
    return http("GET", "/v1/customer/disputes?page_size=50", t)


def cmd_disputes():
    code, j = list_disputes(tok())
    items = j.get("items", []) if isinstance(j, dict) else []
    receipt(4, "GET /v1/customer/disputes?page_size=50", code, f"items {len(items)}" if code == 200 else err_name(j))
    for d in items:
        print(" ", d.get("dispute_id"), d.get("status"), d.get("dispute_life_cycle_stage"), d.get("reason"),
              d.get("dispute_amount", {}).get("value"), d.get("create_time"))


def cmd_opened():
    s = load_state()
    s["dispute_opened_at"] = float(arg("--at", time.time()))
    save_state(s)
    print("dispute opened at", time.strftime("%H:%M:%S", time.localtime(s["dispute_opened_at"])))


def our_capture_ids(s):
    return {o.get("capture_id") for o in s.get("orders", {}).values() if o.get("capture_id")}


def dispute_is_ours(t, d, caps):
    code, j = http("GET", f"/v1/customer/disputes/{d['dispute_id']}", t)
    if code != 200:
        return False, j
    for tx in j.get("disputed_transactions", []):
        if tx.get("seller_transaction_id") in caps or str(tx.get("custom", "")).startswith("dd-"):
            return True, j
    return False, j


def cmd_poll():
    every = int(arg("--every", "30"))
    limit = int(arg("--max", "3600"))
    s = load_state()
    caps = our_capture_ids(s)
    known = set(s.get("disputes", {}).keys())
    start = float(s.get("dispute_opened_at", time.time()))
    print(f"polling every {every} s, counting from the time the buyer opened the dispute")
    t, t_at = tok(), time.time()
    checked = set()
    while time.time() - start < limit:
        if time.time() - t_at > 3000:
            t, t_at = tok(), time.time()
        code, j = list_disputes(t)
        if code == 200:
            for d in j.get("items", []):
                did = d["dispute_id"]
                if did in known or did in checked:
                    continue
                ours, full = dispute_is_ours(t, d, caps)
                checked.add(did)
                if ours:
                    delay = time.time() - start
                    s.setdefault("disputes", {})[did] = {"found": time.time(), "delay_s": round(delay),
                                                         "reason": full.get("reason")}
                    save_state(s)
                    receipt(4, "GET /v1/customer/disputes (poll)", 200,
                            f"dispute {did} {full.get('reason')} {full.get('status')} "
                            f"{full.get('dispute_life_cycle_stage')} seen after {round(delay)} s")
                    return
        print(f"  {round(time.time() - start)} s: HTTP {code}, not yet", flush=True)
        time.sleep(every)
    receipt(4, "GET /v1/customer/disputes (poll)", 0, f"no dispute after {limit} s")


def cmd_show():
    did = sys.argv[2]
    code, j = http("GET", f"/v1/customer/disputes/{did}", tok())
    if code != 200:
        print(code, err_name(j))
        return
    keep = {k: j.get(k) for k in ("dispute_id", "reason", "status", "dispute_life_cycle_stage", "dispute_channel",
                                  "seller_response_due_date", "allowed_response_options", "dispute_outcome",
                                  "create_time", "update_time")}
    keep["amount"] = j.get("dispute_amount")
    keep["transactions"] = [{k: tx.get(k) for k in ("seller_transaction_id", "custom", "invoice_number",
                                                     "transaction_status")}
                            for tx in j.get("disputed_transactions", [])]
    keep["links"] = [(l.get("rel"), l.get("method")) for l in j.get("links", [])]
    keep["evidences"] = j.get("evidences")
    print(json.dumps(keep, indent=2))


WORKER = DESK
EVENTS = ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED",
          "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"]


def cmd_webhook():
    """Register this app's one webhook URL. The shared sandbox app allows 10; other apps' URLs are left alone."""
    t = tok()
    url = WORKER + "/webhooks/paypal"
    code, j = http("GET", "/v1/notifications/webhooks", t)
    hooks = j.get("webhooks", []) if code == 200 else []
    print(f"webhooks on the shared app: {len(hooks)}")
    mine = next((h for h in hooks if h.get("url") == url), None)
    s = load_state()
    if mine:
        s["webhook_id"] = mine["id"]
        save_state(s)
        receipt(5, "GET /v1/notifications/webhooks", code, f"ours already registered, id {mine['id']}, "
                f"events {[e['name'] for e in mine.get('event_types', [])]}")
        return
    events = list(EVENTS)
    while True:
        code, j = http("POST", "/v1/notifications/webhooks", t, {"url": url, "event_types": [{"name": e} for e in events]})
        if code == 201:
            s["webhook_id"] = j["id"]
            save_state(s)
            receipt(5, "POST /v1/notifications/webhooks", code, f"id {j['id']}, events {events}")
            return
        receipt(5, "POST /v1/notifications/webhooks", code, err_name(j) + " " + json.dumps(j.get("details", []))[:300])
        bad = [d.get("value") for d in j.get("details", []) if isinstance(d, dict) and d.get("value") in events]
        if not bad:
            sys.exit(1)
        events = [e for e in events if e not in bad]


def cmd_events():
    """Recent webhook deliveries for this app's webhook, from PayPal's side."""
    t = tok()
    code, j = http("GET", "/v1/notifications/webhooks-events?page_size=20", t)
    items = j.get("events", []) if code == 200 else []
    receipt(5, "GET /v1/notifications/webhooks-events", code, f"events {len(items)}" if code == 200 else err_name(j))
    for e in items:
        r = e.get("resource", {})
        print(" ", e.get("id"), e.get("event_type"), e.get("create_time"), r.get("dispute_id") or r.get("id"))


def multipart(fields):
    """fields: list of (name, filename or None, content type, bytes). Returns (body, content type header)."""
    boundary = "ddb" + uuid.uuid4().hex
    out = b""
    for name, filename, ctype, data in fields:
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        out += f"--{boundary}\r\nContent-Disposition: {disp}\r\nContent-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return out, f"multipart/form-data; boundary={boundary}"


def dispute_arg():
    s = load_state()
    return sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else list(s.get("disputes", {}))[-1]


def order_for(t, did):
    code, d = http("GET", f"/v1/customer/disputes/{did}", t)
    custom = d["disputed_transactions"][0].get("custom")
    return d, load_state()["orders"].get(custom, {})


def cmd_evidence():
    """provide-evidence with the tracking as proof of fulfilment (multipart: an input JSON part)."""
    t = tok()
    did = dispute_arg()
    d, o = order_for(t, did)
    tr = o.get("tracking", {})
    evidences = [{"evidence_type": "PROOF_OF_FULFILLMENT",
                  "evidence_info": {"tracking_info": [{"carrier_name": tr.get("carrier", "UPS"),
                                                       "tracking_number": tr.get("number")}]},
                  "notes": "UPS shows the parcel delivered to the buyer's address."}]
    body, ctype = multipart([("input", None, "application/json", json.dumps({"evidences": evidences}).encode())])
    code, j = http("POST", f"/v1/customer/disputes/{did}/provide-evidence", t, raw=body,
                   headers={"Content-Type": ctype})
    receipt(6, f"POST /v1/customer/disputes/{{id}}/provide-evidence (stage {d.get('dispute_life_cycle_stage')}, "
               f"status {d.get('status')})", code, err_name(j) + " " + json.dumps(j.get("details", []))[:300])
    code2, d2 = http("GET", f"/v1/customer/disputes/{did}", t)
    print("  now:", d2.get("status"), d2.get("dispute_life_cycle_stage"))


def cmd_supporting():
    """provide-supporting-info: the one action the dispute's links offered (multipart, notes in the input part)."""
    t = tok()
    did = dispute_arg()
    tr = order_for(t, did)[1].get("tracking", {})
    note = f"Shipped with UPS, tracking {tr.get('number')}, delivered to the buyer's address."
    body, ctype = multipart([("input", None, "application/json", json.dumps({"notes": note}).encode())])
    code, j = http("POST", f"/v1/customer/disputes/{did}/provide-supporting-info", t, raw=body,
                   headers={"Content-Type": ctype})
    receipt(6, "POST /v1/customer/disputes/{id}/provide-supporting-info", code,
            err_name(j) + " " + json.dumps(j.get("details", []))[:300])
    code2, d2 = http("GET", f"/v1/customer/disputes/{did}", t)
    print("  now:", d2.get("status"), d2.get("dispute_life_cycle_stage"))


def cmd_adjudicate():
    t = tok()
    did = dispute_arg()
    outcome = arg("--outcome", "SELLER_FAVOR")
    code, j = http("POST", f"/v1/customer/disputes/{did}/adjudicate", t, {"adjudication_outcome": outcome})
    receipt(7, f"POST /v1/customer/disputes/{{id}}/adjudicate {outcome}", code,
            err_name(j) + " " + json.dumps(j.get("details", []))[:300])
    code2, d2 = http("GET", f"/v1/customer/disputes/{did}", t)
    print("  now:", d2.get("status"), d2.get("dispute_life_cycle_stage"), d2.get("dispute_outcome"))


def cmd_require():
    """Sandbox only: move an UNDER_REVIEW dispute to wait for the seller's (or buyer's) evidence."""
    t = tok()
    did = dispute_arg()
    action = arg("--action", "SELLER_EVIDENCE")
    code, j = http("POST", f"/v1/customer/disputes/{did}/require-evidence", t, {"action": action})
    receipt(6, f"POST /v1/customer/disputes/{{id}}/require-evidence {action}", code,
            err_name(j) + " " + json.dumps(j.get("details", []))[:300])
    code2, d2 = http("GET", f"/v1/customer/disputes/{did}", t)
    print("  now:", d2.get("status"), d2.get("dispute_life_cycle_stage"), "due", d2.get("seller_response_due_date"),
          "links", [l.get("rel") for l in d2.get("links", [])])


def buyer_assertion():
    """The PayPal-Auth-Assertion for the sandbox buyer: an unsigned JWT naming our app and the buyer
    (docs/paypal/test-go-live.2026-10-22.md, Create dispute). Built in code, never printed."""
    kv = secrets()
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    head = b64(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    body = b64(json.dumps({"iss": kv["PAYPAL_SANDBOX_CLIENT_ID"], "email": kv["PAYPAL_SANDBOX_BUYER_EMAIL"]}).encode())
    return f"{head}.{body}."


def cmd_create_dispute():
    """Sandbox only: open a dispute as the buyer by API. --txn is the buyer side transaction id; by default the
    seller's capture id is tried."""
    s = load_state()
    custom = arg("--custom", s.get("last"))
    o = s["orders"][custom]
    txn = arg("--txn", o.get("capture_id"))
    reason = arg("--reason", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED")
    notes = arg("--notes", "")
    issue = arg("--issue", "PRODUCT")
    payload = {
        "disputed_transactions": [{"buyer_transaction_id": txn}],
        "reason": reason,
        "dispute_amount": {"currency_code": "USD", "value": arg("--value", o["value"])},
        "extensions": {"merchant_contacted": True, "merchant_contacted_outcome": "NO_RESPONSE",
                       "merchandize_dispute_properties": {"issue_type": issue}},
    }
    if notes:
        payload["evidences"] = [{"notes": notes}]
    body, ctype = multipart([("input", None, "application/json", json.dumps(payload).encode())])
    t = tok()
    code, j = http("POST", "/v1/customer/disputes", t, raw=body,
                   headers={"Content-Type": ctype, "PayPal-Auth-Assertion": buyer_assertion()})
    did = ""
    for l in j.get("links", []) if isinstance(j, dict) else []:
        if l.get("rel") == "self":
            did = l["href"].rstrip("/").split("/")[-1]
    receipt(4, f"POST /v1/customer/disputes (sandbox create, {custom}, {reason})", code,
            (f"dispute {did}" if did else err_name(j) + " " + json.dumps(j.get("details", []))[:300]))
    if did:
        s.setdefault("disputes", {})[did] = {"found": time.time(), "custom": custom, "via": "api"}
        save_state(s)
        time.sleep(3)
        c2, d2 = http("GET", f"/v1/customer/disputes/{did}", t)
        print("  now:", c2, d2.get("status"), d2.get("dispute_life_cycle_stage"), "due",
              d2.get("seller_response_due_date"), "links", [l.get("rel") for l in d2.get("links", [])])


def cmd_watch():
    """Log each change of status, stage or action links on our disputes, with the minutes since each was created."""
    every = int(arg("--every", "120"))
    limit = int(arg("--max", "7200"))
    last = {}
    start = time.time()
    t, t_at = tok(), time.time()
    while time.time() - start < limit:
        if time.time() - t_at > 3000:
            t, t_at = tok(), time.time()
        for did in list(load_state().get("disputes", {})):
            code, j = http("GET", f"/v1/customer/disputes/{did}", t)
            if code != 200:
                continue
            now = (j.get("status"), j.get("dispute_life_cycle_stage"),
                   tuple(sorted(l.get("rel") for l in j.get("links", []))), str(j.get("dispute_outcome")))
            if last.get(did) != now:
                created = j.get("create_time", "")
                age = ""
                try:
                    ct = calendar.timegm(time.strptime(created[:19], "%Y-%m-%dT%H:%M:%S"))
                    age = f"{(time.time() - ct) / 60:.0f} min after filing"
                except Exception:
                    pass
                receipt(7, f"watch {did}", code, f"{now[0]} {now[1]} links {list(now[2])} outcome {now[3]} ({age})")
                last[did] = now
        time.sleep(every)


def cmd_accept():
    t = tok()
    did = dispute_arg()
    body = {"note": "Digital item, no delivery record. Refunding in full.", "accept_claim_reason": arg("--why", "DID_NOT_SHIP_ITEM"),
            "accept_claim_type": "REFUND"}
    code, j = http("POST", f"/v1/customer/disputes/{did}/accept-claim", t, body)
    receipt(8, "POST /v1/customer/disputes/{id}/accept-claim", code,
            err_name(j) + " " + json.dumps(j.get("details", []))[:300])
    code2, d2 = http("GET", f"/v1/customer/disputes/{did}", t)
    print("  now:", d2.get("status"), d2.get("dispute_life_cycle_stage"), d2.get("dispute_outcome"))


if __name__ == "__main__":
    cmds = {"webhook": cmd_webhook, "events": cmd_events, "evidence": cmd_evidence, "supporting": cmd_supporting,
            "adjudicate": cmd_adjudicate, "accept": cmd_accept, "require": cmd_require, "create_dispute": cmd_create_dispute, "watch": cmd_watch,"token": cmd_token, "order": cmd_order, "capture": cmd_capture, "track": cmd_track,
            "disputes": cmd_disputes, "opened": cmd_opened, "poll": cmd_poll, "show": cmd_show}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(2)
    cmds[sys.argv[1]]()
