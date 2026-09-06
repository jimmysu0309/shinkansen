#!/usr/bin/env node
// Shinkansen PDF 頁面結構核對 harness
//
// 用途:把 docs/excluded/test pdf/ 下每份 PDF 跑一輪「英文當譯文填回」流程,
// 對每份輸出結構診斷 + 重生成 PDF 重 parse 驗證頁數 + 文字 run 數量。
// 不需要真的呼叫 Gemini API,純結構驗證。
//
// 用法:
//   node tools/harness/pdf-structure-verify.js                 # 跑全部 PDF
//   node tools/harness/pdf-structure-verify.js --only Plano    # 只跑檔名含 Plano 的 PDF
//
// 輸出:
//   .playwright-mcp/pdf-structure-verify-report.md  人類可讀報告
//   .playwright-mcp/pdf-structure-verify-raw.json   raw 結果 JSON
//
// 機制:
//   - 上傳 PDF 到 chrome-extension://.../translate-doc/index.html UI
//   - 等 stage-result 出現,doc 已寫進 module-scope currentDoc
//   - 透過 window.__skVerify dev hook(只在 translate-doc 頁存在)觸發:
//     a) computeStructureDiagnostics — 直接驗 doc IR 內每 block 的 bbox /
//        reader overlay % / fontSize / plainText 是否合法
//     b) injectPlainTextAsTranslation — 把每個 translatable block.plainText
//        當成 translation 灌進去
//     c) generateAndVerifyPdf — 攔截 downloadBilingualPdf 的 PDF bytes,
//        用 PDF.js 重新 parse 驗 numPages + 每頁 textRun 數量

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXT_PATH = path.join(REPO_ROOT, 'shinkansen');
const PDF_DIR = path.join(REPO_ROOT, 'docs/excluded/test pdf');
const OUT_DIR = path.join(REPO_ROOT, '.playwright-mcp');
const REPORT_PATH = path.join(OUT_DIR, 'pdf-structure-verify-report.md');
const RAW_PATH = path.join(OUT_DIR, 'pdf-structure-verify-raw.json');

const onlyArgIdx = process.argv.indexOf('--only');
const ONLY_FILTER = onlyArgIdx >= 0 ? process.argv[onlyArgIdx + 1] : null;
const PARSE_TIMEOUT_MS = 90_000;
const VERIFY_TIMEOUT_MS = 240_000; // 重大 PDF 生成 + 字型 subset 可能要一陣子
const HEADED = process.env.SHINKANSEN_HEADED === '1';

async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`找不到 PDF 目錄:${PDF_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

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
  pdfs.sort();

  console.log(`[harness] ${pdfs.length} PDF(s) to verify`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-verify-'));
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
  page.on('pageerror', (err) => console.log(`PAGE[error]> ${err.message}`));
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dropzone', { state: 'visible' });

  const results = [];

  for (const pdfPath of pdfs) {
    const baseName = path.basename(pdfPath);
    consoleErrors.length = 0;
    console.log(`\n[verify] ${baseName}`);
    const result = { filename: baseName, status: 'pending' };

    try {
      // 切回 stage-upload(若上一輪卡在 result/reader/debug)
      await resetToUploadStage(page);

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
        { timeout: PARSE_TIMEOUT_MS, polling: 250 },
      ).catch(() => null);

      if (!reachedStage) {
        result.status = 'parse-timeout';
        results.push(result);
        continue;
      }
      const stage = await reachedStage.jsonValue();
      if (stage === 'error') {
        const errMsg = await page.$eval('#upload-error', (e) => e.textContent.trim());
        result.status = 'parse-error';
        result.error = errMsg;
        results.push(result);
        console.log(`  [skip] ${errMsg}`);
        continue;
      }

      // 1) doc 概況
      const docMeta = await page.evaluate(() => {
        const d = window.__skLayoutDoc;
        if (!d) return null;
        return {
          pageCount: d.pages.length,
          totalBlocks: d.pages.reduce((s, p) => s + p.blocks.length, 0),
          totalRuns: d.stats?.totalRuns || 0,
          totalChars: d.stats?.totalChars || 0,
          warnings: d.warnings || [],
        };
      });
      result.doc = docMeta;
      console.log(`  pages=${docMeta.pageCount} blocks=${docMeta.totalBlocks} runs=${docMeta.totalRuns} chars=${docMeta.totalChars}`);

      // 2) 結構診斷(批次 8 G6:verify harness 改 lazy install,先載 dev-verify.js)
      await page.evaluate(() => window.__skInstallVerify());
      const struct = await page.evaluate(() => window.__skVerify.computeStructureDiagnostics());
      result.structure = struct;
      console.log(`  structure issues: ${struct.issueCount}`);
      if (struct.issueCount > 0) {
        const codeCounts = {};
        for (const it of struct.issues) codeCounts[it.code] = (codeCounts[it.code] || 0) + 1;
        console.log(`    by code: ${Object.entries(codeCounts).map(([c, n]) => `${c}:${n}`).join(' ')}`);
      }

      // 3) 灌 fake translation
      const inject = await page.evaluate(() => window.__skVerify.injectPlainTextAsTranslation());
      result.injected = inject;
      console.log(`  injected ${inject.translatableCount} translatable blocks`);

      // 4) 加強版核對:bold preservation + link preservation + overflow
      const enhanced = await page.evaluate(
        () => Promise.race([
          window.__skVerify.runEnhancedVerify(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('enhanced-verify-timeout')), 230_000)),
        ]),
      ).catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));

      result.enhanced = enhanced;
      if (!enhanced.ok) {
        console.log(`  [enhanced-fail] ${enhanced.error}`);
      } else {
        console.log(`  pdf=${(enhanced.generatedByteLength / 1024).toFixed(0)}KB`);
        console.log(`  bold: ${enhanced.bold.preservedCount}/${enhanced.bold.totalBoldBlocks} preserved (${enhanced.bold.lostCount} lost)`);
        console.log(`  links: ${enhanced.links.preservedCount}/${enhanced.links.totalLinks} preserved (${enhanced.links.lostCount} lost)`);
        console.log(`  overflow risk: ${enhanced.overflow.riskCount}/${enhanced.overflow.totalChecked} blocks (en=${enhanced.overflow.englishOverflowCount} cjk=${enhanced.overflow.cjkOverflowCount} tight=${enhanced.overflow.tightHeightCount})`);
        console.log(`  actual overflow: ${enhanced.overflow.actualOverflowCount}/${enhanced.overflow.totalChecked} blocks render past bbox`);
      }

      // 5) 蒐集 console errors(過濾掉 favicon 噪音)
      const filteredErrors = consoleErrors.filter((e) =>
        !e.includes('favicon') &&
        !e.includes('chrome-extension://') === false || true);
      if (filteredErrors.length > 0) {
        result.consoleErrors = filteredErrors.slice(0, 10);
      }

      result.status = 'ok';
    } catch (err) {
      console.error(`  [error] ${err.message}`);
      result.status = 'exception';
      result.error = err.message;
    }
    results.push(result);
  }

  await context.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // 寫報告
  fs.writeFileSync(RAW_PATH, JSON.stringify(results, null, 2), 'utf-8');
  fs.writeFileSync(REPORT_PATH, buildReport(results), 'utf-8');
  console.log(`\n[report] ${path.relative(REPO_ROOT, REPORT_PATH)}`);
  console.log(`[raw]    ${path.relative(REPO_ROOT, RAW_PATH)}`);

  // exit code:任何 structure issue / enhanced fail / bold-lost / link-lost / overflow > 0 → 1
  let bad = 0;
  for (const r of results) {
    if (r.status !== 'ok') bad++;
    else if (r.structure?.issueCount > 0) bad++;
    else if (r.enhanced && !r.enhanced.ok) bad++;
    else if (r.enhanced?.bold?.lostCount > 0) bad++;
    else if (r.enhanced?.links?.lostCount > 0) bad++;
    else if (r.enhanced?.overflow?.actualOverflowCount > 0) bad++;
  }
  if (bad > 0) {
    console.log(`\n${bad} / ${results.length} PDF(s) have issues. See report.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} PDF(s) verified clean.`);
  }
}

async function resetToUploadStage(page) {
  const inUpload = await page.$eval('#stage-upload', (el) => !el.hidden).catch(() => false);
  if (inUpload) return;
  for (const sel of ['#reupload-btn', '#reader-reupload-btn', '#cancel-btn', '#debug-back-btn']) {
    const btn = await page.$(sel);
    if (btn) {
      const visible = await btn.evaluate((el) => {
        for (let n = el; n; n = n.parentElement) {
          if (n.hasAttribute && n.hasAttribute('hidden')) return false;
        }
        return true;
      }).catch(() => false);
      if (visible) {
        await btn.click().catch(() => {});
        await page.waitForSelector('#stage-upload:not([hidden])', { timeout: 5000 }).catch(() => {});
        return;
      }
    }
  }
}

function buildReport(results) {
  const lines = [];
  lines.push('# Shinkansen PDF Structure Verify Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total PDFs: ${results.length}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| File | Status | Pages | Blocks | Issues | PDF | Bold lost | Links lost | Overflow |');
  lines.push('|------|--------|-------|--------|--------|-----|-----------|------------|----------|');
  for (const r of results) {
    const status = r.status;
    const pages = r.doc?.pageCount ?? '-';
    const blocks = r.doc?.totalBlocks ?? '-';
    const issues = r.structure?.issueCount ?? '-';
    const e = r.enhanced;
    const pdf = e?.ok ? `${(e.generatedByteLength / 1024).toFixed(0)}KB` : (e?.error ? `FAIL: ${e.error.slice(0, 30)}` : '-');
    const boldLost = e?.bold ? `${e.bold.lostCount}/${e.bold.totalBoldBlocks}` : '-';
    const linksLost = e?.links ? `${e.links.lostCount}/${e.links.totalLinks}` : '-';
    const overflow = e?.overflow ? `${e.overflow.riskCount}/${e.overflow.totalChecked} (act=${e.overflow.actualOverflowCount})` : '-';
    const fname = r.filename.length > 45 ? r.filename.slice(0, 42) + '...' : r.filename;
    lines.push(`| ${fname.replace(/\|/g, '\\|')} | ${status} | ${pages} | ${blocks} | ${issues} | ${pdf} | ${boldLost} | ${linksLost} | ${overflow} |`);
  }
  lines.push('');

  // Detailed sections
  lines.push('## Details');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.filename}`);
    lines.push('');
    if (r.status !== 'ok') {
      lines.push(`**Status: ${r.status}**`);
      if (r.error) lines.push(`Error: ${r.error}`);
      lines.push('');
      continue;
    }
    if (r.doc) {
      lines.push(`- doc: ${r.doc.pageCount} pages, ${r.doc.totalBlocks} blocks, ${r.doc.totalRuns} runs, ${r.doc.totalChars} chars`);
      if (r.doc.warnings.length > 0) {
        lines.push(`- warnings: ${r.doc.warnings.map((w) => w.code).join(', ')}`);
      }
    }
    if (r.injected) {
      lines.push(`- injected ${r.injected.translatableCount} translatable blocks`);
    }
    if (r.structure && r.structure.issueCount > 0) {
      const codeCounts = {};
      for (const it of r.structure.issues) codeCounts[it.code] = (codeCounts[it.code] || 0) + 1;
      lines.push(`- structure issues: ${r.structure.issueCount} total`);
      for (const [code, n] of Object.entries(codeCounts)) {
        lines.push(`  - ${code}: ${n}`);
      }
      lines.push('');
      lines.push('  Sample issues:');
      for (const issue of r.structure.issues.slice(0, 8)) {
        lines.push(`  - p${issue.pageIndex} ${issue.blockId} \`${issue.code}\` ${issue.detail}`);
      }
    } else if (r.structure) {
      lines.push(`- structure: clean`);
    }
    if (r.enhanced) {
      const e = r.enhanced;
      if (!e.ok) {
        lines.push(`- enhanced verify FAILED: ${e.error}`);
      } else {
        lines.push(`- pdf: ${(e.generatedByteLength / 1024).toFixed(0)}KB, ${e.totalBlocks} blocks analysed`);
        // Bold
        lines.push(`- bold preservation: ${e.bold.preservedCount} / ${e.bold.totalBoldBlocks} preserved (${e.bold.lostCount} lost)`);
        if (e.bold.lostCount > 0) {
          for (const b of e.bold.lostBlocks.slice(0, 8)) {
            lines.push(`    - p${b.pageIndex} ${b.blockId} ${b.type} fs=${b.fontSize} origBoldRatio=${b.originalBoldRatio} overlayBoldRatio=${b.overlayBoldRatio} (overlayChars=${b.overlayChars}): "${b.plainTextPreview.replace(/[\r\n]/g, ' ')}"`);
          }
          if (e.bold.lostCount > 8) lines.push(`    ...${e.bold.lostCount - 8} more`);
        }
        // Links
        lines.push(`- link preservation: ${e.links.preservedCount} / ${e.links.totalLinks} preserved (${e.links.lostCount} lost)`);
        if (e.links.lostCount > 0) {
          for (const L of e.links.lostLinks.slice(0, 8)) {
            lines.push(`    - p${L.pageIndex} url=${L.url || '(dest)'} rect=[${L.rect.map((n) => n.toFixed(1)).join(',')}]`);
          }
          if (e.links.lostCount > 8) lines.push(`    ...${e.links.lostCount - 8} more`);
        }
        // Overflow risk(靜態:若 pdf-renderer 不縮字會炸的 block)
        lines.push(`- overflow risk(static): ${e.overflow.riskCount} / ${e.overflow.totalChecked} blocks (en=${e.overflow.englishOverflowCount} cjk=${e.overflow.cjkOverflowCount} tight=${e.overflow.tightHeightCount})`);
        if (e.overflow.riskCount > 0) {
          for (const o of e.overflow.worstRisk.slice(0, 5)) {
            const tags = [];
            if (o.englishOverflow > 1) tags.push(`en+${o.englishOverflow}`);
            if (o.cjkOverflow > 1) tags.push(`cjk+${o.cjkOverflow}`);
            if (o.isTightHeight) tags.push('tight');
            lines.push(`    - p${o.pageIndex} ${o.blockId} ${o.type} fs=${o.fontSize} blockH=${o.blockH} blockW=${o.blockW} enLines=${o.englishLines} cjkLines=${o.cjkLines} [${tags.join(',')}]`);
          }
          if (e.overflow.riskCount > 5) lines.push(`    ...${e.overflow.riskCount - 5} more`);
        }
        // Actual overflow(動態:實際 render 後 overlay 真的超出 block bbox)
        lines.push(`- overflow actual(render): ${e.overflow.actualOverflowCount} / ${e.overflow.totalChecked} blocks render past bbox`);
        if (e.overflow.actualOverflowCount > 0) {
          for (const o of e.overflow.actualOverflowSamples.slice(0, 5)) {
            lines.push(`    - p${o.pageIndex} ${o.blockId} ${o.type} fs=${o.fontSize} blockH=${o.blockH} maxBottom=${o.maxBottom} +${o.actualOverflow}pt overlayChars=${o.overlayChars}`);
          }
          if (e.overflow.actualOverflowCount > 5) lines.push(`    ...${e.overflow.actualOverflowCount - 5} more`);
        }
      }
    }
    if (r.consoleErrors && r.consoleErrors.length > 0) {
      lines.push(`- console errors:`);
      for (const e of r.consoleErrors) lines.push(`  - ${e.slice(0, 200)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
