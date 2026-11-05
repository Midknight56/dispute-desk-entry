-- Webhook events by PayPal's event id: a second delivery of the same id is skipped.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  create_time TEXT,
  received_at TEXT NOT NULL,
  raw TEXT NOT NULL
);

-- The merged dispute record: dispute, order, capture, tracking, draft, verdict, as JSON.
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  status TEXT,
  stage TEXT,
  reason TEXT,
  amount TEXT,
  currency TEXT,
  due TEXT,
  custom_id TEXT,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every PayPal call and webhook the desk makes or receives, for the feed panel.
CREATE TABLE IF NOT EXISTS feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  ref TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS feed_at ON feed(at);
