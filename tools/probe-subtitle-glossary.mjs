// probe-subtitle-glossary.mjs — 字幕檔 + 術語表真 API 端到端 probe（2026-08-22）
//
// 用法：
//   node tools/probe-subtitle-glossary.mjs <字幕檔> <術語表 JSON> [--max-cues N]
//
// 驗的層次：production UI 路徑（上傳 → 術語表頁匯入 JSON 覆蓋 → 用此術語表翻譯
// → 下載）下，「譯名（原文）」對照加註在（a）模型輸出層（字幕提示是否擋住）與
//（b）確定性清理層（applySubtitleGlossaryCleanup）各攔下多少。輸出：
//   - console 抓 index.js「字幕術語表對照清理：N 處」= 模型仍加註、被清理層攔下的數
//   - 下載檔內殘留「中文（拉丁…）」對照數（= 兩層都沒擋住的）
// 不驗：譯文品質（人工過目 stdout 片段）。
// 預設 lite 模型省錢；--max-cues 截短字幕檔控費用（預設全檔）。
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../shinkansen');
const OUT_DIR = path.resolve(import.meta.dirname, '../.playwright-mcp');
const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');

const [, , subtitlePath, glossaryPath] = process.argv;
const maxIdx = process.argv.indexOf('--max-cues');
const MAX_CUES = maxIdx !== -1 ? Number(process.argv[maxIdx + 1]) : Infinity;
if (!subtitlePath || !glossaryPath) {
  console.error('用法：node tools/probe-subtitle-glossary.mjs <字幕檔> <術語表 JSON> [--max-cues N]');
  process.exit(1);
}
if (!fs.existsSync(KEY_PATH)) {
  console.error(`找不到 ${KEY_PATH}`);
  process.exit(1);
}
const API_KEY = fs.readFileSync(KEY_PATH, 'utf-8').trim();
fs.mkdirSync(OUT_DIR, { recursive: true });

// 截短字幕檔（按空白行切則）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-subgloss-'));
let srtText = fs.readFileSync(subtitlePath, 'utf-8');
if (Number.isFinite(MAX_CUES)) {
  const blocks = srtText.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  srtText = blocks.slice(0, MAX_CUES).join('\n\n') + '\n';
}
const srtFile = path.join(tmpDir, path.basename(subtitlePath));
fs.writeFileSync(srtFile, srtText);
const glossaryFile = path.join(tmpDir, 'glossary.json');
fs.copyFileSync(glossaryPath, glossaryFile);
const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf-8'));
const entries = Array.isArray(glossary) ? glossary : (glossary.entries || []);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-subgloss-profile-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    ...(process.env.SHINKANSEN_HEADED === '1' ? [] : ['--headless=new']),
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
  ],
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
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
  await page.reload({ waitUntil: 'domcontentloaded' });

  // 軟警告 confirm（字數 / 預估費用）與重翻 confirm：Playwright 預設 dismiss → 翻譯取消，必須接受
  page.on('dialog', (d) => d.accept());
  const consoleLines = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[Shinkansen]')) consoleLines.push(t); });

  await page.setInputFiles('#file-input', srtFile);
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 60_000 });
  const info = await page.evaluate(() => ({
    kind: window.__skEpubDoc.kind, blocks: window.__skEpubDoc.chapters[0].blocks.length,
    chars: window.__skEpubDoc.stats.totalChars,
  }));
  console.log('[probe] doc:', JSON.stringify(info));

  // 術語表頁：等自動抽取結束 → 匯入 JSON 覆蓋
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 10_000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 600_000) {
    if ((await page.locator('.glossary-state.is-loading').count()) === 0) break;
    await page.waitForTimeout(1000);
  }
  console.log('[probe] 自動抽取結束，耗時 s：', Math.round((Date.now() - t0) / 1000));
  const before = await page.locator('#glossary-grid .g-source').count();
  await page.setInputFiles('#glossary-import-file', glossaryFile);
  if (before > 0) {
    await page.waitForSelector('#glossary-import-dialog[open]', { timeout: 10_000 });
    await page.click('#glossary-import-overwrite-btn');
  }
  await page.waitForTimeout(500);
  const rows = await page.locator('#glossary-grid .g-source').count();
  console.log('[probe] 匯入後術語表條數：', rows, '（JSON 條數', entries.length, '）');

  // 書籍式文件：術語表頁按鈕是「儲存」→ 回章節頁；翻譯從章節頁主按鈕起
  await page.click('#glossary-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 10_000 });
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters', { state: 'hidden', timeout: 30_000 });
  await page.waitForSelector('#stage-chapters', { state: 'visible', timeout: 1_800_000 });
  const after = await page.evaluate(() => {
    let done = 0, failed = 0;
    for (const b of window.__skEpubDoc.chapters[0].blocks) {
      if (b.translationStatus === 'done') done++;
      else if (b.translationStatus === 'failed') failed++;
    }
    return { done, failed };
  });
  console.log('[probe] 翻譯結果：', after);
  if (after.done === 0) { console.log('[probe] console:\n  ' + consoleLines.slice(-15).join('\n  ')); process.exitCode = 1; }
  const cleanupLine = consoleLines.find((l) => l.includes('術語表對照清理'));
  console.log('[probe] 清理層攔下（模型仍加註的術語表對照）：', cleanupLine || '0（console 無清理訊息）');

  // 下載單語字幕檔，數殘留對照
  const dlPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.click('#chapters-download-btn');
  const dl = await dlPromise;
  const outPath = path.join(OUT_DIR, 'probe-subtitle-glossary-translated.srt');
  await dl.saveAs(outPath);
  const out = fs.readFileSync(outPath, 'utf-8');
  const leftover = out.match(/[一-鿿]\s?[（(][A-Za-z][^）)]*[）)]/g) || [];
  console.log('[probe] 下載檔殘留「中文（拉丁）」對照數：', leftover.length, leftover.slice(0, 12));
  // 術語表譯名採用率
  const cues = out.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.split('\n').slice(2).join('\n'));
  const srcCues = srtText.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.split('\n').slice(2).join('\n'));
  let hit = 0, miss = 0;
  for (const e of entries) {
    const tgt = String(e.target || '').replace(/[《》]/g, '').split(/[（(]/)[0];
    if (!tgt || e.noTranslate) continue;
    const re = new RegExp(`\\b${e.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    srcCues.forEach((s, i) => { if (re.test(s)) { if ((cues[i] || '').includes(tgt)) hit++; else miss++; } });
  }
  console.log('[probe] 術語表譯名採用：hit', hit, 'miss', miss, '（miss 含跨則語序搬動）');
  console.log('[probe] 譯文前 8 則：\n' + cues.slice(0, 8).map((c, i) => `  [${i}] ${c.replace(/<[^>]+>/g, '')}`).join('\n'));
  console.log('[probe] 輸出：', outPath);
} finally {
  await ctx.close();
}
