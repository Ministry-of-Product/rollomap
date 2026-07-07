import pg from 'pg';
import './env.js';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://rollomap:rollomap@localhost:5432/rollomap';

export const pool = new pg.Pool({ connectionString });

export const WORKSPACE_ID =
  process.env.WORKSPACE_ID ?? '00000000-0000-0000-0000-000000000001';

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params as never[]);
}
