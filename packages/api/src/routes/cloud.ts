/**
 * Cloud pairing routes (MIN-974).
 *
 *   POST /api/cloud/connect     — store token + URL, validate against server
 *   GET  /api/cloud/status      — paired? server url? last check result?
 *   POST /api/cloud/disconnect  — clear pairing config
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  getCloudConfig,
  setCloudConfig,
  clearCloudConfig,
} from '../cloud/config.js';
import { syncOnce } from '../cloud/sync-agent.js';
import { backfillSyncEvents } from '../cloud/backfill.js';

export const cloudRouter = Router();

const ConnectBody = z.object({
  sync_server_url: z.string().url(),
  device_token: z.string().min(1),
});

// POST /api/cloud/connect
// Stores the pairing config and immediately validates the token against the
// cloud server by calling GET {url}/sync/pull?since=0&limit=1.
// Returns { connected: true, head_server_seq } on success, or a clear error.
cloudRouter.post('/connect', async (req, res) => {
  let body: z.infer<typeof ConnectBody>;
  try {
    body = ConnectBody.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: 'invalid_body', detail: String(err) });
  }

  const baseUrl = body.sync_server_url.replace(/\/$/, '');

  // Validate token: GET /sync/pull?since=0&limit=1 must return 200.
  let headServerSeq: number | null = null;
  try {
    const r = await fetch(`${baseUrl}/sync/pull?since=0&limit=1`, {
      headers: { Authorization: `Bearer ${body.device_token}` },
    });

    if (r.status === 401 || r.status === 403) {
      return res.status(401).json({
        error: 'invalid_token',
        detail:
          r.status === 403
            ? 'The device has been revoked on the cloud server (403). Register a new device to re-pair.'
            : 'The device token was rejected by the cloud server (401). Check the token and try again.',
      });
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({
        error: 'server_error',
        detail: `Cloud server responded with ${r.status}: ${text}`,
      });
    }

    const data = (await r.json()) as { head_server_seq?: number };
    headServerSeq = data.head_server_seq ?? null;
  } catch (err) {
    // Network error / DNS failure / etc.
    return res.status(502).json({ error: 'unreachable', detail: String(err) });
  }

  await setCloudConfig({
    syncServerUrl: baseUrl,
    deviceToken: body.device_token,
    lastCheckAt: new Date(),
    lastCheckOk: true,
  });

  return res.json({ connected: true, head_server_seq: headServerSeq });
});

// GET /api/cloud/status
// Returns paired status and last-check metadata.
cloudRouter.get('/status', async (_req, res) => {
  const config = await getCloudConfig();
  if (!config) {
    return res.json({ paired: false });
  }
  return res.json({
    paired: true,
    sync_server_url: config.syncServerUrl,
    connected_at: config.connectedAt,
    last_check_at: config.lastCheckAt,
    last_check_ok: config.lastCheckOk,
  });
});

// POST /api/cloud/disconnect
// Clears the pairing config; subsequent sync attempts will require re-pairing.
cloudRouter.post('/disconnect', async (_req, res) => {
  await clearCloudConfig();
  return res.json({ disconnected: true });
});

// POST /api/cloud/backfill
// Emit a creation sync_event for every existing entity that pre-dates the
// sync_event log (MIN-975).  Idempotent: safe to call multiple times.  Run this
// once after pairing a client that has a pre-existing graph, then POST /sync to
// push the backfilled events to RolloMap Cloud.
cloudRouter.post('/backfill', async (_req, res) => {
  try {
    const result = await backfillSyncEvents();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'backfill_failed', detail: String(err) });
  }
});

// POST /api/cloud/sync
// On-demand full sync cycle (push local changes, then pull peers' changes).
// Returns the structured syncOnce result: counts, cursors, head_server_seq, and
// any auth error. A not-paired client is a clean no-op ({ paired: false }).
cloudRouter.post('/sync', async (_req, res) => {
  try {
    const result = await syncOnce();
    if (!result.paired) {
      return res.status(409).json({ error: 'not_paired', detail: 'Client is not paired with RolloMap Cloud — call POST /api/cloud/connect first.', ...result });
    }
    const authError = result.push.authError ?? result.pull.authError;
    if (authError) {
      return res.status(401).json({ error: 'auth_error', detail: authError.message, ...result });
    }
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: 'sync_failed', detail: String(err) });
  }
});
