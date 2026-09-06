// probe:真翻譯指定 PDF 後 dump 每個 block 的 bbox + translation(診斷疊字 / 錯位)
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const REPO = '/Users/jimmysu/Documents/Claude/Projects/Shinkansen';
const EXT = path.join(REPO, 'shinkansen');
const PDF = process.env.PDF_PATH;
const OUT = process.env.OUT_PATH || '/tmp/translated-doc-probe.json';
const KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();

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
await page.evaluate((apiKey) => new Promise((resolve) => {
  chrome.storage.local.set({ apiKey }, resolve);
}), KEY);
await page.setInputFiles('#file-input', PDF);
await page.waitForFunction(() => {
  const r = document.getElementById('stage-result');
  return r && !r.hidden;
}, null, { timeout: 90000, polling: 250 });
await page.click('#translate-btn');
await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 600000 });

const doc = await page.evaluate(() => {
  const d = window.__skLayoutDoc;
  if (!d) return null;
  return {
    pages: d.pages.map((p) => ({
      pageIndex: p.pageIndex,
      blocks: p.blocks.map((b) => ({
        blockId: b.blockId, type: b.type, bbox: b.bbox, fontSize: b.fontSize,
        lineCount: b.lineCount,
        status: b.translationStatus || null,
        plainText: (b.plainText || '').slice(0, 60),
        translation: (b.translation || '').slice(0, 80),
      })),
    })),
  };
});
fs.writeFileSync(OUT, JSON.stringify(doc));
console.log('written', OUT);
await ctx.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
