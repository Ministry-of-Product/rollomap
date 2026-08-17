/**
 * Minimal HTTP client for the two REST endpoints merge_person and
 * delete_person delegate to (MIN-1136).
 *
 * WHY THIS EXISTS: the MCP server cannot import packages/api/src/sync/merge.ts
 * or sync/tombstone.ts directly — it's a separate package with its own pg pool
 * and a `rootDir: src` tsconfig with no dependency on @rollomap/api (see the
 * comment at the top of sync-events.ts, which documents this exact constraint
 * for the sync-event write path). Reversible merge (sync/merge.ts) and soft
 * delete / tombstoning (sync/tombstone.ts) are single-sourced in the API
 * package; this client calls the already-live REST endpoints that wrap them
 * (POST /api/people/merge, DELETE /api/people/:id) rather than duplicating
 * that logic here. Do NOT add raw SQL in this package that performs a merge
 * or a tombstone — go through these endpoints instead.
 *
 * NEW RUNTIME DEPENDENCY: merge_person and delete_person require the REST API
 * to be reachable at API_BASE_URL. Every other MCP tool talks to Postgres
 * directly and has no such dependency — if the API process isn't running,
 * only these two tools fail (with the clear error below), not the rest of
 * the server. See README.md's "MCP server" section and scripts/launch-mcp.sh,
 * which both export a default for this env var.
 *
 * Uses the global `fetch` (Node >=20 per the repo's engines field) — no new
 * npm dependency.
 */
import './env.js';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiClientError extends Error {}

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ApiClientError(
      `Could not reach the RolloMap API at ${url} (${cause}). merge_person and delete_person require the REST API to be running — start it (e.g. \`npm run dev:api\`) or point API_BASE_URL at wherever it's listening.`,
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : text || res.statusText;
    throw new ApiClientError(`RolloMap API ${method} ${path} failed (${res.status}): ${detail}`);
  }

  return parsed as T;
}

/** POST /api/people/merge — see packages/api/src/routes/people.ts:330. */
export function mergePeopleViaApi(
  targetId: string,
  sourceId: string,
): Promise<{ ok: true; merge_id: string }> {
  return apiRequest('POST', '/api/people/merge', { target_id: targetId, source_id: sourceId });
}

/** DELETE /api/people/:id — see packages/api/src/routes/people.ts:254. */
export function deletePersonViaApi(personId: string): Promise<{ deleted: number }> {
  return apiRequest('DELETE', `/api/people/${personId}`);
}
