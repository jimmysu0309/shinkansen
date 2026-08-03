#!/usr/bin/env node
// Shinkansen PDF layout snapshot regression tool
//
// 用途:跑 docs/excluded/test pdf/ 下全部 PDF,對每份輸出 block 結構 snapshot,
// 對比現有 baseline。日後改 layout-analyzer 演算法後跑 `--check`,任何 PDF 結構
// 變動會 flag 出 diff,Jimmy 看 diff 決定接受新行為(`--update`)或拒絕回退。
//
// 用法:
//   node tools/pdf-layout-snapshot.js              # check(預設):跑全部 + 列 diff,有 diff 退 1
//   node tools/pdf-layout-snapshot.js --update     # 用當前結果覆寫 snapshot 為 baseline
//   node tools/pdf-layout-snapshot.js --metrics    # 印 cross-PDF 結構 metrics 表(不寫 snapshot)
//   node tools/pdf-layout-snapshot.js --only Plano # 只跑檔名含 Plano 的 PDF
//
// snapshot 路徑:test/regression/pdf-layout-snapshots/<filename>.json
// snapshot 與 PDF 本身都不進 git(.gitignore 排除):snapshot 的 plainTextPreview
// 含測試 PDF 內文摘錄,測試 PDF 是私人文件,兩者都只在本機維護

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO_ROOT, 'shinkansen');
const PDF_DIR = path.join(REPO_ROOT, 'docs/excluded/test pdf');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'test/regression/pdf-layout-snapshots');

const MODE = process.argv.includes('--update') ? 'update'
  : process.argv.includes('--metrics') ? 'metrics'
  : 'check';
const onlyArgIdx = process.argv.indexOf('--only');
const ONLY_FILTER = onlyArgIdx >= 0 ? process.argv[onlyArgIdx + 1] : null;

const PARSE_TIMEOUT_MS = 90_000;
const HEADED = process.env.SHINKANSEN_HEADED === '1';

function snapshotName(pdfPath) {
  return path.basename(pdfPath).replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
}

function round1(n) { return Math.round((n || 0) * 10) / 10; }
function hash8(s) {
  return crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 8);
}

function buildSnapshot(doc) {
  return {
    filename: doc.meta.filename,
    pageCount: doc.meta.pageCount,
    totalBlocks: doc.pages.reduce((s, p) => s + p.blocks.length, 0),
    pages: doc.pages.map((p) => ({
      pageIndex: p.pageIndex,
      viewport: [Math.round(p.viewport.width), Math.round(p.viewport.height)],
      columnCount: p.columnCount,
      medianLineHeight: round1(p.medianLineHeight),
      bodyFontSize: round1(p.bodyFontSize),
      blocks: p.blocks.map((b) => ({
        blockId: b.blockId,
        type: b.type,
        column: b.column,
        lineCount: b.lineCount,
        fontSize: round1(b.fontSize),
        plainTextHash: hash8(b.plainText),
        plainTextPreview: (b.plainText || '').slice(0, 60),
      })),
    })),
  };
}

function countTypes(blocks) {
  const m = {};
  for (const b of blocks) m[b.type] = (m[b.type] || 0) + 1;
  return m;
}

function diffSnapshot(prev, cur) {
  if (!prev) return { changed: true, lines: ['(new — baseline 不存在)'] };
  const lines = [];
  if (prev.totalBlocks !== cur.totalBlocks) {
    lines.push(`totalBlocks: ${prev.totalBlocks} → ${cur.totalBlocks}`);
  }
  for (let i = 0; i < Math.max(prev.pages.length, cur.pages.length); i++) {
    const a = prev.pages[i], b = cur.pages[i];
    if (!a) { lines.push(`p${i}: (新增頁)`); continue; }
    if (!b) { lines.push(`p${i}: (頁消失)`); continue; }
    const pageDiffs = [];
    if (a.columnCount !== b.columnCount) {
      pageDiffs.push(`column ${a.columnCount}→${b.columnCount}`);
    }
    if (a.blocks.length !== b.blocks.length) {
      pageDiffs.push(`blocks ${a.blocks.length}→${b.blocks.length}`);
    }
    const aTypes = countTypes(a.blocks);
    const bTypes = countTypes(b.blocks);
    for (const t of new Set([...Object.keys(aTypes), ...Object.keys(bTypes)])) {
      if ((aTypes[t] || 0) !== (bTypes[t] || 0)) {
        pageDiffs.push(`${t} ${aTypes[t] || 0}→${bTypes[t] || 0}`);
      }
    }
    // 比 plainTextHash:同 blockId 內容變了的列出來
    const aMap = new Map(a.blocks.map((bb) => [bb.blockId, bb]));
    const bMap = new Map(b.blocks.map((bb) => [bb.blockId, bb]));
    let textChanged = 0;
    for (const [id, ab] of aMap) {
      const bb = bMap.get(id);
      if (bb && ab.plainTextHash !== bb.plainTextHash) textChanged++;
    }
    if (textChanged > 0) pageDiffs.push(`text changed×${textChanged}`);

    if (pageDiffs.length > 0) {
      lines.push(`p${i}: ${pageDiffs.join(', ')}`);
    }
  }
  return { changed: lines.length > 0, lines };
}

function computeMetrics(snapshots) {
  const rows = [];
  for (const s of snapshots) {
    let totalLines = 0;
    let totalBlocks = 0;
    let single = 0;
    let huge = 0;
    let crossCol = 0;
    let empty = 0;
    const typeCount = {};
    for (const p of s.pages) {
      if (p.blocks.length === 0) empty++;
      for (const b of p.blocks) {
        totalBlocks++;
        totalLines += b.lineCount;
        if (b.lineCount === 1) single++;
        if (b.lineCount > 18) huge++;
        // 跨欄 block 用 viewport 寬度比;snapshot 沒存 bbox,跳過(metrics 用 totalLines 已夠)
        typeCount[b.type] = (typeCount[b.type] || 0) + 1;
      }
    }
    rows.push({
      name: s.filename,
      pages: s.pageCount,
      blocks: totalBlocks,
      avgLines: totalBlocks > 0 ? totalLines / totalBlocks : 0,
      singlePct: totalBlocks > 0 ? (single / totalBlocks) : 0,
      hugePct: totalBlocks > 0 ? (huge / totalBlocks) : 0,
      empty,
      types: typeCount,
    });
  }
  return rows;
}

function printMetrics(rows) {
  // 按 single% 排序找 outlier(上下兩端可能切太碎 / 太粗)
  const sortedSingle = rows.slice().sort((a, b) => b.singlePct - a.singlePct);
  console.log('=== Cross-PDF metrics ===');
  console.log('PDF                                                            pages  blocks  avgLn  single%  huge%  empty  types');
  for (const r of rows) {
    const types = Object.entries(r.types).map(([t, n]) => `${t}:${n}`).join(' ');
    const name = r.name.length > 60 ? r.name.slice(0, 57) + '…' : r.name.padEnd(60);
    console.log(`${name}  ${String(r.pages).padStart(5)}  ${String(r.blocks).padStart(6)}  ${r.avgLines.toFixed(1).padStart(5)}  ${(r.singlePct * 100).toFixed(0).padStart(6)}%  ${(r.hugePct * 100).toFixed(0).padStart(4)}%  ${String(r.empty).padStart(5)}  ${types}`);
  }

  console.log('\n=== Outliers (single-line block ratio) ===');
  if (sortedSingle.length > 0) {
    const top = sortedSingle.slice(0, 3);
    const bot = sortedSingle.slice(-3).reverse();
    console.log('high single% (切太碎可能):');
    for (const r of top) console.log(`  ${(r.singlePct * 100).toFixed(0)}%  ${r.name}`);
    console.log('low single% (切太粗可能):');
    for (const r of bot) console.log(`  ${(r.singlePct * 100).toFixed(0)}%  ${r.name}`);
  }

  // 整體 aggregated
  const totalBlocks = rows.reduce((s, r) => s + r.blocks, 0);
  const totalLines = rows.reduce((s, r) => s + r.blocks * r.avgLines, 0);
  const avgSingle = rows.reduce((s, r) => s + r.singlePct, 0) / rows.length;
  const avgHuge = rows.reduce((s, r) => s + r.hugePct, 0) / rows.length;
  console.log(`\n=== Aggregated (${rows.length} PDFs) ===`);
  console.log(`total blocks: ${totalBlocks}`);
  console.log(`avg lines / block: ${(totalLines / totalBlocks).toFixed(2)}`);
  console.log(`avg single% per PDF: ${(avgSingle * 100).toFixed(1)}%`);
  console.log(`avg huge% per PDF: ${(avgHuge * 100).toFixed(1)}%`);
}

async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`找不到 PDF 目錄:${PDF_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  let pdfs = fs.readdirSync(PDF_DIR)
    .filter((f) => /\.pdf$/i.test(f))
    .map((f) => path.join(PDF_DIR, f));
  if (ONLY_FILTER) {
    pdfs = pdfs.filter((p) => path.basename(p).toLowerCase().includes(ONLY_FILTER.toLowerCase()));
    if (pdfs.length === 0) {
      console.error(`--only "${ONLY_FILTER}" 沒匹配任何 PDF`);
      process.exit(1);
    }
  }

  console.log(`mode: ${MODE} · ${pdfs.length} PDF(s)`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-snap-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      ...(HEADED ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = worker.url().split('/')[2];

  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('PAGE[error]>', err.message));
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dropzone', { state: 'visible' });

  const snapshots = [];
  let totalDiffs = 0;

  for (const pdfPath of pdfs) {
    const baseName = path.basename(pdfPath);
    try {
      // 確保在 stage-upload(連續跑時會切到 result 後要按 reupload 回到 upload)
      await page.evaluate(() => {
        const errEl = document.getElementById('upload-error');
        if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
      });
      const inUpload = await page.$eval('#stage-upload', (el) => !el.hidden);
      if (!inUpload) {
        // 嘗試各 stage 的 reupload / cancel 按鈕
        for (const sel of ['#reupload-btn', '#translated-reupload-btn', '#cancel-btn']) {
          const btn = await page.$(sel);
          if (btn) {
            const visible = await btn.evaluate((el) => {
              for (let n = el; n; n = n.parentElement) {
                if (n.hasAttribute && n.hasAttribute('hidden')) return false;
              }
              return true;
            });
            if (visible) { await btn.click().catch(() => {}); break; }
          }
        }
        await page.waitForSelector('#stage-upload:not([hidden])', { timeout: 5000 }).catch(() => {});
      }

      await page.setInputFiles('#file-input', pdfPath);
      const reachedStage = await page.waitForFunction(
        () => {
          const r = document.getElementById('stage-result');
          const errEl = document.getElementById('upload-error');
          if (r && !r.hidden) return 'result';
          if (errEl && !errEl.hidden && errEl.textContent.trim()) return 'error';
          return false;
        },
        null,
        { timeout: PARSE_TIMEOUT_MS, polling: 250 }
      ).catch(() => null);

      if (!reachedStage) {
        console.log(`[timeout] ${baseName}`);
        continue;
      }
      const stageResult = await reachedStage.jsonValue();
      if (stageResult === 'error') {
        const errMsg = await page.$eval('#upload-error', (e) => e.textContent.trim());
        console.log(`[skip] ${baseName}: ${errMsg}`);
        continue;
      }

      const layoutDoc = await page.evaluate(() => window.__skLayoutDoc || null);
      if (!layoutDoc) {
        console.log(`[no-doc] ${baseName}`);
        continue;
      }
      const snapshot = buildSnapshot(layoutDoc);
      snapshots.push(snapshot);

      const snapPath = path.join(SNAPSHOT_DIR, snapshotName(pdfPath));
      if (MODE === 'update') {
        fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
        console.log(`[updated] ${baseName} · ${snapshot.totalBlocks} blocks`);
      } else if (MODE === 'check') {
        const prev = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf-8')) : null;
        const diff = diffSnapshot(prev, snapshot);
        if (diff.changed) {
          totalDiffs++;
          console.log(`[diff] ${baseName}`);
          for (const l of diff.lines) console.log('       ' + l);
        } else {
          console.log(`[same] ${baseName} · ${snapshot.totalBlocks} blocks`);
        }
      } else {
        // metrics-only
        console.log(`[loaded] ${baseName} · ${snapshot.totalBlocks} blocks`);
      }
    } catch (err) {
      console.log(`[error] ${baseName}: ${err.message}`);
    }
  }

  if (MODE === 'metrics') {
    const rows = computeMetrics(snapshots);
    console.log('');
    printMetrics(rows);
  }

  await context.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  if (MODE === 'check') {
    console.log(`\n${totalDiffs} PDF(s) differ from snapshot. snapshots in ${path.relative(REPO_ROOT, SNAPSHOT_DIR)}/`);
    if (totalDiffs > 0) process.exit(1);
  }
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
