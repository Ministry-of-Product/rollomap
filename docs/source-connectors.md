# Source Connectors — Design Notes

This document describes the lifecycle model, control API, provenance/removal guarantees, and adapter-design sketch for RolloMap's source connector system (implemented in MIN-937).

---

## 1. Lifecycle States

A `source_connection` moves through the following states:

```
         create
           │
           ▼
        active ──────────────────────────────────────────┐
           │                                             │
        pause()                                       disconnect()
           │                                             │
           ▼                                             │
        paused ─────────────────────────────────────────►│
           │                                             │
        resume()                                         │
           │                                             │
           └──────────────────────► active               │
                                                         ▼
                                                    disconnected
                                                (terminal; create
                                                 new connection to
                                                 reconnect)
```

| Status | Imports allowed | Can pause | Can resume | Can disconnect | Can resync |
|---|---|---|---|---|---|
| `active` | yes | yes | no (409) | yes | yes |
| `paused` | no (409) | no (409) | yes | yes | no (409) |
| `disconnected` | no (409) | no (409) | no (409) | no (409) | no (409) |
| `error` | yes | yes | no (409) | yes | yes |

The `error` status is set by an adapter when a sync attempt fails; it does not block imports (the user may have previously imported valid data). `last_error` carries the human-readable reason; `last_sync_status` carries `'ok'` or `'error'`.

---

## 2. Control Endpoints

All endpoints are mounted at `/api/sources` (router in `packages/api/src/routes/sources.ts`).

### Connections

| Method | Path | Description |
|---|---|---|
| `GET` | `/connections` | List connections with provider, status, last sync time/status/error, and traceability counts (source items, source-backed assertions). |
| `POST` | `/connections` | Create a new connection. Body: `{ provider, config? }`. Status starts `active`. Emits `connection.created`. |
| `POST` | `/connections/:id/pause` | Pause an active connection. Emits `connection.paused`. |
| `POST` | `/connections/:id/resume` | Resume a paused connection. Emits `connection.resumed`. |
| `POST` | `/connections/:id/disconnect` | Disconnect an active or paused connection (terminal). Emits `connection.disconnected`. |
| `POST` | `/connections/:id/resync` | Control-model stub: stamp `last_sync_at = now()`, `last_sync_status = 'ok'`. No real data fetch. The adapter calls this after a successful pull. |
| `POST` | `/connections/:id/remove-data` | Safely remove all source-derived data (see §3). Emits `source.removed`. |

### Import

| Method | Path | Description |
|---|---|---|
| `POST` | `/import` | Bulk-import source items. Optional `connection_id`; if provided and the connection is paused or disconnected, returns 409. |

---

## 3. Provenance and Removal Guarantees

Every `source_item` row carries a `source_connection_id` (set when `connection_id` is supplied to `POST /import`). Every `person_field_assertion` row written by an import carries the same `source_connection_id` alongside `user_confirmed = false`.

### What "remove source data" does

`POST /connections/:id/remove-data`:

1. Deletes every `source_item` where `source_connection_id = :id`.
2. Deletes every `person_field_assertion` where `source_connection_id = :id` AND `user_confirmed = false`.
3. **Never** touches `user_confirmed = true` assertions (manual edits survive).
4. **Never** deletes `person` rows (canonical contact records are permanent).
5. Re-derives the canonical `person.*` column for every `(person_id, field_name)` that lost an assertion, so canonical values fall back to remaining/manual assertions.
6. Emits a `source.removed` sync event with `{ source_items_removed, assertions_removed, persons_reprocessed }`.

### Traceability

`GET /connections` returns `source_item_count` and `source_assertion_count` per connection so users can see how much data each connector has contributed before deciding to remove it.

---

## 4. Adapter Design Sketches

Each adapter is a future implementation. This section sketches the contract for the three most likely candidates.

### 4.1 LinkedIn Adapter

**Auth**: OAuth 2.0 PKCE (LinkedIn API v2). The `config` JSONB on `source_connection` holds `{ access_token, refresh_token, token_expiry }`. Tokens are encrypted at rest (to be implemented at the credential-store layer).

**Entities produced**:
- `source_item` rows of `source_type = 'linkedin'` for each connection/profile scraped.
- `person_field_assertion` rows for `display_name`, `company`, `title`, `linkedin_url`, `primary_email` (where visible), `known_phones`.

**Sync cadence**: Pull on demand via `POST /connections/:id/resync`; the adapter would also register a background job to refresh daily. `resync` stamps `last_sync_at` and `last_sync_status` after a successful pull.

**Gaps**: LinkedIn's public API is restricted; full contact data requires a partner agreement. A scrape-based adapter could fill the gap but is outside ToS.

### 4.2 Phone Contacts Adapter (iOS / Android / macOS Contacts)

**Auth**: Local OS permission (Contacts entitlement on macOS/iOS; READ_CONTACTS on Android). No OAuth. The `config` JSONB is empty; the connection represents the local address book.

**Entities produced**:
- `source_item` rows of `source_type = 'note'` or a new `source_type = 'contact_card'`.
- `person_field_assertion` rows for `display_name`, `primary_email`, `known_emails`, `known_phones`, `company`, `title`.

**Sync cadence**: Real-time via OS change notifications, or on explicit resync. Because contacts are local, there is no token to refresh. The connection represents a single device's address book; another device's address book is a separate `source_connection`.

**Gaps**: Contacts APIs return raw phone/email arrays; RolloMap's deduplication (by `primary_email`) must handle mismatches between how the OS stores names vs. how RolloMap expects them.

### 4.3 Google Contacts Adapter

**Auth**: Google OAuth 2.0 with the `contacts.readonly` scope. The `config` JSONB holds `{ access_token, refresh_token, token_expiry, sync_token }`. The `sync_token` is used to request incremental updates from the People API.

**Entities produced**:
- `source_item` rows of `source_type = 'note'` or a new `source_type = 'contact_card'`.
- `person_field_assertion` rows for `display_name`, `primary_email`, `known_emails`, `known_phones`, `company`, `title`, `linkedin_url` (if stored in "URL" fields).

**Sync cadence**: Incremental pull using the Google People API's `syncToken` on each `POST /connections/:id/resync`. Full re-sync (with `sync_token = null`) if the token is invalidated. Cadence suggestion: on app launch + every 6 hours in background.

**Gaps**: Google People API rate-limits at 90 requests/minute per user. A page-based fetch with exponential backoff is required. `DELETE` in Google Contacts triggers a tombstone in the API (`metadata.deleted = true`); the adapter should NOT delete the RolloMap `person` row — it should only remove the source assertions and let canonical derivation fall back to other sources.

---

## 5. Implementation Status

| Capability | Status |
|---|---|
| Connection CRUD + lifecycle API | Implemented (MIN-937) |
| Import guard (blocks paused/disconnected) | Implemented (MIN-937) |
| Provenance via `source_connection_id` | Implemented (MIN-937) |
| Safe remove-data with re-derivation | Implemented (MIN-937) |
| Sync events for lifecycle actions | Implemented (MIN-937) |
| LinkedIn adapter | Future |
| Phone Contacts adapter | Future |
| Google Contacts adapter | Future |
| OAuth credential store | Future |
| Background sync scheduler | Future |
