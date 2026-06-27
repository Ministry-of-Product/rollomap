-- Source connector lifecycle columns (MIN-937).
--
-- Extends source_connection with health / error columns needed by the control
-- model.  All ADDs are idempotent (IF NOT EXISTS).
--
-- Status vocabulary (enforced by application code, not a CHECK constraint so
-- future adapters can extend it without a migration):
--
--   active       — connection is live; imports proceed normally.
--   paused       — user suspended the feed; imports blocked (409).
--   disconnected — user terminated the connection; imports blocked (409);
--                  re-connection requires a new POST /connections call.
--   error        — last sync attempt failed; details in last_error.
--
-- last_sync_status records the outcome of the most recent sync attempt
-- ('ok' | 'error') independent of the lifecycle status column so a paused
-- connection that had an error before being paused can still show its error.

ALTER TABLE source_connection ADD COLUMN IF NOT EXISTS last_error       TEXT;
ALTER TABLE source_connection ADD COLUMN IF NOT EXISTS last_sync_status TEXT;
