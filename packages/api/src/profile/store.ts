/**
 * Workspace profile store (MIN-1122): foundation for DB-backed personalization.
 *
 * Storage: `workspace_profile` DB table (migration 014), keyed by workspace_id.
 * One row per workspace (single-workspace local v1) — a workspace-LOCAL config
 * table, like cloud_config. This is NOT wired into the sync apply/wire
 * protocol here; that materialization (using last_event_clock/last_event_seq
 * for LWW tiebreak) is a separate ticket (MIN-1123).
 */

import { pool, WORKSPACE_ID } from '../db.js';
import { recordEvent, withSyncTxn } from '../sync/events.js';

export interface WorkspaceProfile {
  ownerName: string | null;
  ownerEmails: string[];
  ownerAliases: string[];
  interests: string[];
  primaryNetwork: string | null;
  importRecipes: Record<string, unknown>[];
  journalSkipPhrases: string[];
  metadata: Record<string, unknown>;
  lastEventClock: string | null;
  lastEventSeq: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Partial patch accepted by updateProfile — omitted fields are left unchanged. */
export interface WorkspaceProfilePatch {
  ownerName?: string | null;
  ownerEmails?: string[];
  ownerAliases?: string[];
  interests?: string[];
  primaryNetwork?: string | null;
  importRecipes?: Record<string, unknown>[];
  journalSkipPhrases?: string[];
  metadata?: Record<string, unknown>;
}

type WorkspaceProfileRow = {
  owner_name: string | null;
  owner_emails: string[];
  owner_aliases: string[];
  interests: string[];
  primary_network: string | null;
  import_recipes: Record<string, unknown>[];
  journal_skip_phrases: string[];
  metadata: Record<string, unknown>;
  last_event_clock: string | null;
  last_event_seq: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: WorkspaceProfileRow): WorkspaceProfile {
  return {
    ownerName: row.owner_name,
    ownerEmails: row.owner_emails,
    ownerAliases: row.owner_aliases,
    interests: row.interests,
    primaryNetwork: row.primary_network,
    importRecipes: row.import_recipes,
    journalSkipPhrases: row.journal_skip_phrases,
    metadata: row.metadata,
    lastEventClock: row.last_event_clock,
    lastEventSeq: row.last_event_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The empty profile returned when no row exists yet for this workspace. */
function defaultProfile(): WorkspaceProfile {
  return {
    ownerName: null,
    ownerEmails: [],
    ownerAliases: [],
    interests: [],
    primaryNetwork: null,
    importRecipes: [],
    journalSkipPhrases: [],
    metadata: {},
    lastEventClock: null,
    lastEventSeq: null,
    createdAt: null,
    updatedAt: null,
  };
}

/** Return the workspace profile, or a default empty profile if none exists yet. Never null. */
export async function getProfile(): Promise<WorkspaceProfile> {
  const { rows } = await pool.query<WorkspaceProfileRow>(
    `SELECT owner_name, owner_emails, owner_aliases, interests, primary_network,
            import_recipes, journal_skip_phrases, metadata,
            last_event_clock, last_event_seq, created_at, updated_at
       FROM workspace_profile WHERE workspace_id = $1`,
    [WORKSPACE_ID],
  );
  if (rows.length === 0) return defaultProfile();
  return mapRow(rows[0]!);
}

/**
 * Apply a partial update to the workspace profile, creating the row if absent.
 * Fields omitted from the patch keep their existing value (or default, on
 * first create). Records a `profile.updated` sync event with the full updated
 * row in the same transaction as the write.
 */
export async function updateProfile(patch: WorkspaceProfilePatch): Promise<WorkspaceProfile> {
  // Distinguish explicit-null (clear the column) from omitted (keep existing) for
  // the nullable scalar columns. The `... in patch` check is honest because the
  // route/tool forward only the keys the caller actually provided. The jsonb/array
  // columns can't be "cleared to null" (they default to []/{}); passing [] clears them.
  const ownerNameProvided = 'ownerName' in patch;
  const primaryNetworkProvided = 'primaryNetwork' in patch;
  return withSyncTxn(async (client) => {
    const result = await client.query<WorkspaceProfileRow>(
      `INSERT INTO workspace_profile
         (workspace_id, owner_name, owner_emails, owner_aliases, interests,
          primary_network, import_recipes, journal_skip_phrases, metadata, updated_at)
       VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::jsonb, '[]'::jsonb),
               COALESCE($5::jsonb, '[]'::jsonb), $6, COALESCE($7::jsonb, '[]'::jsonb),
               COALESCE($8::jsonb, '[]'::jsonb), COALESCE($9::jsonb, '{}'::jsonb), now())
       ON CONFLICT (workspace_id) DO UPDATE
         SET owner_name           = CASE WHEN $10::boolean THEN $2 ELSE workspace_profile.owner_name END,
             owner_emails         = COALESCE($3::jsonb, workspace_profile.owner_emails),
             owner_aliases        = COALESCE($4::jsonb, workspace_profile.owner_aliases),
             interests            = COALESCE($5::jsonb, workspace_profile.interests),
             primary_network      = CASE WHEN $11::boolean THEN $6 ELSE workspace_profile.primary_network END,
             import_recipes       = COALESCE($7::jsonb, workspace_profile.import_recipes),
             journal_skip_phrases = COALESCE($8::jsonb, workspace_profile.journal_skip_phrases),
             metadata             = COALESCE($9::jsonb, workspace_profile.metadata),
             updated_at           = now()
       RETURNING owner_name, owner_emails, owner_aliases, interests, primary_network,
                 import_recipes, journal_skip_phrases, metadata,
                 last_event_clock, last_event_seq, created_at, updated_at`,
      [
        WORKSPACE_ID,
        patch.ownerName ?? null,
        patch.ownerEmails !== undefined ? JSON.stringify(patch.ownerEmails) : null,
        patch.ownerAliases !== undefined ? JSON.stringify(patch.ownerAliases) : null,
        patch.interests !== undefined ? JSON.stringify(patch.interests) : null,
        patch.primaryNetwork ?? null,
        patch.importRecipes !== undefined ? JSON.stringify(patch.importRecipes) : null,
        patch.journalSkipPhrases !== undefined ? JSON.stringify(patch.journalSkipPhrases) : null,
        patch.metadata !== undefined ? JSON.stringify(patch.metadata) : null,
        ownerNameProvided,
        primaryNetworkProvided,
      ],
    );
    const profile = mapRow(result.rows[0]!);
    const event = await recordEvent(client, {
      entityType: 'workspace_profile',
      entityId: WORKSPACE_ID,
      operation: 'profile.updated',
      payload: profile,
    });
    // LWW stamp (MIN-1122): record the ordering key of THIS local write on the row
    // so a later stale remote profile.updated (lower clock) can't clobber it in
    // applyProfile's guard. Without this the stored clock stays NULL and the guard
    // applies unconditionally, letting two devices swap+diverge permanently.
    // last_event_seq is NULL for a locally-authored write (server_seq is assigned
    // only on pull). Idempotent: re-running with the same recorded clock is a no-op.
    await client.query(
      `UPDATE workspace_profile
          SET last_event_clock = $2::bigint, last_event_seq = NULL
        WHERE workspace_id = $1`,
      [WORKSPACE_ID, event.logical_clock],
    );
    profile.lastEventClock = event.logical_clock;
    profile.lastEventSeq = null;
    return profile;
  });
}
