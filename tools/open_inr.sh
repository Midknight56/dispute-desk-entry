#!/usr/bin/env bash
# Open an Item Not Received dispute as the sandbox buyer on one of our saved orders, then note the time.
# Usage: bash tools/open_inr.sh <custom> <amount like 8.00> <item type: Physical product|Digital download>
# The browser step runs under the PC wide browser lock (tools/browser.sh). BUYER=2 or 3 picks another sandbox buyer.
set -e
cd "$(dirname "$0")/.."
custom="$1"; amount="$2"; kind="${3:-Physical product}"
if [ "$kind" = "Digital download" ]; then cat="Other"; else cat="Home"; fi
bash tools/browser.sh timeout -k 5 300 node tools/buyer.mjs dispute "$custom" "goto:/resolutioncenter" \
  "row:Test Store|$amount" "Report a Problem" "?Report Issue to PayPal" "?Start over" \
  "?received the item or service" "select:0=$kind" "select:1=$cat" "btn:Continue" \
  "?reached me or I refused delivery" "?btn:Continue" \
  "fillname:items.0.expected_refund|$amount" "btn:Continue" \
  "label:Yes" "Sent an email or text message" "The seller wasn" \
  "btn:Continue" \
  "fillname:notes|I wrote to the seller and it still has not come." \
  "btn:Continue" "btn:Submit" \
  | grep -E "^at |error|STOP"
python tools/day_one.py opened
