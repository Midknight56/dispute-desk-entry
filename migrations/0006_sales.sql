-- Captured sales, before any dispute.
CREATE TABLE IF NOT EXISTS sales (
  capture_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  custom_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  added_at TEXT NOT NULL
);
