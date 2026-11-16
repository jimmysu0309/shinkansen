#!/usr/bin/env node
// probe-pdf-columns.mjs — 指定 PDF 某一頁的欄位偵測中間數值
//
// 用法：
//   PDF_PATH=<pdf> PAGE=13 node tools/probes/probe-pdf-columns.mjs            # PAGE 為 1-based，可逗號分隔多頁
//   RAW_JSON=<先前存的原始頁 json> node tools/probes/probe-pdf-columns.mjs     # 不開瀏覽器，直接重算
//   SK_EXT_PATH=<擴充功能副本> …                                             # 對照改動前版本
//
// 做法：瀏覽器裡用真實 pdf-engine 解析拿到該頁原始 textRuns（window.__skKeepRawPages），存成
// json；再把 layout-analyzer.js 複製一份、補上內部函式的 export，在 node 裡重跑「行分組 →
// 欄位偵測」並印出每個 k 的群中心、各群行數、silhouette、被哪條邊界擋掉，以及每個視覺列的
// 行數與左緣。layout-analyzer.js 沒有 import，可以直接在 node 執行。
//
// 驗的層次：欄位偵測的輸入與判斷數值。不驗：渲染結果（走 pdf-corpus / 真翻譯）。
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXT = process.env.SK_EXT_PATH || path.join(ROOT, 'shinkansen');
const PDF = process.env.PDF_PATH;
const PAGES = String(process.env.PAGE || '1').split(',').map((v) => Number(v.trim())).filter(Boolean);   // 1-based，可逗號分隔多頁
const RAW_JSON = process.env.RAW_JSON;
const OUT_RAW = process.env.OUT_RAW;      // 選填：把原始頁存到這裡（之後可用 RAW_JSON 重算）
const VERBOSE = process.env.VERBOSE === '1';

async function fetchRawPage() {
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
    await page.addInitScript(() => { window.__skKeepRawPages = true; });
    await page.goto(`chrome-extension://${extId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dropzone', { state: 'visible' });
    await page.setInputFiles('#file-input', PDF);
    await page.waitForFunction(() => {
      const r = document.getElementById('stage-result');
      return r && !r.hidden;
    }, null, { timeout: 120000, polling: 250 });
    return await page.evaluate((idxs) => idxs.map((idx) => {
      const d = window.__skLayoutDoc;
      const raw = d._rawPages[idx];
      const lp = d.pages[idx];
      return {
        pageIndex: raw.pageIndex, viewport: raw.viewport, textRuns: raw.textRuns,
        imageRects: lp.imageRects || [],
        analyzed: {
          columnCount: lp.columnCount,
          blocks: lp.blocks.map((b) => ({
            id: b.blockId, type: b.type, column: b.column, lineCount: b.lineCount,
            bbox: b.bbox.map((v) => Math.round(v)), text: (b.plainText || '').slice(0, 60),
          })),
        },
      };
    }), PAGES.map((n) => n - 1));
  } finally {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function loadAnalyzerInternals() {
  const src = fs.readFileSync(path.join(EXT, 'translate-doc/layout-analyzer.js'), 'utf8');
  const names = ['groupIntoLines', 'mergeLabelValueRows', 'splitLinesAtCellGaps', 'absorbSupSubLines',
    'markSiblingsInRow', 'detectColumns', 'kmeans1d', 'silhouetteScore', 'minPairwiseGap',
    'COLUMN_MIN_GAP_RATIO', 'MIN_COLUMN_LINE_RATIO', 'SILHOUETTE_BIAS_TO_FEWER_COLUMNS', 'SAME_LINE_Y_TOLERANCE'];
  const present = names.filter((n) => new RegExp(`(function|const)\\s+${n}\\b`).test(src));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-la-')), 'layout-analyzer.mjs');
  fs.writeFileSync(tmp, `${src}\nexport const __internals = { ${present.join(', ')} };\n`);
  const mod = await import(pathToFileURL(tmp).href);
  return { ...mod, ...mod.__internals };
}

const r1 = (v) => Math.round(v * 10) / 10;

let rawPages = RAW_JSON ? JSON.parse(fs.readFileSync(RAW_JSON, 'utf8')) : await fetchRawPage();
if (!Array.isArray(rawPages)) rawPages = [rawPages];
if (OUT_RAW) { fs.writeFileSync(OUT_RAW, JSON.stringify(rawPages)); console.log('原始頁已存', OUT_RAW); }

const A = await loadAnalyzerInternals();
for (const raw of rawPages) {
  const runs = raw.textRuns.slice();
  const heights = runs.map((r) => r.bbox[3] - r.bbox[1]).filter((h) => h > 0).sort((a, b) => a - b);
  const mlh = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
  const pageWidth = raw.viewport.width;
  let lines = A.groupIntoLines(runs, mlh);
  lines = A.mergeLabelValueRows(lines, mlh);
  lines = A.splitLinesAtCellGaps(lines, mlh);
  lines = A.absorbSupSubLines(lines, mlh);
  A.markSiblingsInRow(lines, mlh);

  console.log(`\n頁 ${raw.pageIndex + 1}：寬 ${r1(pageWidth)}、行高中位數 ${r1(mlh)}、runs ${runs.length}、lines ${lines.length}`);

  const xs = lines.map((l) => l.bbox[0]);
  for (let k = 1; k <= 3; k++) {
    const res = A.kmeans1d(xs, k);
    if (!res) { console.log(`k=${k}：分不出（null）`); continue; }
    const counts = new Array(k).fill(0);
    for (const a of res.assignment) counts[a]++;
    const minGap = pageWidth * A.COLUMN_MIN_GAP_RATIO * (2 / k);
    const gap = k > 1 ? A.minPairwiseGap(res.centers) : 0;
    const minRatio = Math.min(...counts) / xs.length;
    const score = k === 1 ? 0 : A.silhouetteScore(xs, res.assignment, res.centers);
    const blocked = [];
    if (k > 1 && gap < minGap) blocked.push(`中心間距 ${r1(gap)} < ${r1(minGap)}`);
    if (k > 1 && minRatio < A.MIN_COLUMN_LINE_RATIO) blocked.push(`最小群佔比 ${r1(minRatio * 100)}% < ${A.MIN_COLUMN_LINE_RATIO * 100}%`);
    console.log(`k=${k}：中心 [${res.centers.map(r1).sort((a, b) => a - b).join(', ')}] 行數 [${counts.join(', ')}] silhouette ${score.toFixed(3)} ${blocked.length ? '✗ ' + blocked.join('；') : '✓ 候選'}`);
  }
  const chosen = A.detectColumns(lines, pageWidth, mlh);
  console.log(`→ 選定 ${chosen.columnCount} 欄，中心 [${chosen.centers.map(r1).join(', ')}]${chosen.tableLike ? `（表格列佔比 ${r1(chosen.tableRatio * 100)}%，不分欄）` : ''}`);
  if (chosen.debug) console.log('  debug:', JSON.stringify(chosen.debug));

  // 視覺列：top 相近的 line 歸同一列，印每列的行數與左緣
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].bbox[1] - lines[b].bbox[1]);
  const rows = [];
  for (const i of order) {
    const l = lines[i];
    const last = rows[rows.length - 1];
    if (last && Math.abs(l.bbox[1] - last.top) <= A.SAME_LINE_Y_TOLERANCE) last.items.push(i);
    else rows.push({ top: l.bbox[1], items: [i] });
  }
  const multi = rows.filter((r) => r.items.length >= 2).length;
  console.log(`視覺列 ${rows.length}，其中含 ≥2 條 line 的列 ${multi}（${r1(multi / rows.length * 100)}%）`);
  if (VERBOSE) {
    for (const r of rows) {
      const cells = r.items.sort((a, b) => lines[a].bbox[0] - lines[b].bbox[0])
        .map((i) => `[c${chosen.assignment[i]} x${Math.round(lines[i].bbox[0])}-${Math.round(lines[i].bbox[2])}] ${(lines[i].plainText || '').slice(0, 28)}`);
      console.log(`  y${Math.round(r.top)}  ${cells.join('  |  ')}`);
    }
  }
  if (raw.analyzed) {
    console.log(`瀏覽器內實際分析：${raw.analyzed.columnCount} 欄、${raw.analyzed.blocks.length} 個 block`);
    if (VERBOSE) for (const b of raw.analyzed.blocks) console.log(`  ${b.id} ${b.type} col${b.column} ln${b.lineCount} [${b.bbox.join(',')}] ${b.text}`);
  }
}
