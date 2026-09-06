// epub-translate-harness.js — EPUB 翻譯端到端自驗 harness（v2.0.11）
//
// 用法：
//   EPUB_PATH=/path/to/book.epub node tools/harness/epub-translate-harness.js [--glossary] [--chapter N] [--dual]
//
//   --glossary   先跑全書術語表抽取（真 EXTRACT_GLOSSARY 多輪），再用它翻譯
//   --chapter N  指定翻第 N 章（0-based index）；省略時自動挑字數最小的正文章節
//   --dual       雙語對照輸出（下載前切「譯本內容」select，存 epub-translated-dual.epub）
//
// 行為：
//   1. fresh profile 載入 unpacked extension，注入 ~/.shinkansen-test-key 到
//      chrome.storage.local.apiKey，target 鎖 zh-TW，preset 鎖 gemini-3.1-flash-lite
//      （debug 一律 lite 模型省錢）
//   2. 上傳 EPUB → 章節清單 → 選一章 →（可選）全書術語表 → 真翻譯
//   3. 產出到 .playwright-mcp/：
//      epub-chapters-before.png / epub-glossary.png / epub-chapters-after.png /
//      epub-preview.png / epub-translated.epub（點下載按鈕攔 download）
//   4. stdout dump：章節清單、術語表條目數、各章狀態、費用
//
// 驗的層次：真實 Gemini API + 完整 UI 路徑（上傳→選章→術語表→翻譯→下載）。
// 不驗：Apple Books / Kobo 實機渲染（人工驗收）。
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../../shinkansen');
const OUT_DIR = path.resolve(import.meta.dirname, '../../.playwright-mcp');
const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');

const EPUB_PATH = process.env.EPUB_PATH;
const WITH_GLOSSARY = process.argv.includes('--glossary');
const WITH_DUAL = process.argv.includes('--dual'); // 雙語對照輸出（下載前切 select）
const chapterArgIdx = process.argv.indexOf('--chapter');
const FORCED_CHAPTER = chapterArgIdx !== -1 ? parseInt(process.argv[chapterArgIdx + 1], 10) : null;

if (!EPUB_PATH || !fs.existsSync(EPUB_PATH)) {
  console.error('EPUB_PATH 未設定或檔案不存在');
  process.exit(1);
}
if (!fs.existsSync(KEY_PATH)) {
  console.error(`找不到 ${KEY_PATH}（40 chars Gemini key）`);
  process.exit(1);
}
const API_KEY = fs.readFileSync(KEY_PATH, 'utf-8').trim();
fs.mkdirSync(OUT_DIR, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-epub-harness-'));
const headed = process.env.SHINKANSEN_HEADED === '1';
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    ...(headed ? [] : ['--headless=new']),
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
console.log('[harness] extension id =', extId);

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });

// 注入 key + 設定（debug 一律 lite 模型；target zh-TW）
await page.evaluate(async ({ apiKey }) => {
  await chrome.storage.local.set({ apiKey, translateDocPresetSlot: 1 });
  await chrome.storage.sync.set({
    targetLanguage: 'zh-TW',
    translatePresets: [
      { label: 'lite', engine: 'gemini', model: 'gemini-3.1-flash-lite' },
      { label: 'lite2', engine: 'gemini', model: 'gemini-3.1-flash-lite' },
      { label: 'lite3', engine: 'gemini', model: 'gemini-3.1-flash-lite' },
    ],
  });
}, { apiKey: API_KEY });
console.log('[harness] apiKey + preset(gemini-3.1-flash-lite) + zh-TW 已注入');
await page.reload({ waitUntil: 'domcontentloaded' });

// 上傳
await page.setInputFiles('#file-input', EPUB_PATH);
await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 60_000 });
const chapterDump = await page.evaluate(() => window.__skEpubDoc.chapters.map((c) => ({
  index: c.index, href: c.href, title: c.title, chars: c.charCount,
  selected: c.selected, suggestSkip: c.suggestSkip, blocks: c.blocks.length,
})));
console.log('[harness] 章節清單：');
for (const c of chapterDump) {
  console.log(`  #${c.index} ${c.title} — ${c.chars} chars / ${c.blocks} blocks` +
    `${c.suggestSkip ? ' [附屬頁]' : ''}`);
}
await page.screenshot({ path: path.join(OUT_DIR, 'epub-chapters-before.png'), fullPage: true });

// 挑章節：指定 or 自動挑最小正文章（≥2000 chars 非附屬頁）
let target = FORCED_CHAPTER;
if (target == null) {
  const candidates = chapterDump.filter((c) => !c.suggestSkip && c.chars >= 2000);
  candidates.sort((a, b) => a.chars - b.chars);
  target = candidates.length > 0 ? candidates[0].index : chapterDump.find((c) => c.chars > 0)?.index;
}
console.log(`[harness] 目標章節 #${target}（${chapterDump[target].title}, ${chapterDump[target].chars} chars）`);
await page.evaluate((idx) => {
  for (const c of window.__skEpubDoc.chapters) c.selected = (c.index === idx);
}, target);

if (WITH_GLOSSARY) {
  console.log('[harness] 全書術語表抽取（真 API，多輪）…');
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 10_000 });
  const start = Date.now();
  let terms = 0;
  while (Date.now() - start < 300_000) {
    terms = await page.locator('#glossary-grid .g-source').count();
    if (terms > 0) break;
    await page.waitForTimeout(500);
  }
  console.log(`[harness] 術語表 ${terms} 條`);
  const sample = await page.locator('#glossary-grid .g-source').evaluateAll(
    (els) => els.slice(0, 15).map((e, i) => `${e.value} → ${e.nextElementSibling?.value || ''}`));
  console.log('[harness] 術語表前 15 條：\n  ' + sample.join('\n  '));
  await page.screenshot({ path: path.join(OUT_DIR, 'epub-glossary.png'), fullPage: true });
  // 選擇已在上面設好（glossary-translate-btn 走 startEpubTranslate）
  await page.click('#glossary-translate-btn');
} else {
  await page.click('#chapters-translate-btn');
}

// 等翻譯完成（回 chapters stage）
await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 600_000 });
const after = await page.evaluate(() => {
  const doc = window.__skEpubDoc;
  return {
    chapters: doc.chapters.map((c) => {
      let done = 0, failed = 0;
      for (const b of c.blocks) {
        if (b.translationStatus === 'done') done++;
        else if (b.translationStatus === 'failed') failed++;
      }
      return { index: c.index, title: c.title, done, failed, total: c.blocks.length };
    }),
    summary: doc.translateSummary || null,
  };
});
console.log('[harness] 翻譯後狀態：');
for (const c of after.chapters) {
  if (c.done + c.failed > 0) console.log(`  #${c.index} ${c.title}: done=${c.done} failed=${c.failed} / ${c.total}`);
}
const cost = await page.evaluate(() => document.getElementById('chapters-cumulative-cost')?.textContent || '');
console.log('[harness] 累計費用：', cost || '（無）');
await page.screenshot({ path: path.join(OUT_DIR, 'epub-chapters-after.png'), fullPage: true });

// 預覽截圖
const previewBtns = page.locator('.chapter-preview-btn');
if (await previewBtns.count() > 0) {
  await previewBtns.first().click();
  await page.waitForSelector('#stage-epub-preview:not([hidden])', { timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT_DIR, 'epub-preview.png'), fullPage: true });
  await page.click('#epub-preview-back-btn');
}

// 下載譯本 EPUB（攔 download）。--dual 時先切「譯本內容」select 到雙語對照
if (WITH_DUAL) {
  await page.selectOption('#epub-dual-mode', 'dual');
  console.log('[harness] 譯本內容 = 雙語對照');
}
const dlPromise = page.waitForEvent('download', { timeout: 120_000 });
await page.click('#chapters-download-btn');
const dl = await dlPromise;
const outEpub = path.join(OUT_DIR, WITH_DUAL ? 'epub-translated-dual.epub' : 'epub-translated.epub');
await dl.saveAs(outEpub);
console.log('[harness] 譯本已存：', outEpub, fs.statSync(outEpub).size, 'bytes');

await ctx.close();
console.log('[harness] 完成');
