-- Judge mode: sandbox disputes opened ahead of time, one handed to each judge.
CREATE TABLE IF NOT EXISTS pool (
  dispute_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  handed_to TEXT,
  handed_at TEXT,
  added_at TEXT NOT NULL
);
