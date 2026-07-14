# Sync Field Coverage — what replicates across devices, and what doesn't

## TL;DR

RolloMap cloud sync is **event-sourced**: a change replicates to other devices
**only if a route records a pushable sync-event for it**. That single rule
explains every gap below. A change fails to replicate for one of two reasons:

1. **The entity is local-only** — its operations are marked `pushable: false`
   (or record no event at all), so they never leave this machine.
2. **The operation has no local op** — the entity syncs on *create*, but its
   *edit* / *delete* path records nothing, so later changes stay local.

See also: [`sync-conflict-policy.md`](sync-conflict-policy.md) (how conflicting
field values are resolved) and [`contact-sharing.md`](contact-sharing.md) (the
separate out-of-band group snapshot model).

## How the pipeline decides

```
write route  ──►  recordEvent(sync_event)  ──►  pushOnce scans sync_event
                    (same DB txn)                 │
                                                   ├─ isPushable(op)? ──no──►  skipped (local-only)
                                                   └─ yes ──► toWireEnvelope ──► POST /sync/push ──► peers pull
```

- **`recordEvent`** (`sync/events.ts`) appends to the local `sync_event` log in
  the *same transaction* as the data change.
- **`OP_TABLE`** (`sync/wire.ts`) is the single source of truth for which local
  ops are pushable and how each maps to the wire protocol.
- Pulled events are applied via `applyEvent` **without** re-recording (anti-echo),
  so a pure replica has an empty push log — that is normal, not a fault.

---

## ✅ What syncs

### Person — `person.created`, `person.updated` (+ per-field `assertion.added`)

Each field also gets a provenance assertion; the merge column is how concurrent
edits on different devices are reconciled (see `sync-conflict-policy.md`).

| Field | Merge behavior |
|---|---|
| `display_name` | primary-preserving |
| `primary_email` | primary-preserving |
| `company` | primary-preserving |
| `title` | primary-preserving |
| `linkedin_url` | primary-preserving |
| `summary` | primary-preserving |
| `how_known` | last-writer-wins |
| `user_pinned` | last-writer-wins |
| `aliases` | union (multi-value) |
| `known_emails` | union (multi-value) |
| `known_phones` | union (multi-value) |

Person **delete** (`person.deleted`) and **merge** (`person.merged`) also replicate.

### Other entities

| Entity | Op | Fields that replicate |
|---|---|---|
| Identity | `identity.added` | `identity_type`→`kind`, `identity_value`→`value`, `confidence`, `verified_by_user` |
| Topic | `topic.created` | `name`, `aliases`, `description`, `parent_topic_id` |
| Person↔Topic link | `topic.linked` | `topic_id`, `confidence`, `user_confirmed` |
| Note | `note.created`, `note.archived` | `body`, `kind`, `person_id`, `archived_at` (soft-archive; `note.archived`→wire `note.deleted`) |
| Interaction | `interaction.created` | `title`, `summary`, `body`, `occurred_at`, `topics`, `sensitivity_level`, `confidence`, `interaction_type`→`channel`, `participant_ids`→`participants` |
| Workspace profile | `profile.updated` | `owner_name`, `owner_emails`, `owner_aliases`, `interests`, `primary_network`, `import_recipes`, `journal_skip_phrases`, `metadata` |

---

## ⚠️ What does NOT sync

### Derived / local person columns (recomputed per device, never authoritative-synced)

`first_seen_at`, `last_seen_at`, `interaction_count`, `relationship_strength`,
`confidence`, `last_researched_at`, `tsv` (search index), and `sensitivity_level`
(not part of the managed assertable field set).

These are recomputed locally from the synced underlying data, so they converge
indirectly — but the column values themselves are not replicated.

### Entities that are local-only (never leave this machine)

| Entity / op | Why | Source |
|---|---|---|
| **Commitments / open loops** | Route records **no** sync event at all | `routes/commitments.ts` |
| **Contact groups** (`group.*`) | Marked local-only; shared out-of-band | `sync/wire.ts` |
| **Source connections** (`connection.*`), **source removal** (`source.removed`) | Per-device local connector state | `sync/wire.ts` |
| **Source items** (raw ingest artifacts) | Local; a synced row's `source_item_id` FK **won't resolve** on peers | — |
| Merge-undo (`person.merge_reversed`), `person.teleported` | Recorded but not pushable | `sync/wire.ts` |
| `device`, `evidence`, `user_correction`, `audit_log`, `cloud_config`, `cloud_sync_state` | Infrastructure / per-device | — |

### Operations that don't sync *even on synced entities* (create-only)

There is a local op for **create** (and, for people, update) but **not** for
later edits/deletes, so these silently stay local:

- **Editing or deleting an interaction** (`interaction.updated` / `interaction.deleted`)
- **Removing an identity** (`identity.removed`)
- **Unlinking a topic** (`topic.unlinked`)

> A *new* interaction/identity/topic-link replicates; **changing or removing
> one afterward does not.** Two exceptions: person edits (`person.updated`) sync,
> and note archival (`note.archived`) syncs — notes are immutable + archivable, so
> there is no note-edit case at all (see gap #1 below, now implemented).

---

## 🔧 Known gaps & proposed changes

These are rough edges where current behavior is likely to confuse users. Not yet
implemented — captured here so the design intent is on record.

### 1. Notes are immutable + archivable ✅ IMPLEMENTED (migration 015)

Notes have no edit endpoint (already append-only). "Deleting" a note now
**soft-archives** it (`note.archived_at`) instead of hard-deleting the row — the
old `DELETE` recorded no sync event and lost the row locally. The archive records
a `note.archived` local op that maps to the existing `note.deleted` wire
tombstone, so **it replicates within the existing protocol — no wire-contract
change**. `applyEvent` replays it as a soft-archive (never a hard delete). Reads
(`GET /notes`, person profile, MCP briefs, search, stats) exclude archived notes
by default; `GET /notes?include_archived=1` returns them. Backfill preserves an
already-archived note's state so a fresh backfill won't resurrect it on peers.

> **Remaining:** a webapp affordance to *view* archived notes / un-hide them is
> not built (the API supports `?include_archived=1`).

### 2. Contact groups should replicate across a user's own devices

**Problem:** groups are entirely local-only, so a user's own devices disagree on
their groups.

**Proposed:** treat a group like a topic — user-authored state that syncs across
*your* devices. Membership is a clean set-CRDT (union + tombstones).

**Cost:** this **is a protocol change**, not a toggle. `group` is not in the wire
entity enum, so it needs a `group` entity + ops (`group.created`, `group.renamed`,
`group.archived`, `group.member_added/removed`) on **both** client and
`rollomap_server`, with a protocol version bump. Keep two concepts distinct:
"sync my groups across my devices" (this) vs. "share a group snapshot to another
user" (the existing [`contact-sharing.md`](contact-sharing.md) feature).

### 3. Commitments don't sync at all

Open loops are arguably core relationship state, but the commitments route
records no sync event. Worth deciding whether they should replicate (they'd need
a local op + wire mapping; `commitment.*` already exists in the wire enum).
