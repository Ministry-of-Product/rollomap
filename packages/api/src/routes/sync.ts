/**
 * Sync replication API (MIN-932): push / pull / ack.
 *
 *   POST /api/sync/push          — a trusted device uploads a batch of events
 *   GET  /api/sync/pull?since=…  — events the caller hasn't seen since its cursor
 *   POST /api/sync/ack           — advance a device's cursor after applying
 *
 * The cross-device cursor is server_seq (node-local total order); see
 * sync/replication.ts and db/migrations/006_sync_cursor.sql.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  pushEvents,
  pullEvents,
  ackCursor,
  getCursor,
  DeviceNotPushableError,
  type SyncEventEnvelope,
} from '../sync/replication.js';

export const syncRouter = Router();

const EventSchema = z.object({
  id: z.string().uuid(),
  device_id: z.string().uuid(),
  entity_type: z.string().min(1),
  entity_id: z.string().uuid(),
  operation: z.string().min(1),
  payload: z.unknown(),
  logical_clock: z.union([z.string(), z.number()]),
  hash: z.string().min(1),
});

const PushBody = z.object({
  device_id: z.string().uuid(),
  events: z.array(EventSchema), // empty batch is allowed (no-op success)
});

// POST /api/sync/push — accept a batch of events from a trusted device.
syncRouter.post('/push', async (req, res) => {
  const body = PushBody.parse(req.body);
  try {
    const result = await pushEvents(body.device_id, body.events as SyncEventEnvelope[]);
    res.json(result);
  } catch (err) {
    if (err instanceof DeviceNotPushableError) {
      return res.status(403).json({ error: 'device_not_pushable', detail: err.message });
    }
    throw err;
  }
});

// GET /api/sync/pull?device_id=&since=&include_own=&limit=
// Returns events the caller hasn't seen. `since` defaults to the device cursor.
syncRouter.get('/pull', async (req, res) => {
  const Query = z.object({
    device_id: z.string().uuid(),
    since: z.coerce.number().int().nonnegative().optional(),
    include_own: z
      .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
      .optional(),
    limit: z.coerce.number().int().positive().optional(),
  });
  const q = Query.parse(req.query);
  const includeOwn = q.include_own === '1' || q.include_own === 'true';
  const result = await pullEvents(q.device_id, {
    since: q.since ?? null,
    includeOwn,
    limit: q.limit,
  });
  res.json(result);
});

// POST /api/sync/ack — advance a device's cursor (idempotent, never backward).
syncRouter.post('/ack', async (req, res) => {
  const Body = z.object({
    device_id: z.string().uuid(),
    server_seq: z.coerce.number().int().nonnegative(),
    last_event_id: z.string().uuid().nullable().optional(),
  });
  const body = Body.parse(req.body);
  const result = await ackCursor(body.device_id, body.server_seq, body.last_event_id ?? null);
  res.json(result);
});

// GET /api/sync/cursor?device_id= — inspect a device's current cursor.
syncRouter.get('/cursor', async (req, res) => {
  const Query = z.object({ device_id: z.string().uuid() });
  const q = Query.parse(req.query);
  const last_seen_server_seq = await getCursor(q.device_id);
  res.json({ device_id: q.device_id, last_seen_server_seq });
});
