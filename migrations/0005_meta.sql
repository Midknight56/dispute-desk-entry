-- Small facts the Worker keeps, such as when the last timed sync ran.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
