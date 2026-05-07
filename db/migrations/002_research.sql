-- Track when a person was last researched (per-person research synthesis pass)
ALTER TABLE person ADD COLUMN IF NOT EXISTS last_researched_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS person_last_researched_at_idx ON person(last_researched_at);
