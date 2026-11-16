#!/usr/bin/env node
// probe-doc-link-title-marks.mjs — 文件翻譯把連結文字包上書名號《》是否穩定出現、與 ⟦l:N⟧ 有沒有關係
//
// 用法（會打真實 API，key 讀 ~/.shinkansen-test-key）：
//   PDF_PATH=<pdf> PAGE=4,5,6 RUNS=3 node tools/probes/probe-doc-link-title-marks.mjs   # PAGE 1-based，可逗號分隔（同一次翻譯）
//   SK_EXT_PATH=<擴充功能副本> …      # 對照別的版本
//
// 做法：真實 pdf-engine + layout-analyzer 解析出指定頁的 block，在 translate-doc 頁面內
// 動態 import translate.js，對同一批 block 直接呼叫 translateDocument（與按「翻譯」同一條路徑，
// 沒有術語表、預設模型），分兩組各跑 RUNS 次，每次先清掉這批文字的翻譯快取：
//   A 組：原樣（連結文字帶 ⟦l:N⟧…⟦/l⟧）
//   B 組：把 block 的連結資訊拿掉（styleSegments.linkUrl = null、linkUrls = []）→ 送出的文字沒有連結標記
// 統計每次譯文裡《 的總數、有多少個連結 segment 被《》包住（A 組才有 segment 可對）。
// 送出的批次文字與模型原始回覆用包住 chrome.runtime.sendMessage 的方式留底（OUT_JSON）。
//
// 驗的層次：模型對同一份提示 + 同一批文字的實際輸出。不驗：渲染結果、其他模型 / 其他目標語言。
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXT = process.env.SK_EXT_PATH || path.join(ROOT, 'shinkansen');
const PDF = process.env.PDF_PATH;
const PAGES = String(process.env.PAGE || '1').split(',').map((v) => Number(v.trim())).filter(Boolean);
const RUNS = Number(process.env.RUNS || '3');
const BATCH = Number(process.env.BATCH || '50');   // 每批段數；UI 預設 50（translateDoc.batchSize）
const GROUPS = (process.env.GROUPS || 'A,B').split(',');
const OUT_JSON = process.env.OUT_JSON;
const KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
if (!PDF) { console.error('請設 PDF_PATH'); process.exit(1); }

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio'],
});
try {
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = worker.url().split('/')[2];
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((apiKey) => new Promise((res) => chrome.storage.local.set({ apiKey }, res)), KEY);
  await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dropzone', { state: 'visible' });
  await page.setInputFiles('#file-input', PDF);
  await page.waitForFunction(() => {
    const r = document.getElementById('stage-result');
    return r && !r.hidden;
  }, null, { timeout: 120000, polling: 250 });

  const result = await page.evaluate(async ({ pageIdxs, runs, batchSize, groups }) => {
    const T = await import(chrome.runtime.getURL('translate-doc/translate.js'));
    const log = [];
    const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (msg, ...rest) => {
      const resp = await realSend(msg, ...rest);
      if (msg && /^TRANSLATE_DOC_BATCH/.test(msg.type || '')) {
        log.push({ texts: msg.payload.texts, result: resp && resp.result, model: resp && resp.model, error: resp && resp.error });
      }
      return resp;
    };
    const cloneBlocks = (stripLinks, pageIdx) => window.__skLayoutDoc.pages[pageIdx].blocks.map((b) => {
      const c = JSON.parse(JSON.stringify(b));
      if (stripLinks) {
        c.linkUrls = [];
        for (const s of c.styleSegments || []) s.linkUrl = null;
      }
      return c;
    });
    const out = [];
    for (const group of groups) {
      for (let r = 0; r < runs; r++) {
        const doc = { pages: pageIdxs.map((pageIdx) => ({ pageIndex: pageIdx, blocks: cloneBlocks(group === 'B', pageIdx) })) };
        await T.clearTcCacheForDoc(doc);
        const before = log.length;
        await T.translateDocument(doc, { batchSize });
        const blocks = doc.pages.flatMap((p) => p.blocks);
        let linkSegs = 0, wrapped = 0, marks = 0, failed = 0;
        const samples = [];
        for (const b of blocks) {
          if (b.translationStatus === 'failed') failed++;
          marks += ((b.translation || '').match(/《/g) || []).length;
          const segs = b.translationSegments || [];
          for (let i = 0; i < segs.length; i++) {
            if (!segs[i].linkUrl) continue;
            linkSegs++;
            const prev = i > 0 ? segs[i - 1].text : '';
            const next = i + 1 < segs.length ? segs[i + 1].text : '';
            const inside = /^《.*》$/.test(segs[i].text.trim());
            const outside = /《\s*$/.test(prev) && /^\s*》/.test(next);
            if (inside || outside) { wrapped++; if (samples.length < 6) samples.push((outside ? '《' : '') + segs[i].text + (outside ? '》' : '')); }
          }
        }
        out.push({ group, run: r + 1, blocks: blocks.length, failed, marks, linkSegs, wrapped, samples,
          rawMarksInside: log.slice(before).flatMap((x) => x.result || []).join('\n').match(/⟦l:\d+⟧《/g)?.length || 0,
          rawMarksOutside: log.slice(before).flatMap((x) => x.result || []).join('\n').match(/《⟦l:\d+⟧/g)?.length || 0 });
      }
    }
    return { out, log };
  }, { pageIdxs: PAGES.map((n) => n - 1), runs: RUNS, batchSize: BATCH, groups: GROUPS });

  for (const r of result.out) {
    console.log(`${r.group} 組第 ${r.run} 次：block ${r.blocks}（失敗 ${r.failed}）、譯文《 共 ${r.marks} 個`
      + (r.group === 'A' ? `、連結 ${r.linkSegs} 個其中被《》包住 ${r.wrapped} 個（原始回覆：標記內 ${r.rawMarksInside}、標記外 ${r.rawMarksOutside}）` : ''));
    if (r.samples.length) console.log('   例：' + r.samples.join('、'));
  }
  if (OUT_JSON) { fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 1)); console.log('原始批次已存', OUT_JSON); }
} finally {
  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
