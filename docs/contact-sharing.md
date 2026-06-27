# Contact Sharing — Snapshot Model (MIN-938)

## TL;DR

RolloMap sharing today is **snapshot-only**: a point-in-time JSON bundle that the recipient imports into their own database as locally owned records. There is no live/real-time sharing model. Both parties fully own their copy after the exchange.

---

## Core principle: you always keep your own copy

Sharing must not make the recipient depend on the sender's database, and sharing must not surrender the sender's ownership of their data. The mechanism is:

1. **Sender** exports a bundle (JSON snapshot) from a contact group.
2. **Recipient** imports the bundle: RolloMap creates local `person` rows (or matches existing) and writes field values as assertions via the normal assertion system.
3. After import, the recipient's records are fully independent — editing a contact does not affect the sender, and the sender deleting a record does not remove it from the recipient.

---

## Bundle schema

```json
{
  "version": "1",
  "mode": "snapshot",
  "shared_by": "<free-form sharer identifier>",
  "shared_at": "<ISO 8601 timestamp>",
  "source_workspace_id": "<UUID of exporting workspace>",
  "people": [
    {
      "external_id": "<person.id in source workspace — informational only>",
      "fields": {
        "display_name": "Alice Example",
        "primary_email": "alice@example.com",
        "company": "Acme Corp",
        "title": "Engineer",
        "linkedin_url": null,
        "aliases": [],
        "known_emails": [],
        "known_phones": [],
        "how_known": "Met at 601 Club"
      },
      "topics": ["AI", "Climate Tech"]
    }
  ]
}
```

`mode: "snapshot"` is a forward-compatibility marker. If live sharing is ever added, it will use a different mode value and a different import path. A bundle parser must reject or warn on unknown modes.

`version: "1"` is the current schema version.

---

## Sensitive-field defaults

`buildBundle()` applies the following exclusions **by default**:

| What is excluded | Why | Override |
|---|---|---|
| People with `sensitivity_level != 'normal'` | Private or high-stakes contacts | `include_sensitive: true` |
| The `summary` field | May contain AI-derived or synthesized text | Include via _not_ adding it to `exclude_fields` after passing `exclude_fields: []` — actually include it explicitly by passing an empty array and NOT including 'summary' — wait, `summary` is in the DEFAULT exclusion set, so to include it pass `exclude_fields` without 'summary' and also pass a custom body without it as a default... Actually: `summary` is in `DEFAULT_EXCLUDED_FIELDS`. To include it, callers currently cannot override the default exclusion via the API body — this is a deliberate conservative default. Future: add `include_fields` to explicitly opt in. |
| Note bodies (`note.body`) | First-class private content in a separate table; never a person field | Not overridable — notes are intentionally out of scope for sharing |
| `user_pinned` | Local workspace preference; meaningless outside the source | Always excluded |

Callers may exclude additional fields via `exclude_fields: ["company", "title"]`.

---

## Import: match vs create

For each person in the bundle, `importBundle()` tries to find an existing (non-tombstoned) person in the recipient's workspace:

1. **primary_email** — exact, case-insensitive match.
2. **known_emails overlap** — each bundle email checked against the recipient's `primary_email` and `known_emails` JSONB array.
3. **display_name** — exact, case-insensitive match (first result wins if multiple).
4. **No match** — a new `person` row is created with the bundle's `display_name`.

All field values from the bundle are then written as `person_field_assertion` rows with `user_confirmed=false`, `confidence=0.8`. This means:
- An existing manually confirmed value in the recipient's workspace **always wins** (user_confirmed=true beats user_confirmed=false in the selector).
- The imported value is still queryable via the assertions API as a competing claim.
- The recipient can override any imported value with a manual edit, which writes a fresh user_confirmed assertion.

---

## Provenance

For **newly created** people (not matched), the import stamps:

- `how_known` assertion: `"Imported from share by <shared_by> on <shared_at>"` (user_confirmed=false, confidence=0.8). The user can replace this with a manual edit.
- A note (kind='note') body: `"Imported from share by <shared_by> on <shared_at>. Source workspace: <source_workspace_id>."` — permanently preserves the origin even if how_known is later edited.

For **matched** people: only the bundle field values are asserted. No how_known override or note is written, to avoid polluting existing records and to prevent note spam on re-import.

The exact `source_workspace_id` and `shared_by` are carried in both the note body and the `group.imported` sync event payload.

---

## Sync events

| Event | When emitted | Entity type |
|---|---|---|
| `group.created` | Group is created (POST /api/groups) | `contact_group` |
| `group.member_added` | Person added to a group (POST /api/groups/:id/members) | `contact_group` |
| `group.imported` | Bundle imported (POST /api/groups/import) | `contact_group` |

**`group.shared` is not emitted today.** A pure bundle export (GET/POST export endpoint) is a read-only operation that mutates no local state and produces no artifact that needs to replicate across devices. If a future "share log" table (recording outbound shares to specific recipients) is added, `group.shared` would record it. The operation name is reserved in `SYNC_OPERATIONS`.

---

## Re-import behaviour

Re-importing the same bundle is safe:

- Person matching (steps 1–3 above) prevents duplicates.
- Each re-import writes new assertion rows with fresh UUIDs (the assertion system uses `ON CONFLICT (id) DO NOTHING` and each call generates a new UUID). For identical field values, the canonical column is unchanged. For updated values, the new assertion participates in the normal conflict-resolution policy.
- Provenance notes are NOT re-written for matched people on re-import.

---

## Live sharing — future, not this

Live sharing (where two workspaces maintain a synchronised view of shared contacts) is explicitly out of scope for this implementation. Design questions that would need resolving:

- How does a permission revocation propagate?
- What happens when a contact is deleted on the source — should the recipient's copy be tombstoned?
- Does the recipient's edits flow back to the sender?

These questions are non-trivial and require a separate design. The `mode: "snapshot"` field in the bundle is the versioned marker that distinguishes today's implementation from a future live model.
