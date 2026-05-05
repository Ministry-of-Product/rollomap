import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = resolve(__dirname, '../../../db/seed.sql');

const sql = readFileSync(seedPath, 'utf8');

const main = async () => {
  console.log(`[rollomap-seed] running ${seedPath}`);
  await pool.query(sql);
  console.log('[rollomap-seed] done');
  await pool.end();
};

main().catch(err => {
  console.error('[rollomap-seed] failed', err);
  process.exit(1);
});
