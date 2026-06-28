# Contact-sync conflict-resolution policy (MIN-936)

When the same person is edited on two devices (or a manual edit collides with an
import), their claims can disagree. This document defines — and the code in
`packages/api/src/sync/conflict-policy.ts` centralizes — exactly how those
conflicts are reconciled. Every other module **delegates** to that file so the
policy can never drift:

| Concern                              | Implementation                                             |
| ------------------------------------ | ---------------------------------------------------------- |
| Field strategy + winner ordering     | `conflict-policy.ts` → `FIELD_RESOLUTION`, `compareAssertions`, `SINGLE_VALUE_ORDER_SQL` |
| Canonical column derivation          | `assertions.ts` `deriveCanonicalField` (delegates)         |
| "Needs review" conflict signal       | `assertions.ts` `getFieldConflicts` (delegates)            |
| Tombstone precedence                 | `apply.ts` via `tombstoneBlocksApply`                      |
| Merge redirect                       | `merge.ts` `resolvePersonRedirect`, used by all apply paths |

Underlying model (MIN-935): every field value is stored as a
`person_field_assertion` carrying its provenance (source/device), `confidence`,
and `user_confirmed`. The canonical `person.*` column is **derived** from the
live (non-superseded) assertions. Competing claims are never deleted, so a value
a device disagrees about stays queryable.

## 1. Additive multi-value fields — `union`

`known_emails`, `known_phones`, `aliases` (and, at the relationship layer,
topics and groups).

Resolution: **set-union** of every live assertion's values, case-insensitively
de-duplicated, first-seen casing preserved. Nothing is ever dropped, so there is
no conflict to resolve — two devices adding different emails simply keep both.
The union is built in a deterministic scan order (`created_at ASC, id ASC`) so
the canonical array is identical on every device.

## 2. Single-value canonical fields — `primary-preserving`

`display_name`, `primary_email`, `company`, `title`, `linkedin_url`, `summary`.

Competing assertions are **preserved** (never superseded/deleted). The canonical
column is the winner of a deterministic selector:

```
user_confirmed DESC, is_primary DESC, confidence DESC, created_at DESC, id ASC
```

- A user-confirmed/manual value is **primary** and is never clobbered by an
  import.
- Otherwise the highest-confidence, then most-recent value wins.
- **Determinism:** the trailing `id ASC` is the load-bearing tie-break. For two
  genuinely concurrent edits (equal confirmation/primary/confidence, and a tied
  or skewed `created_at` across devices) the assertion `id` — a UUID minted at
  the origin device and replicated verbatim — settles the winner **identically
  on every device, regardless of the order events are applied**. This is the
  most important correctness property and is verified by a test that applies two
  conflicting assertions in both orders and asserts the same canonical result.

When >1 **distinct** values compete and **no** assertion is user-confirmed, the
field is flagged `needs_review` (see "Surfacing conflicts" below) instead of
silently picking one. The loser is preserved and remains queryable.

## 3. Low-risk metadata — `lww` (last-write-wins)

`how_known`, `user_pinned`.

These are cheap, low-stakes, easily re-entered hints — not identity-bearing
contact data — so last-write-wins is acceptable and a stale value being
overwritten is not worth a user's attention. They use the **same deterministic
selector** (so devices still converge), but their conflicts are **not** surfaced
as `needs_review`. This is the only field set where a losing value is treated as
discardable.

## 4. Deletes/tombstones beat stale updates — `delete-wins`

A `person.created` / `person.updated` must **never** resurrect a tombstoned
person, regardless of sync apply order (`apply.ts` → `tombstoneBlocksApply`).

Ordering rationale: a tombstone is only compacted away once **every trusted
device has acked past its delete event** (`compactTombstones` /
`minTrustedAckedServerSeq`). So while the tombstone exists, the delete is the
latest known intent on the network, and any create/update that still references
the entity is — by construction — stale relative to it. We therefore compare on
*sync ordering* (acked `server_seq`) rather than wall-clock timestamps, which can
skew between devices.

## 5. Merge redirects — `merge-redirect`

When two records are merged, the **source** person is tombstoned as a redirect
and a durable `person_merge` row records it. A later update that still references
the merged-away source is redirected onto the live **target** via
`resolvePersonRedirect`, so it lands on the surviving record instead of being
lost. Every reference-bearing apply path (identity, topic, note, interaction
participant, field assertion) resolves the redirect before writing.

## Surfacing conflicts (the "needs review" signal)

`GET /api/people/:id/assertions` returns, alongside the existing `assertions`
provenance list, a computed **`conflicts`** section (no stored column). For each
`primary-preserving` field with >1 distinct live values it reports:

```jsonc
{
  "field_name": "company",
  "winner": "Acme Corp",            // the deterministic canonical value
  "has_user_confirmed_winner": false,
  "needs_review": true,             // distinct values disagree, nobody confirmed
  "competing": [                     // winner-first, with provenance
    { "assertion_id": "…", "value": "Acme Corp", "confidence": 0.9, "user_confirmed": false, "device_id": "…", "source_item_id": "…", "created_at": "…" },
    { "assertion_id": "…", "value": "Acme Inc",  "confidence": 0.6, "user_confirmed": false, "device_id": "…", "source_item_id": "…", "created_at": "…" }
  ]
}
```

`needs_review` is `false` once any competing assertion is `user_confirmed` (the
user has settled it). `lww` fields are intentionally excluded.
