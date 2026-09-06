// probe:dump 指定 PDF 的完整 layoutDoc(_lines 含 runs bbox)供 gap 數據分析
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const REPO = '/Users/jimmysu/Documents/Claude/Projects/Shinkansen';
const EXT = path.join(REPO, 'shinkansen');
const PDF = process.env.PDF_PATH;
const OUT = process.env.OUT_PATH || '/tmp/layout-probe.json';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check'],
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = worker.url().split('/')[2];
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#dropzone', { state: 'visible' });
await page.setInputFiles('#file-input', PDF);
await page.waitForFunction(() => {
  const r = document.getElementById('stage-result');
  return r && !r.hidden;
}, null, { timeout: 90000, polling: 250 });

const doc = await page.evaluate(() => {
  const d = window.__skLayoutDoc;
  if (!d) return null;
  return {
    pages: d.pages.map((p) => ({
      pageIndex: p.pageIndex,
      medianLineHeight: p.medianLineHeight,
      columnCount: p.columnCount,
      blocks: p.blocks.map((b) => ({
        blockId: b.blockId, type: b.type, bbox: b.bbox, fontSize: b.fontSize,
        lineCount: b.lineCount, plainText: (b.plainText || '').slice(0, 90),
        lines: (b._lines || []).map((l) => ({
          bbox: l.bbox, text: (l.plainText || '').slice(0, 90),
          runs: (l.runs || []).map((r) => ({ bbox: r.bbox, text: (r.text || r.str || '').slice(0, 40) })),
        })),
      })),
    })),
  };
});
fs.writeFileSync(OUT, JSON.stringify(doc));
console.log('written', OUT);
await ctx.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
