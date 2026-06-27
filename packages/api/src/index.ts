import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { peopleRouter } from './routes/people.js';
import { interactionsRouter } from './routes/interactions.js';
import { topicsRouter } from './routes/topics.js';
import { notesRouter } from './routes/notes.js';
import { commitmentsRouter } from './routes/commitments.js';
import { sourcesRouter } from './routes/sources.js';
import { queryRouter } from './routes/query.js';
import { statsRouter } from './routes/stats.js';
import { devicesRouter } from './routes/devices.js';
import { syncRouter } from './routes/sync.js';
import { groupsRouter } from './routes/groups.js';
import { pool } from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.use('/api/people', peopleRouter);
app.use('/api/interactions', interactionsRouter);
app.use('/api/topics', topicsRouter);
app.use('/api/notes', notesRouter);
app.use('/api/commitments', commitmentsRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/query', queryRouter);
app.use('/api/stats', statsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/sync', syncRouter);
app.use('/api/groups', groupsRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.API_PORT ?? 4000);
app.listen(port, () => {
  console.log(`[rollomap-api] listening on :${port}`);
});
