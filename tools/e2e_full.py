"""Run the hosted Dispute Desk end to end against PayPal sandbox money.

This script makes card sales and opens disputes. Run it only when the hosted desk and shared
browser are available and sandbox money movement is intended.
"""
import datetime
import json
import http.cookiejar
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

DESK_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chargeback_probe
import day_one
import pool
from paths import DESK, OUT, SECRETS

CHECK = "E2E"
UA = "DisputeDeskTools/1.0"
E2E_OUT = os.path.join(OUT, "e2e")
REPORT = os.path.join(E2E_OUT, "report.md")
OWNER_FILE = os.path.join(SECRETS, "dispute-desk-owner.local.txt")


def make_tag():
    return "dd-e2e" + secrets.token_hex(3)


def expected_code(actual, expected):
    return actual == expected


def owner_key():
    with open(OWNER_FILE, encoding="utf-8") as f:
        for line in f:
            if line.startswith("DESK_OWNER_KEY="):
                return line.rstrip("\r\n").split("=", 1)[1]
    raise RuntimeError("owner key is missing")


def desk_request(method, path, body=None, key=None, user_agent=UA, opener=None, extra_headers=None):
    headers = {"user-agent": user_agent, "accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if key:
        headers["x-desk-key"] = key
    headers.update(extra_headers or {})
    req = urllib.request.Request(DESK + path, data=data, method=method, headers=headers)
    client = opener or DESK_OPENER
    for attempt in range(3):
        try:
            with client.open(req, timeout=90) as response:
                raw = response.read().decode("utf-8", "replace")
                try:
                    result = json.loads(raw) if raw else {}
                except ValueError:
                    result = {"raw": raw[:500]}
                return response.status, result
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                result = json.loads(raw) if raw else {}
            except ValueError:
                result = {"raw": raw[:500]}
            return exc.code, result
        except (urllib.error.URLError, OSError) as exc:
            if attempt == 2 or not is_connection_failure(exc):
                return 0, {"error": f"connection {type(exc).__name__}"}
            time.sleep(1)
    return 0, {"error": "connection failed"}


def is_connection_failure(exc):
    if isinstance(exc, urllib.error.URLError):
        return isinstance(exc.reason, (OSError, TimeoutError))
    return isinstance(exc, (ConnectionError, TimeoutError)) or isinstance(exc, OSError)


def paypal_request(method, path, token, body=None):
    return day_one.http(method, path, token, body, tries=3)


def link_rels(dispute):
    return {str(link.get("rel", "")).lower() for link in dispute.get("links", [])}


def c2_offer_expected(verdict, offer_amount, links):
    return verdict == "OFFER" and offer_amount == "12.00" and "make_offer" not in links


def run_step(rows, name, call, fn, expected):
    started = time.monotonic()
    try:
        response = fn()
        if len(response) == 2:
            code, result = response
            detail = json.dumps(result, ensure_ascii=False)[:500]
        else:
            code, result, detail = response
    except (Exception, SystemExit) as exc:
        code, result, detail = 0, {}, f"{type(exc).__name__}: {exc}"
    seconds = round(time.monotonic() - started, 2)
    ok = bool(expected(code, result, detail))
    outcome = "PASS" if ok else "FAIL"
    note = clean(str(detail)).replace("\n", " ")
    row = {"what": name, "call": call, "http": code, "result": f"{outcome}: {note}", "seconds": seconds}
    rows.append(row)
    day_one.receipt(CHECK, call, code, f"{outcome}: {note}; {seconds:.2f}s")
    print(f"{outcome} | {name} | HTTP {code} | {note} | {seconds:.2f}s", flush=True)
    return ok, result


def skip_step(rows, name, call, reason):
    note = clean(reason).replace("\n", " ")
    rows.append({"what": name, "call": call, "http": "SKIP", "result": f"SKIP: {note}", "seconds": 0.0})
    day_one.receipt(CHECK, call, "SKIP", note)
    print(f"SKIP | {name} | {note}", flush=True)


def step_order(path_a_filed, path_b_filed):
    """Return the high-level report order; repeat approval uses the first filed case."""
    repeat_case = "path_a" if path_a_filed else "path_b" if path_b_filed else None
    return {"paths": ["path_a", "path_b", "bad_paths", "contact_sheets"], "repeat_approve_case": repeat_case}


def clean(value):
    return value.replace("|", "\\|").replace("\r", " ")


def report_table(rows):
    lines = ["| Step | What | Call | HTTP | Result | Seconds |", "|---:|---|---|---:|---|---:|"]
    for i, row in enumerate(rows, 1):
        lines.append(f"| {i} | {clean(row['what'])} | `{clean(row['call'])}` | {row['http']} | {clean(row['result'])} | {row['seconds']:.2f} |")
    return "\n".join(lines)


def code_is(wanted):
    return lambda code, _result, _detail: expected_code(code, wanted)


def successful(code, _result, _detail):
    return code in (200, 201)


def paypal_token():
    return day_one.tok()


def token_step():
    try:
        return 200, paypal_token(), "PayPal access token acquired; value withheld"
    except SystemExit:
        return 0, None, "PayPal token request failed"


def paypal_read_detail(token, dispute_id):
    code, dispute = paypal_request("GET", f"/v1/customer/disputes/{dispute_id}", token)
    return code, dispute, f"links {sorted(link_rels(dispute))}"


def path_b_observation(token, dispute_id, reader=paypal_read_detail, delay=180):
    started = time.monotonic()

    def observe():
        time.sleep(max(0, delay - (time.monotonic() - started)))
        code, dispute, detail = reader(token, dispute_id)
        return code, dispute, f"status {dispute.get('status')}; {detail}"

    return observe


def wait_for_desk(rows, did):
    def poll():
        deadline = time.monotonic() + 12 * 60
        last = None
        while True:
            code, listing = desk_request("GET", "/api/disputes")
            if code != 200:
                return code, listing, f"desk list HTTP {code}"
            items = listing if isinstance(listing, list) else listing.get("disputes", [])
            hit = next((item for item in items if item.get("id") == did or item.get("dispute_id") == did), None)
            status = hit.get("status") if hit else None
            last = status or "not listed"
            if status == "WAITING_FOR_SELLER_RESPONSE":
                return code, hit, f"{did} reached {status}"
            if time.monotonic() >= deadline:
                return 0, hit or {}, f"timed out after 12 minutes; last status {last}"
            time.sleep(15)

    return run_step(rows, f"Desk sees {did}", "GET /api/disputes (15s poll, max 12m)", poll,
                    lambda c, _r, d: c == 200 and "reached WAITING_FOR_SELLER_RESPONSE" in d)


def feed_has_created(did):
    code, feed = desk_request("GET", "/api/feed")
    events = feed if isinstance(feed, list) else feed.get("events", []) if isinstance(feed, dict) else []
    found = any(e.get("title") == "CUSTOMER.DISPUTE.CREATED" and e.get("ref") == did for e in events)
    return code, {"found": found}, "CUSTOMER.DISPUTE.CREATED webhook event " + ("present" if found else "not found")


def browser_run(did, kind="accept"):
    cmd = ["bash", "tools/browser.sh", "node", "tools/judge_run.mjs", "--case", did,
           "--owner", "--video", "--kind", kind]
    proc = subprocess.run(cmd, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          capture_output=True, text=True, check=False)
    output = (proc.stdout or "") + ("\nSTDERR:\n" + proc.stderr if proc.stderr else "")
    return proc.returncode, {"output": output}, f"exit {proc.returncode}; output: {output.strip()[-1800:]}"


def wait_resolved(rows, did, token):
    def poll():
        deadline = time.monotonic() + 20 * 60
        while True:
            code, dispute = paypal_request("GET", f"/v1/customer/disputes/{did}", token)
            if code != 200:
                return code, dispute, f"PayPal dispute GET HTTP {code}"
            status = dispute.get("status")
            if status == "RESOLVED":
                outcome = (dispute.get("dispute_outcome") or {}).get("outcome_code", "unknown")
                return 200, dispute, f"RESOLVED; outcome {outcome}"
            if time.monotonic() >= deadline:
                return 0, dispute, f"timed out after 20 minutes; last status {status}"
            time.sleep(20)

    return run_step(rows, f"PayPal resolves {did}", f"GET /v1/customer/disputes/{did} (20s poll, max 20m)", poll,
                    lambda c, r, _d: c == 200 and r.get("status") == "RESOLVED")


def save_report(rows, video_outputs=None):
    os.makedirs(E2E_OUT, exist_ok=True)
    lines = ["# Hosted desk end to end report", "", f"Generated: {datetime.datetime.now().astimezone().isoformat()}", "",
             report_table(rows)]
    for i, video_output in enumerate(video_outputs or [], 1):
        lines.extend(["", f"## Browser output {i}", "", "```text", video_output.replace("```", "'''"), "```"])
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def videos_from_output(output):
    return re.findall(r"^video:\s*(.+?)\s*$", output or "", flags=re.MULTILINE)


def make_contact_sheets(rows, videos):
    all_ok = True
    ordered = sorted(dict.fromkeys(videos), key=lambda path: os.path.getmtime(path) if os.path.isfile(path) else 0,
                     reverse=True)
    if not ordered:
        skip_step(rows, "Create contact sheets", "ffmpeg per recorded video", "no video was recorded by this run")
        return True
    os.makedirs(E2E_OUT, exist_ok=True)
    for source in ordered:
        target = os.path.join(E2E_OUT, "contact-" + os.path.basename(source).rsplit(".", 1)[0] + ".png")

        def create(source=source, target=target):
            proc = subprocess.run(["ffmpeg", "-y", "-i", source, "-vf", "fps=1/2,scale=480:-1,tile=4x5",
                                   "-frames:v", "1", target], capture_output=True, text=True, check=False)
            size = os.path.getsize(target) if os.path.isfile(target) else 0
            return proc.returncode, {}, f"{os.path.basename(target)}; {size} bytes"

        ok, _ = run_step(rows, f"Contact sheet for {os.path.basename(source)}", "ffmpeg fps=1/2 scale=480 wide tile=4x5",
                         create, lambda c, _r, _d, target=target: c == 0 and os.path.isfile(target))
        all_ok = all_ok and ok
    return all_ok


def refund_recorded(capture):
    if capture.get("status") == "REFUNDED":
        return True
    breakdown = capture.get("seller_receivable_breakdown") or {}
    refund = breakdown.get("refund")
    if isinstance(refund, dict):
        try:
            if float(refund.get("value") or "0") > 0:
                return True
        except (TypeError, ValueError):
            pass
    return bool(capture.get("refunds"))


def run():
    rows, browser_outputs, videos, failures = [], [], [], []

    def step(*args, **kwargs):
        ok, result = run_step(rows, *args, **kwargs)
        if not ok:
            failures.append(args[0])
        return ok, result

    owner_ok, key = step("Load owner key", "Read local owner key file",
                         lambda: ("LOCAL", owner_key(), "owner key loaded; value withheld"),
                         lambda c, r, _d: c == "LOCAL" and bool(r))
    token_ok, token = step("PayPal authentication", "POST /v1/oauth2/token", token_step,
                           lambda c, r, _d: c == 200 and bool(r))

    # Path A: a real buyer inquiry, accepted in the browser, then checked for resolution and refund.
    a_ok, did_a = step("Create $6.00 buyer inquiry", 'pool.one("accept", "6.00", ..., custom_prefix="dd-e2e", add_to_pool=False)',
                       lambda: (200, pool.one("accept", "6.00", "Kiln log template, digital download",
                                              custom_prefix="dd-e2e", add_to_pool=False), "buyer inquiry created"),
                       lambda c, r, _d: c == 200 and bool(r))
    if a_ok:
        a_desk, _ = wait_for_desk(rows, did_a)
        if not a_desk:
            failures.append("Desk sees path A inquiry")
        a_browser, browser = step("Browser judge path A", f"judge_run.mjs --case {did_a} --owner --video --kind accept",
                                  lambda: browser_run(did_a), lambda c, _r, _d: c == 0)
        output = browser.get("output", "")
        browser_outputs.append(output)
        videos.extend(videos_from_output(output))
        if token_ok and a_browser:
            resolved_a, dispute_a = wait_resolved(rows, did_a, token)
            if not resolved_a:
                failures.append("Path A resolves")
            transactions = dispute_a.get("disputed_transactions") or [{}]
            cap_id = next((tx.get("seller_transaction_id") for tx in transactions
                           if tx.get("seller_transaction_id")), None)
            if not cap_id:
                state = day_one.load_state()
                custom = (state.get("disputes") or {}).get(did_a, {}).get("custom")
                cap_id = (state.get("orders") or {}).get(custom, {}).get("capture_id") if custom else None
            if cap_id:
                cap_ok, cap = step("Path A capture status and refund", f"GET /v2/payments/captures/{cap_id}",
                                   lambda: paypal_request("GET", f"/v2/payments/captures/{cap_id}", token),
                                   lambda c, _r, _d: c == 200)
                if cap_ok:
                    good_refund = refund_recorded(cap)
                    step("Path A refund confirmed", "capture status REFUNDED or refund recorded",
                         lambda: (200, {}, f"capture {cap.get('status')}; refund recorded {good_refund}"),
                         lambda c, _r, _d: c == 200 and good_refund)
            else:
                failures.append("Path A capture id available")
                skip_step(rows, "Path A capture status and refund", "GET capture by seller_transaction_id",
                          "PayPal response did not include a disputed capture id")
        else:
            skip_step(rows, "Path A resolve and refund", f"GET /v1/customer/disputes/{did_a}",
                      "browser filing or PayPal authentication failed")
    else:
        skip_step(rows, "Path A desk, browser, resolve, refund", "buyer inquiry flow", "inquiry creation failed")

    # Path B: scripted card chargeback. Its delayed state is evidence, not a success criterion.
    tag_b = make_tag()
    sold_b_ok, sold_b = step("Path B card sale $6.00", f"card_sale(6.00, {tag_b})",
                             lambda: (lambda c: (chargeback_probe.LAST_HTTP, c,
                                                 f"capture {c.get('id')} status {c.get('status')}"))(
                                 chargeback_probe.card_sale("6.00", tag_b)), successful)
    did_b = None
    b_filed = False
    if sold_b_ok:
        b_charge_ok, did_b = step("Path B open 13.1 chargeback", "POST /v2/customer-support/process-chargeback reason 13.1",
                                  lambda: (lambda did: (chargeback_probe.LAST_HTTP, did, f"dispute {did}"))(
                                      chargeback_probe.open_chargeback(sold_b, "6.00", "13.1")), successful)
        if b_charge_ok:
            b_desk, _ = wait_for_desk(rows, did_b)
            if not b_desk:
                failures.append("Path B reaches desk")
            step("Path B webhook event proof", "GET /api/feed", lambda: feed_has_created(did_b),
                 lambda c, r, _d: c == 200 and r.get("found"))
            b_browser, browser = step("Browser judge path B", f"judge_run.mjs --case {did_b} --owner --video --kind accept",
                                      lambda: browser_run(did_b), lambda c, _r, _d: c == 0)
            output = browser.get("output", "")
            browser_outputs.append(output)
            videos.extend(videos_from_output(output))
            b_filed = b_browser
            if b_browser and token_ok:
                b_observation_ok, pp_b = step(
                    "Path B PayPal status and links after 3 minutes",
                    f"GET /v1/customer/disputes/{did_b} at +3m",
                    path_b_observation(token, did_b), lambda c, _r, _d: c == 200)
                if b_observation_ok and "adjudicate" in link_rels(pp_b):
                    step("Path B accepted chargeback offers adjudicate link",
                         "Measured from the 3-minute PayPal dispute response; no call",
                         lambda: (200, {}, "PayPal offered adjudicate on the accepted chargeback"),
                         lambda c, _r, _d: c == 200)
            else:
                skip_step(rows, "Path B PayPal status and links after 3 minutes",
                          f"GET /v1/customer/disputes/{did_b} at +3m", "browser filing or PayPal authentication failed")
        else:
            skip_step(rows, "Path B desk, browser, 3-minute observation", "chargeback flow", "chargeback creation failed")
    else:
        skip_step(rows, "Path B chargeback, desk, browser, 3-minute observation", "chargeback flow", "card sale failed")

    # Bad paths are individual checks and do not prevent later checks from running.
    repeat_id = did_a if a_ok and 'a_browser' in locals() and a_browser else did_b if b_filed else None
    if owner_ok and repeat_id:
        step("Repeat approve returns 409", f"POST /api/disputes/{repeat_id}/approve",
             lambda: desk_request("POST", f"/api/disputes/{repeat_id}/approve", {"version": desk_request("GET", f"/api/disputes/{repeat_id}")[1].get("data", {}).get("run", {}).get("version")}, key), code_is(409))
    else:
        skip_step(rows, "Repeat approve returns 409", "POST /api/disputes/<filed-case>/approve",
                  "neither path produced a filed case and owner key")

    fresh_ua = "DisputeDeskE2E/" + secrets.token_hex(3)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    visitor_ok, _ = step("Fresh visitor established", "GET /api/me with fresh visitor user agent",
                         lambda: desk_request("GET", "/api/me", user_agent=fresh_ua, opener=opener), code_is(200))
    if visitor_ok and repeat_id:
        step("Ownerless approve denied", f"POST /api/disputes/{repeat_id}/approve no owner key",
             lambda: desk_request("POST", f"/api/disputes/{repeat_id}/approve", {}, user_agent=fresh_ua, opener=opener), code_is(403))
    else:
        skip_step(rows, "Ownerless approve denied", "POST /api/disputes/<case>/approve no owner key",
                  "fresh visitor or filed case unavailable")
    bad_headers = {"paypal-transmission-id": "fake", "paypal-transmission-time": "2026-01-01T00:00:00Z",
                   "paypal-cert-url": "https://example.invalid/cert", "paypal-auth-algo": "SHA256withRSA",
                   "paypal-transmission-sig": "fake"}
    step("Made up webhook rejected", "POST /webhooks/paypal fake event and signature headers",
         lambda: desk_request("POST", "/webhooks/paypal", {"id": "E2E-FAKE", "event_type": "CUSTOMER.DISPUTE.CREATED",
                                                              "resource": {"dispute_id": "PP-E2E-FAKE"}},
                              extra_headers=bad_headers), code_is(400))
    if owner_ok:
        step("Unknown dispute analysis is 404", "POST /api/disputes/PP-R-NOPE-1/analyse",
             lambda: desk_request("POST", "/api/disputes/PP-R-NOPE-1/analyse", {}, key), code_is(404))
    else:
        skip_step(rows, "Unknown dispute analysis is 404", "POST /api/disputes/PP-R-NOPE-1/analyse", "owner key unavailable")

    # Keep the existing C2 offer/refusal checks; each dependency failure is recorded and later checks continue.
    tag_c = make_tag()
    c_sale_ok, sold_c = step("Bad path card sale $12.00", f"card_sale(12.00, {tag_c})",
                             lambda: (lambda c: (chargeback_probe.LAST_HTTP, c,
                                                 f"capture {c.get('id')} status {c.get('status')}"))(
                                 chargeback_probe.card_sale("12.00", tag_c)), successful)
    did_c = None
    if c_sale_ok:
        c_charge_ok, did_c = step("Open C2 not as described chargeback", "POST /v2/customer-support/process-chargeback reason C2",
                                  lambda: (lambda did: (chargeback_probe.LAST_HTTP, did, f"dispute {did}"))(
                                      chargeback_probe.open_chargeback(sold_c, "12.00", "C2")), successful)
        if c_charge_ok:
            c_desk, _ = wait_for_desk(rows, did_c)
            if not c_desk:
                failures.append("C2 reaches desk")
            if token_ok:
                c_pp_ok, pp_c = step("Read C2 action links", f"GET /v1/customer/disputes/{did_c}",
                                     lambda: paypal_read_detail(token, did_c), code_is(200))
            else:
                c_pp_ok = False
                pp_c = {}
                skip_step(rows, "Read C2 action links", f"GET /v1/customer/disputes/{did_c}", "PayPal authentication failed")
            if owner_ok and c_desk:
                c_an_ok, analysis = step("Analyse C2 as owner", f"POST /api/disputes/{did_c}/analyse",
                                         lambda: desk_request("POST", f"/api/disputes/{did_c}/analyse", {}, key), code_is(200))
            else:
                c_an_ok = False
                analysis = {}
                skip_step(rows, "Analyse C2 as owner", f"POST /api/disputes/{did_c}/analyse", "owner key or desk case unavailable")
            if c_pp_ok and c_an_ok:
                decision = (analysis.get("run") or {}).get("decision") or {}
                verdict = decision.get("verdict", "unknown")
                links = link_rels(pp_c)
                offer_amount = decision.get("offerAmount")
                if c2_offer_expected(verdict, offer_amount, links):
                    step("OFFER without PayPal make_offer refused", f"POST /api/disputes/{did_c}/approve",
                         lambda: desk_request("POST", f"/api/disputes/{did_c}/approve", {"version": (analysis.get("run") or {}).get("version")}, key), code_is(422))

                    def verify_no_filing():
                        code, after = paypal_request("GET", f"/v1/customer/disputes/{did_c}", token)
                        unchanged = (code == 200 and after.get("status") == pp_c.get("status")
                                     and after.get("dispute_life_cycle_stage") == pp_c.get("dispute_life_cycle_stage")
                                     and link_rels(after) == link_rels(pp_c))
                        detail = f"status {after.get('status')}; stage {after.get('dispute_life_cycle_stage')}; links {sorted(link_rels(after))}; unchanged {unchanged}"
                        return code, after, detail

                    step("PayPal shows no C2 filing", f"GET /v1/customer/disputes/{did_c} after refusal",
                         verify_no_filing, lambda c, _r, d: c == 200 and "unchanged True" in d)
                else:
                    step("C2 verdict recorded", "analysis verdict and PayPal links",
                         lambda: (200, {}, f"verdict {verdict}; offer {offer_amount}; PayPal links {sorted(links)}"),
                         lambda _c, _r, _d: False)
        else:
            skip_step(rows, "C2 desk, links, and offer checks", "C2 dispute flow", "chargeback creation failed")
    else:
        skip_step(rows, "C2 chargeback, desk, links, and offer checks", "C2 dispute flow", "card sale failed")

    if not make_contact_sheets(rows, videos):
        failures.append("contact sheets")
    save_report(rows, browser_outputs)
    print("Step order:", step_order(bool(a_ok and 'a_browser' in locals() and a_browser), b_filed), flush=True)
    if failures:
        print("FAILED STEPS: " + ", ".join(failures), flush=True)
        return 1
    return 0


def main():
    try:
        return run()
    except Exception as exc:
        print(f"FAILED STEP: setup/run ({type(exc).__name__}: {exc})", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
