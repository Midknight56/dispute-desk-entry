-- One row per agent run, for the per visitor and per day caps.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  dispute_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  neurons REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_day ON runs(day, visitor);

-- When the desk marked a parcel delivered. PayPal's tracker keeps a status but no date.
CREATE TABLE IF NOT EXISTS delivered (
  tracker_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
