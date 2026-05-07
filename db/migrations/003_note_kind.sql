-- Distinguish manual notes from synthesized "Deep Dive" research entries.
-- Deep Dives are append-only dated synopses produced by save_person_research.
ALTER TABLE note ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'note';

DO $$ BEGIN
  ALTER TABLE note ADD CONSTRAINT note_kind_check CHECK (kind IN ('note','deep_dive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS note_person_kind_created_at_idx
  ON note(person_id, kind, created_at DESC);
