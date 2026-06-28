import { Router } from 'express';
import { z } from 'zod';
import { WORKSPACE_ID } from '../db.js';
import {
  getLocalDeviceId,
  registerDevice,
  listDevices,
  revokeDevice,
} from '../sync/device.js';

export const devicesRouter = Router();

// GET /api/devices — list all devices for this workspace
devicesRouter.get('/', async (_req, res) => {
  const devices = await listDevices(WORKSPACE_ID);
  res.json({ devices });
});

// POST /api/devices — register a new device
const DeviceInput = z.object({
  name: z.string().min(1),
  public_key: z.string().optional(),
});

devicesRouter.post('/', async (req, res) => {
  const data = DeviceInput.parse(req.body);
  const device = await registerDevice(WORKSPACE_ID, data.name, data.public_key);
  res.status(201).json({ device });
});

// GET /api/devices/local — return the default local device id (bootstraps if missing)
devicesRouter.get('/local', async (_req, res) => {
  const id = await getLocalDeviceId();
  res.json({ device_id: id });
});

// POST /api/devices/:id/revoke — revoke a device
devicesRouter.post('/:id/revoke', async (req, res) => {
  const revoked = await revokeDevice(req.params.id, WORKSPACE_ID);
  if (!revoked) return res.status(404).json({ error: 'not_found_or_already_revoked' });
  res.json({ ok: true });
});
