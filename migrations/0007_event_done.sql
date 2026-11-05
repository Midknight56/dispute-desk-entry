ALTER TABLE events ADD COLUMN processed_at TEXT;
UPDATE events SET processed_at = received_at WHERE processed_at IS NULL;
