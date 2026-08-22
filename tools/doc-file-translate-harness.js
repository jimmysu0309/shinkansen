// doc-file-translate-harness.js — txt / md / html / 字幕檔文件翻譯端到端自驗 harness（v2.0.87）
//
// 用法：
//   node tools/doc-file-translate-harness.js [--kind txt|md|html|srt|vtt|ass[,…]] [--csv-only]
//
//   省略 --kind 時六種格式全跑（逗號可列多種）。--csv-only 只驗術語表 CSV 匯入（不打翻譯 API）。
//
// 行為（每種格式）：
//   1. fresh profile 載入 unpacked extension，注入 ~/.shinkansen-test-key、
//      target zh-TW、preset 鎖 gemini-3.1-flash-lite（debug 一律 lite 省錢）
//   2. 產生內建小 fixture（txt 兩段落 / md 兩章含清單引用 fence / html 三段落）
//   3. 上傳 → 章節清單（驗單章 txt/html 不出章節勾選 UI）→ 真翻譯 →
//      點下載攔 download 存 .playwright-mcp/docfile-translated.<ext> → dump 內容
//      （字幕檔再切「雙語對照」下載一次，驗譯文在上原文在下）
//   4. md 流程加驗術語表 CSV 匯入（匯入 → 覆蓋 → 驗表格條目）
//
// 驗的層次：真實 Gemini API + 完整 UI 路徑（上傳→翻譯→下載）+ 輸出檔結構
//（markdown 前綴 / fence 保留 / html 標籤保留）。不驗：譯文品質（人工過目 stdout）。
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '../shinkansen');
const OUT_DIR = path.resolve(import.meta.dirname, '../.playwright-mcp');
const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');

const kindArgIdx = process.argv.indexOf('--kind');
const ONLY_KINDS = kindArgIdx !== -1 ? new Set(process.argv[kindArgIdx + 1].split(',')) : null;
const CSV_ONLY = process.argv.includes('--csv-only');

if (!fs.existsSync(KEY_PATH)) {
  console.error(`找不到 ${KEY_PATH}（40 chars Gemini key）`);
  process.exit(1);
}
const API_KEY = fs.readFileSync(KEY_PATH, 'utf-8').trim();
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── fixtures（公版樣文，刻意極小控費用）─────────────────────
const FIXTURES = {
  txt: {
    name: 'sample-novel.txt',
    content: 'The old lighthouse keeper climbed the spiral stairs every evening.\nHe carried a small lantern in his left hand.\n\nOutside, the waves crashed against the rocks below.\n\n***\n\nAt dawn he wrote a single line in his logbook.\n',
  },
  md: {
    name: 'sample-notes.md',
    content: '# The Lighthouse\n\nThe keeper climbed the stairs every evening.\n\n- He carried a lantern.\n- He watched the sea.\n\n> The waves never rest, he thought.\n\n```js\nconsole.log("code stays untouched");\n```\n\n## The Morning\n\nAt dawn he wrote a single line in his logbook.\n',
  },
  html: {
    name: 'sample-page.html',
    content: '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>The Lighthouse</title></head>\n<body>\n<h1>The Lighthouse</h1>\n<p>The keeper climbed the <em>spiral stairs</em> every evening.</p>\n<p>He carried a small lantern in his left hand.</p>\n<script>console.log("script preserved");</script>\n</body>\n</html>\n',
  },
  // 字幕檔：行內標記（<i> / {\an8} / <c.cls> / <v>）、純音符字幕、半句接續
  srt: {
    name: 'sample-episode.srt',
    content: '1\n00:00:01,000 --> 00:00:03,000\nThe keeper climbed the stairs\n\n2\n00:00:03,200 --> 00:00:05,000\nevery single evening.\n\n3\n00:00:05,500 --> 00:00:07,000\n♪ ♪\n\n4\n00:00:07,500 --> 00:00:10,000\n{\\an8}<i>Outside,</i> the waves crashed\nagainst the rocks below.\n',
  },
  vtt: {
    name: 'sample-episode.vtt',
    content: 'WEBVTT\nKind: captions\n\nNOTE\nharness fixture\n\nintro\n00:01.000 --> 00:04.000 align:start position:10%\n<v Keeper>I climb these stairs <c.yellow>every evening</c>.\n\n00:05.000 --> 00:08.000\nAt dawn he wrote a single line.\n',
  },
  ass: {
    name: 'sample-episode.ass',
    content: '[Script Info]\nTitle: Harness\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nComment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,fixture comment\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}The keeper climbed the stairs,\\Nevery single evening.\nDialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\i1}At dawn{\\i0} he wrote a single line.\n',
  },
};
// Big5 編碼的 SRT（bytes）：驗「舊編碼自動判斷 → 輸出 UTF-8」。內容：
// 「你好嗎」「我很好，謝謝」
const BIG5_SRT_BYTES = Buffer.concat([
  Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n', 'latin1'),
  Buffer.from([0xA7, 0x41, 0xA6, 0x6E, 0xB6, 0xDC]),
  Buffer.from('\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n', 'latin1'),
  Buffer.from([0xA7, 0xDA, 0xAB, 0xDC, 0xA6, 0x6E, 0xA1, 0x41, 0xC1, 0xC2, 0xC1, 0xC2]),
  Buffer.from('\r\n', 'latin1'),
]);
FIXTURES['srt-big5'] = { name: 'sample-big5.srt', bytes: BIG5_SRT_BYTES };
const SUBTITLE_KINDS = new Set(['srt', 'vtt', 'ass', 'srt-big5']);

const CSV_FIXTURE = {
  name: 'glossary.csv',
  content: '﻿原文,譯名\r\nkeeper,守塔人\r\n"lighthouse, the",燈塔\r\n',
};

const tmpFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-docfile-fixtures-'));
function fixtureFile(spec) {
  const p = path.join(tmpFixtureDir, spec.name);
  fs.writeFileSync(p, spec.bytes || spec.content);
  return p;
}

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-docfile-harness-'));
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
  return { ctx, page };
}

async function runKind(kind) {
  console.log(`\n===== ${kind} =====`);
  const { ctx, page } = await launch();
  try {
    await page.setInputFiles('#file-input', fixtureFile(FIXTURES[kind]));
    await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 30_000 });

    const info = await page.evaluate(() => ({
      kind: window.__skEpubDoc.kind,
      chapters: window.__skEpubDoc.chapters.map((c) => ({
        title: c.title, blocks: c.blocks.length, chars: c.charCount, selected: c.selected,
      })),
      listHidden: document.getElementById('chapters-list').hidden,
      selectActionsHidden: document.querySelector('#stage-chapters .chapters-select-actions').hidden,
      formatLabel: document.getElementById('chapters-epub-version').textContent,
      dualHidden: document.getElementById('epub-dual-wrap').hidden,
    }));
    console.log('[harness] doc:', JSON.stringify(info, null, 2));
    await page.screenshot({ path: path.join(OUT_DIR, `docfile-${kind}-chapters.png`), fullPage: true });

    // 真翻譯
    await page.click('#chapters-translate-btn');
    await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 300_000 });
    const after = await page.evaluate(() => {
      let done = 0, failed = 0;
      for (const c of window.__skEpubDoc.chapters) {
        for (const b of c.blocks) {
          if (b.translationStatus === 'done') done++;
          else if (b.translationStatus === 'failed') failed++;
        }
      }
      return { done, failed };
    });
    console.log('[harness] 翻譯結果：', after);
    await page.screenshot({ path: path.join(OUT_DIR, `docfile-${kind}-after.png`), fullPage: true });

    // 下載譯文檔
    const dlBtnText = await page.locator('#chapters-download-btn').textContent();
    console.log('[harness] 下載按鈕文案：', dlBtnText);
    const dlPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.click('#chapters-download-btn');
    const dl = await dlPromise;
    const outPath = path.join(OUT_DIR, `docfile-translated-${kind}${path.extname(dl.suggestedFilename())}`);
    await dl.saveAs(outPath);
    console.log('[harness] 譯文檔：', dl.suggestedFilename(), '→', outPath);
    console.log('[harness] ── 譯文檔內容 ──');
    console.log(fs.readFileSync(outPath, 'utf-8'));
    if (kind === 'srt-big5') {
      // 輸出必為合法 UTF-8（fatal 解碼不拋）且原文字幕（雙語 / 未翻露出）不含亂碼
      const bytes = fs.readFileSync(outPath);
      let utf8Ok = true;
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { utf8Ok = false; }
      const srcOk = await page.evaluate(() => window.__skEpubDoc.chapters[0].blocks.map((b) => b.plainText).join('|'));
      console.log('[harness] Big5 → UTF-8 驗證：', utf8Ok ? 'UTF-8 OK' : 'UTF-8 FAIL', '| 解碼原文：', srcOk);
      if (!utf8Ok || !srcOk.includes('你好嗎') || !srcOk.includes('謝謝')) process.exitCode = 1;
    }

    // 字幕檔：切「雙語對照」再下載一次（譯文資料不變，零重翻）
    if (SUBTITLE_KINDS.has(kind)) {
      const dualWrapHidden = await page.evaluate(() => document.getElementById('epub-dual-wrap').hidden);
      console.log('[harness] 字幕雙語 select 顯示：', !dualWrapHidden);
      if (dualWrapHidden) process.exitCode = 1;
      await page.selectOption('#epub-dual-mode', 'dual');
      const dl2Promise = page.waitForEvent('download', { timeout: 60_000 });
      await page.click('#chapters-download-btn');
      const dl2 = await dl2Promise;
      const outPath2 = path.join(OUT_DIR, `docfile-translated-${kind}-dual${path.extname(dl2.suggestedFilename())}`);
      await dl2.saveAs(outPath2);
      console.log('[harness] 雙語譯文檔：', dl2.suggestedFilename(), '→', outPath2);
      console.log('[harness] ── 雙語譯文檔內容 ──');
      console.log(fs.readFileSync(outPath2, 'utf-8'));
    }

    // 工作階段還原：同 profile 重新上傳同檔,IndexedDB session 應載回翻譯進度
    await page.click('#chapters-reupload-btn');
    await page.waitForSelector('#stage-upload:not([hidden])', { timeout: 10_000 });
    await page.setInputFiles('#file-input', fixtureFile(FIXTURES[kind]));
    await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 30_000 });
    const restored = await page.evaluate(() => {
      let done = 0;
      for (const c of window.__skEpubDoc.chapters) {
        for (const b of c.blocks) if (b.translationStatus === 'done') done++;
      }
      return done;
    });
    console.log('[harness] 重新上傳後 session 還原 done blocks：', restored);
    if (restored === 0) {
      console.log('[harness] SESSION RESTORE FAIL');
      process.exitCode = 1;
    }
  } finally {
    await ctx.close();
  }
}

async function runCsvImport() {
  console.log('\n===== glossary CSV import =====');
  const { ctx, page } = await launch();
  try {
    await page.setInputFiles('#file-input', fixtureFile(FIXTURES.md));
    await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 30_000 });
    await page.click('#chapters-glossary-btn');
    await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 10_000 });
    // 等自動抽取結束（真 API，小文件單輪）
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      const loading = await page.locator('.glossary-state.is-loading').count();
      if (loading === 0) break;
      await page.waitForTimeout(500);
    }
    const beforeCount = await page.locator('#glossary-grid .g-source').count();
    console.log('[harness] 自動抽取條數：', beforeCount);

    // 匯入 CSV。現有表非空時會跳合併 dialog → 選「覆蓋」驗 CSV 條目原樣進表
    await page.setInputFiles('#glossary-import-file', fixtureFile(CSV_FIXTURE));
    if (beforeCount > 0) {
      await page.waitForSelector('#glossary-import-dialog[open]', { timeout: 10_000 });
      await page.click('#glossary-import-overwrite-btn');
    }
    await page.waitForTimeout(500);
    const rows = await page.locator('#glossary-grid .g-source').evaluateAll(
      (els) => els.map((e) => `${e.value} → ${e.nextElementSibling?.value || ''}`));
    console.log('[harness] 匯入後條目：\n  ' + rows.join('\n  '));
    await page.screenshot({ path: path.join(OUT_DIR, 'docfile-csv-import.png'), fullPage: true });
    const ok = rows.some((r) => r.includes('keeper → 守塔人'))
      && rows.some((r) => r.includes('lighthouse, the → 燈塔'));
    console.log('[harness] CSV 匯入驗證：', ok ? 'PASS' : 'FAIL');
    if (!ok) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

if (!CSV_ONLY) {
  for (const kind of ['txt', 'md', 'html', 'srt', 'vtt', 'ass', 'srt-big5']) {
    if (ONLY_KINDS && !ONLY_KINDS.has(kind)) continue;
    await runKind(kind);
  }
}
if (!ONLY_KINDS || CSV_ONLY) await runCsvImport();
console.log('\n[harness] 完成');
