// Capture RolloMap README screenshots with Playwright.
//
// Prereqs: a running webapp + API seeded with DEMO data (never real data).
// See scripts/screenshots/README.md for the one-command demo stack.
//
//   BASE_URL   webapp origin (default http://localhost:5273)
//   OUT_DIR    where PNGs are written (default docs/assets)
//
// Usage: node scripts/screenshots/capture.mjs

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5273';
const OUT = process.env.OUT_DIR || 'docs/assets';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

async function shot(path, file, { fullPage = false } = {}) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700); // let lists/charts settle
  await page.screenshot({ path: `${OUT}/${file}`, fullPage });
  console.log('captured', file, '←', path);
}

// People directory
await shot('/people', 'people.png');

// Richest person's profile (most interactions => fullest page)
const res = await ctx.request.get(`${BASE}/api/people?limit=200`);
const { people = [] } = await res.json();
const hero = [...people].sort(
  (a, b) => (b.interaction_count || 0) - (a.interaction_count || 0),
)[0];
if (hero) {
  await shot(`/people/${hero.id}`, 'person-profile.png', { fullPage: true });
} else {
  console.warn('no people found — is the demo seed loaded?');
}

// Topics, interactions timeline, open loops
await shot('/topics', 'topics.png');
await shot('/interactions', 'interactions.png');
await shot('/open-loops', 'open-loops.png');

await browser.close();
console.log('done →', OUT);
