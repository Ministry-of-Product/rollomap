-- Field-level contact assertions and provenance (MIN-935).
--
-- WHY: Before this, a person's contact fields (company, title, primary_email,
-- known_emails, aliases, …) lived ONLY as canonical columns on `person`. A manual
-- edit and a connector/import both wrote the same column, so the LAST writer won
-- and the losing value (and where it came from) was lost. There was no way to:
--   * show a user where a field's value came from (manual vs which import/source);
--   * keep a user's confirmed value safe from being clobbered by a later import;
--   * preserve conflicting source values so a better policy (MIN-936) can choose.
--
-- A person_field_assertion is one CLAIM about one field of one person, with its
-- provenance (source/device), confidence, and whether the user confirmed it. The
-- canonical person.* column is now DERIVED from these assertions (see
-- packages/api/src/sync/assertions.ts deriveCanonicalField) so existing reads keep
-- working, while every competing claim stays queryable.
--
-- FK policy (mirrors person_merge / entity_tombstone, MIN-933/934):
--   * NO FK to device(id) or source_connection(id)/source_item(id): assertions may
--     be replayed from a peer whose device/source rows aren't known locally yet —
--     these refs are informational provenance, not integrity-bearing.
--   * person_id FK to person(id) ON DELETE CASCADE IS kept: an assertion is about a
--     person and should die with it. (Replayed assertions about a merged-away source
--     are redirected onto the live target before insert — see resolvePersonRedirect.)

CREATE TABLE IF NOT EXISTS person_field_assertion (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  person_id            UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  -- Canonical column name this claim targets: display_name, primary_email,
  -- company, title, linkedin_url, summary, how_known (single-value) or
  -- known_emails, known_phones, aliases (multi-value / set-union).
  field_name           TEXT NOT NULL,
  -- The claimed value, as jsonb: a scalar (string) for single-value fields, an
  -- array for multi-value fields.
  field_value          JSONB NOT NULL,
  -- Provenance (all optional / no FK — see policy above).
  source_connection_id UUID,
  source_item_id       UUID,
  device_id            UUID,
  confidence           NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  is_primary           BOOLEAN NOT NULL DEFAULT false,
  user_confirmed       BOOLEAN NOT NULL DEFAULT false,
  -- Reserved for an explicit supersede policy (MIN-936). Today the selector simply
  -- ignores superseded rows; we DON'T set it, so conflicting claims stay queryable.
  superseded_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS person_field_assertion_person_field_idx
  ON person_field_assertion (workspace_id, person_id, field_name);
