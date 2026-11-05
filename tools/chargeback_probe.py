r"""Open a sandbox card chargeback through PayPal's sandbox test endpoint.

Usage: python tools/chargeback_probe.py [--amount 8.00] [--reason C2]
"""
import datetime
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import day_one  # noqa: E402

TEST_CARD = {"number": "4111111111111111", "expiry": "2030-12", "security_code": "123", "name": "Test Buyer"}
LAST_HTTP = 0


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def card_sale(amount, tag, description="Ceramic spoon rest"):
    """Create and capture a sandbox card order; return its capture object."""
    global LAST_HTTP
    t = day_one.tok()
    body = {"intent": "CAPTURE",
            "purchase_units": [{"custom_id": tag, "description": description,
                                "amount": {"currency_code": "USD", "value": str(amount)}}],
            "payment_source": {"card": TEST_CARD}}
    code, order = day_one.http("POST", "/v2/checkout/orders", t, body)
    LAST_HTTP = code
    day_one.receipt("CB", f"POST /v2/checkout/orders card ({tag})", code,
                    f"order {order.get('id')} status {order.get('status')}" if code in (200, 201) else day_one.err_name(order)
                    + " " + json.dumps(order.get("details", []))[:300])
    if code not in (200, 201):
        raise RuntimeError(f"card order failed HTTP {code}")
    if order.get("status") == "COMPLETED":
        capture = order["purchase_units"][0]["payments"]["captures"][0]
        LAST_HTTP = code
    else:
        code, cap = day_one.http("POST", f"/v2/checkout/orders/{order['id']}/capture", t, {})
        day_one.receipt("CB", "POST /v2/checkout/orders/{id}/capture", code,
                        f"status {cap.get('status')}" if code in (200, 201) else day_one.err_name(cap)
                        + " " + json.dumps(cap.get("details", []))[:300])
        if code not in (200, 201):
            raise RuntimeError(f"capture failed HTTP {code}")
        capture = cap["purchase_units"][0]["payments"]["captures"][0]
        LAST_HTTP = code
    print("capture", capture.get("id"), "status", capture.get("status"))
    return dict(capture, order_id=order["id"])


def open_chargeback(capture, amount, reason):
    """Open a sandbox chargeback for a capture and return the PayPal dispute id."""
    global LAST_HTTP
    cid = capture.get("id") if isinstance(capture, dict) else str(capture)
    t = day_one.tok()
    code, full = day_one.http("GET", f"/v2/payments/captures/{cid}", t)
    LAST_HTTP = code
    if code != 200:
        day_one.receipt("CB", f"GET /v2/payments/captures/{cid}", code, day_one.err_name(full))
        raise RuntimeError(f"capture lookup failed HTTP {code}")
    merchant = (full.get("payee") or {}).get("merchant_id")
    now = datetime.datetime.now(datetime.timezone.utc)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")  # noqa: E731
    cb = {"adjacency": "PAYPAL", "file_layout": "ATCK_CB", "merchant_id": merchant,
          "financial_institution": {"processor": "FDMS"},
          "transaction": {"id_enc": cid, "amount": {"currency_code": "USD", "value": str(amount)}},
          "instrument": {"instrument_type": "CARD", "card_brand": "VISA",
                         "credit_card_transaction_id": str(uuid.uuid4().int)[:16], "external": False},
          "dispute": {"id": None, "stage": "CHARGEBACK", "response_date": iso(now + datetime.timedelta(days=10)),
                      "status": "2", "amount": {"currency_code": "USD", "value": str(amount)},
                      "receive_date": iso(now), "event_code": "CHARGEBACK_INITIATED", "money_movement_date": iso(now),
                      "event_type": "DEBIT", "chargeback_type": "REPORTED_TO_PROCESSOR",
                      "processor_info": {"reference_number": str(uuid.uuid4().int)[:23], "reason_code": reason,
                                         "notes": "TEST_MEMO"}}}
    code, j = day_one.http("POST", "/v2/customer-support/process-chargeback", t, cb)
    LAST_HTTP = code
    did = j.get("dispute_id")
    day_one.receipt("CB", f"POST /v2/customer-support/process-chargeback reason {reason}", code,
                    f"dispute {did}" if did else day_one.err_name(j) + " " + json.dumps(j)[:300])
    if not did:
        raise RuntimeError(f"chargeback failed HTTP {code}")
    return did


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return
    amount, reason = arg("--amount", "8.00"), arg("--reason", "C2")
    tag = "dd-cb" + uuid.uuid4().hex[:6]
    capture = card_sale(amount, tag)
    did = open_chargeback(capture, amount, reason)
    t = day_one.tok()
    for i in range(20):
        code, d = day_one.http("GET", f"/v1/customer/disputes/{did}", t)
        if code == 200:
            links = [l.get("rel") for l in d.get("links", [])]
            print(f"after {i * 15} s: {d.get('status')} {d.get('dispute_life_cycle_stage')} {d.get('reason')} links {links}")
            if d.get("status") not in (None, "UNDER_REVIEW"):
                day_one.receipt("CB", "GET /v1/customer/disputes/{id}", code,
                                f"{d.get('status')} {d.get('dispute_life_cycle_stage')} {d.get('reason')}, links {links}")
                return
        else:
            print(f"after {i * 15} s: GET {code}")
        time.sleep(15)


if __name__ == "__main__":
    main()
