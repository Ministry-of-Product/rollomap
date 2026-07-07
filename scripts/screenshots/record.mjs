// Record a short GIF walkthrough of the RolloMap webapp with Playwright,
// encoding the GIF in pure JS (gifenc + pngjs) — no ffmpeg dependency.
//
// Runs against the DEMO stack (never real data). Writes docs/assets/demo.gif.
// Env: BASE_URL (default http://localhost:5273), OUT (default docs/assets/demo.gif).

import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5273';
const OUT = process.env.OUT || 'docs/assets/demo.gif';
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1100, height: 720 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

const frames = []; // { rgba, width, height, delayMs }
async function frame(delayMs = 1200) {
  const buf = await page.screenshot({ type: 'png' });
  const png = PNG.sync.read(buf);
  frames.push({ rgba: new Uint8Array(png.data), width: png.width, height: png.height, delayMs });
}

// People directory
await page.goto(`${BASE}/people`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await frame(1600);

// Person profile
await page.getByText('Sofia Lindqvist', { exact: true }).click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
await frame(1600);
await page.mouse.wheel(0, 650);
await page.waitForTimeout(500);
await frame(1400);
await page.mouse.wheel(0, 750);
await page.waitForTimeout(500);
await frame(1600);

// Topics
await page.getByRole('link', { name: 'Topics', exact: true }).click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
await frame(1600);

// Open loops
await page.getByRole('link', { name: 'Open loops', exact: true }).click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
await frame(1800);

// Back to people
await page.getByRole('link', { name: 'People', exact: true }).click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
await frame(1400);

await browser.close();

// Encode GIF
const gif = GIFEncoder();
for (const f of frames) {
  const palette = quantize(f.rgba, 256);
  const index = applyPalette(f.rgba, palette);
  gif.writeFrame(index, f.width, f.height, { palette, delay: f.delayMs });
}
gif.finish();
writeFileSync(OUT, Buffer.from(gif.bytes()));
console.log(`wrote ${OUT} (${frames.length} frames)`);
