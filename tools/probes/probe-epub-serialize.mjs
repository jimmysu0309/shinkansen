// probe:fixture EPUB 解析後每個 block 的 epubSerializedText / slots 長度
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = '/Users/jimmysu/Documents/Claude/Projects/Shinkansen/shinkansen';
const FIXTURE = '/Users/jimmysu/Documents/Claude/Projects/Shinkansen/test/regression/fixtures/epub-mini-book.epub';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('#file-input', FIXTURE);
await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15000 });

const dump = await page.evaluate(() => {
  const doc = window.__skEpubDoc;
  return doc.chapters.map((c) => ({
    href: c.href,
    blocks: c.blocks.map((b) => ({
      id: b.blockId,
      type: b.type,
      slots: (b.slots || []).length,
      text: b.epubSerializedText,
    })),
  }));
});
console.log(JSON.stringify(dump, null, 2));
await ctx.close();
