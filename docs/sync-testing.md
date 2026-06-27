# Sync Test Harness

End-to-end multi-device offline-sync tests that drive the **real** sync code across isolated per-device databases (MIN-939).

## How to run

```bash
npm --workspace @rollomap/api test
```

The e2e scenarios live in `packages/api/src/sync/e2e-sync.test.ts` and are automatically included in the standard test run (`find src -name '*.test.ts'`). The pretest step resets `rollomap_test` from scratch before every run.

**Prerequisite**: the Docker postgres container (`rollomap-postgres`) must be running. The harness uses the same postgres server as the rest of the test suite — the same requirement as `npm run test:reset`.

## Isolation model

Each device gets its own **separate database** (`rollomap_test_dev_{name}_{suffix}`) rather than a shared schema. This avoids `search_path` complexity and gives clean tear-down via `DROP DATABASE … WITH (FORCE)`.

| What | Approach |
|---|---|
| Database creation | `CREATE DATABASE` via a short-lived admin pool connected to `rollomap_test` |
| Migration application | All `db/migrations/*.sql` files applied in numeric order using pg simple-query protocol (multi-statement SQL, no params) |
| Device identity | `getLocalDeviceId(devicePool)` bootstraps the `local-default` device row (same as production) — each device gets a unique UUID |
| Tear-down | `device.pool.end()` then `DROP DATABASE` — always runs in a `finally` block |
| Parallel safety | A short random suffix (`crypto.randomUUID().slice(0,8)`) on every DB name prevents collisions between parallel test workers |

## Sync transfer

The production `pushEvents` / `pullEvents` functions use the singleton `pool` from `db.ts` and cannot accept a per-device pool without a cross-cutting refactor. The harness implements a **thin mirror** in `packages/api/src/sync/harness.ts → syncDevices(from, to)` that replicates every semantic step of the production path:

1. Look up the per-pair cursor in `to`'s `sync_cursor` table (keyed by `from.deviceId`)
2. `SELECT` events from `from` with `server_seq > cursor` ordered by `server_seq ASC`
3. `INSERT … ON CONFLICT (id) DO NOTHING` verbatim into `to`'s `sync_event`
4. `applyEvent(toClient, event)` for genuinely-new rows — the **real** replay path
5. Advance the per-pair cursor via `GREATEST(…)` UPSERT (never moves backward)

The only production step omitted is `assertDevicePushable` — device trust is enforced at the HTTP transport layer, not in the harness.

## Scenarios

| # | Scenario | Key assertions |
|---|---|---|
| 1 | **Offline creates converge** — A creates Alice, B creates Bob, sync both ways | Both people exist on both devices; second sync is a no-op (transferred=0); cursor monotonically advances |
| 2 | **Concurrent field assertions** — A adds email, B adds phone to same person | Multi-value union; both assertion rows preserved; `known_emails`/`known_phones` correct on both |
| 3 | **Tombstone beats stale update** — A deletes, B edits same person offline | `entity_tombstone` row on both devices; canonical row kept (compaction is separate); person.updated blocked |
| 4 | **Merge convergence** — duplicate people on A and B; A merges; sync | Source tombstoned, target survives, `person_merge` row on both; ≥2 events transferred |
| 5 | **Connector vs user-confirmed conflict** — source assertion vs user-confirmed assertion on same single-value field | Both assertion rows preserved; canonical value = user-confirmed winner; `getFieldConflicts` → `has_user_confirmed_winner=true`, `needs_review=false` |
| 6 | **Idempotency** — re-applying the same event batch | `ON CONFLICT (id) DO NOTHING` catches duplicates; transferred=0 on re-delivery; row counts identical; cursor advances to correct value |

## Harness API

```typescript
import {
  makeDevice,      // create isolated DB + apply migrations + return Device
  teardownDevice,  // end pool + DROP DATABASE
  teardownAll,     // teardownDevice for an array, swallows individual failures
  withDeviceTxn,   // BEGIN/COMMIT helper on device's own pool
  syncDevices,     // thin-mirror replication: from → to
  dumpEvents,      // print sync_event rows to stderr (failure context)
  type Device,     // { name, pool, deviceId, dbName }
} from './harness.js';
```

`Device.deviceId` is the UUID of the `local-default` device row in that device's own database. It is used as the cursor key when tracking per-pair replication progress.
