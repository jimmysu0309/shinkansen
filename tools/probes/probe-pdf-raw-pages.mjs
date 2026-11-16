#!/usr/bin/env node
// probe-pdf-raw-pages.mjs — 一個瀏覽器連續解析多份 PDF，把指定頁的原始 textRuns / 圖片外框存成 json
//
// 用法：node tools/probes/probe-pdf-raw-pages.mjs <輸出目錄> <list.json>
//   list.json = [{ "file": "<相對 repo root 的 PDF 路徑>", "pages": [1-based 頁碼…] }, …]
//   輸出 <輸出目錄>/00.json、01.json…（順序同 list），已存在的略過（可續跑）
// 用途：語料前後比對出「版面有變動的頁」之後，把那些頁的原始資料存下來，離線用不同版本的
//   layout-analyzer.js 重算、逐條規則歸因（不必每試一版就重開瀏覽器）。
// 驗的層次：只是取資料，不做判斷。
import { chromium } from 'playwright'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [, , outDir, listPath] = process.argv;
const ROOT = path.resolve(import.meta.dirname, '..', '..'); const EXT = path.join(ROOT, 'shinkansen');
const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-raw-'));
const ctx = await chromium.launchPersistentContext(ud, { headless: false, args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio'] });
let [w] = ctx.serviceWorkers(); if (!w) w = await ctx.waitForEvent('serviceworker');
const extId = w.url().split('/')[2];
for (const [i, it] of list.entries()) {
  const out = path.join(outDir, `${String(i).padStart(2, '0')}.json`);
  if (fs.existsSync(out)) continue;
  const page = await ctx.newPage();
  try {
    await page.addInitScript(() => { window.__skKeepRawPages = true; });
    await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#file-input', path.resolve(ROOT, it.file));
    await page.waitForFunction(() => { const r = document.getElementById('stage-result'); return r && !r.hidden; }, null, { timeout: 180000, polling: 250 });
    const raw = await page.evaluate((idxs) => idxs.map((idx) => { const d = window.__skLayoutDoc; const r = d._rawPages[idx]; return r && { pageIndex: r.pageIndex, viewport: r.viewport, textRuns: r.textRuns, imageRects: d.pages[idx].imageRects || [] }; }).filter(Boolean), it.pages.map((n) => n - 1));
    fs.writeFileSync(out, JSON.stringify(raw));
    console.log('ok', i, it.file, raw.length);
  } catch (e) { console.log('ERR', i, it.file, e.message.slice(0, 100)); }
  await page.close();
}
await ctx.close(); fs.rmSync(ud, { recursive: true, force: true });
