ALTER TABLE events ADD COLUMN claimed_at TEXT;
CREATE INDEX IF NOT EXISTS events_pending ON events(received_at, id) WHERE processed_at IS NULL;
