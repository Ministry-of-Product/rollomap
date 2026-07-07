// Loads the repo-root .env regardless of the process working directory.
//
// `npm --workspace @rollomap/api run dev` executes with cwd set to
// packages/api, so a bare `import 'dotenv/config'` (which reads ./.env) never
// finds the repo-root .env — the API then silently falls back to the wrong
// Postgres. Resolving the path relative to THIS file instead of cwd fixes that.
//
// dotenv does not override variables already present in process.env, so an
// explicit DATABASE_URL (Docker, CI, tests) still wins over the file.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// packages/api/src -> repo root
const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
config({ path: repoRootEnv });
