-- The seller's own shipping record, kept by the desk. It goes onto PayPal when the desk files evidence: a sale that
-- already has a tracker on PayPal sends the buyer straight to a PayPal claim (seen 22 Oct, see the README).
CREATE TABLE IF NOT EXISTS shipments (
  custom_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  delivered_at TEXT,
  tracker_id TEXT,
  created_at TEXT NOT NULL
);
