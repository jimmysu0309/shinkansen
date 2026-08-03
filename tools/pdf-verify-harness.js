// Shinkansen PDF 翻譯驗收 harness — batch 跑 reference PDF set + 集中輸出視覺驗收 material
//
// 為什麼有這個檔(跟 pdf-layout-harness.js 不同):
//   - pdf-layout-harness.js 跑單一 PDF,每次要 PDF_PATH=... 切 reference 跑很多次
//   - 改 PDF 路徑(layout-analyzer / pdf-renderer / pdf-engine / translate-doc)後,
//     CLAUDE.md 規定必走 self-verify(harness --translate + Read 譯文 PDF + Plano regression)
//   - 本 harness 把整套 reference PDF 一次跑完,輸出集中在
//     `docs/excluded/test pdf/<日期> test pdf output/<name>/translated.pdf` + `page-{i}.png`,
//     人/Claude 一次 Read 全部譯文 PDF,不必逐個 PDF 重跑 harness
//
// 不取代視覺驗收!只省「準備 verification material」的時間,
// 「Read 譯文 PDF + 視覺判斷」仍是人/Claude 動作(canvas 在低 zoom 下會騙人,
// 必須 Read PDF 才是 ground truth — 見 CLAUDE.md PDF 翻譯改動必走自驗流程)
//
// 用法:
//   npm run pdf-verify                     # default reference set(Plano + Quotation + Trimble)
//   npm run pdf-verify -- --only Plano     # 只跑檔名含 Plano 的
//   npm run pdf-verify -- --all            # 跑 docs/excluded/test pdf/ 全部
//   SHINKANSEN_HEADED=1 npm run pdf-verify # 顯示 chromium 視窗 debug
//
// 輸出:
//   docs/excluded/test pdf/<YYYY-MM-DD> test pdf output/<name>/translated.pdf  譯文 PDF(ground truth)
//   docs/excluded/test pdf/<YYYY-MM-DD> test pdf output/<name>/page-{i}.png     reader canvas 截圖(輔助)
//   docs/excluded/test pdf/<YYYY-MM-DD> test pdf output/MANIFEST.md             待驗收清單
//
// 前置:
//   ~/.shinkansen-test-key 必須存在(40 chars Gemini key,chmod 600,不進 repo)
//   不存在會直接 exit 1,因為 batch 跑沒 key 沒意義

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO_ROOT, 'shinkansen');
const PDF_DIR = path.join(REPO_ROOT, 'docs/excluded/test pdf');
// 輸出到測試 PDF 同層的日期目錄(2026-08-03 Jimmy 指定慣例:測試譯文輸出一律放
// `docs/excluded/test pdf/<YYYY-MM-DD> test pdf output/`,同日多次執行覆寫同目錄)。
// docs/excluded 整層 .gitignore,不入 repo
const RUN_DATE = new Date().toISOString().slice(0, 10);
const OUT_ROOT = path.join(PDF_DIR, `${RUN_DATE} test pdf output`);

// Default reference set:歷史翻車過或結構代表性的 case(CLAUDE.md / v1.8.46 紅字)
//   - Plano:    layout-analyzer 改後字身被切第二層 bug(pdf-renderer mask 順序)
//   - Quotation:表格邊線缺/殘影,canvas 看不清必須 Read PDF
//   - Trimble:  owner-password + AESv2 加密 PDF(v1.8.46 換 @cantoo/pdf-lib fork 修)
//
// 用 case-insensitive substring 模糊匹配檔名(實際檔名很長,改名常見)
const DEFAULT_REFERENCE_KEYWORDS = ['Plano', 'Quotation', 'Trimble'];

// 重點檢查項目 — 給 manifest 提醒人/Claude 要看哪些位置(基於歷史 bug)
const REGRESSION_HINTS = {
  Plano: '字身完整(無被切上下緣),mask 矩形覆蓋範圍 ≥ font ascender / descender',
  Quotation: '表格邊線完整(無缺/殘影),格內譯文不溢格',
  Trimble: '加密 PDF 仍能成功下載譯文 PDF(不退 EncryptedPDFError)',
};

const HEADED = process.env.SHINKANSEN_HEADED === '1';
const onlyArgIdx = process.argv.indexOf('--only');
const ONLY_KEYWORD = onlyArgIdx >= 0 ? process.argv[onlyArgIdx + 1] : null;
const RUN_ALL = process.argv.includes('--all');

const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');
if (!fs.existsSync(KEY_PATH)) {
  console.error('錯誤:~/.shinkansen-test-key 不存在 — batch verify 必須有 key');
  console.error('  echo "<your-gemini-key>" > ~/.shinkansen-test-key && chmod 600 ~/.shinkansen-test-key');
  process.exit(1);
}
const TEST_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();

if (!fs.existsSync(PDF_DIR)) {
  console.error(`錯誤:reference PDF 目錄不存在:${PDF_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
  console.error(`錯誤:找不到 extension manifest:${EXT_PATH}/manifest.json`);
  process.exit(1);
}

const PARSE_TIMEOUT_MS = 60_000;
const TRANSLATE_TIMEOUT_MS = 10 * 60_000;
const READER_CANVAS_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// 把 PDF 檔名轉成可當目錄的 sanitized 名(去 .pdf、空白變 _、其他特殊字元 strip)
function sanitizeName(filename) {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[^\w一-鿿\-._]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// 找符合 keyword 的 PDF 檔名(case-insensitive substring match,回首個命中)
function findPdfByKeyword(allFiles, keyword) {
  const lower = keyword.toLowerCase();
  return allFiles.find((f) => f.toLowerCase().includes(lower)) || null;
}

function selectReferenceFiles() {
  const allFiles = fs.readdirSync(PDF_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'));

  if (RUN_ALL) {
    return allFiles.map((f) => ({ keyword: '(all)', filename: f }));
  }

  const keywords = ONLY_KEYWORD ? [ONLY_KEYWORD] : DEFAULT_REFERENCE_KEYWORDS;
  const result = [];
  for (const kw of keywords) {
    const filename = findPdfByKeyword(allFiles, kw);
    if (filename) {
      result.push({ keyword: kw, filename });
    } else {
      console.warn(`警告:keyword "${kw}" 沒找到匹配 PDF,跳過`);
    }
  }
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processOnePdf(context, extensionId, pdfFilename, outDir) {
  const pdfFullPath = path.join(PDF_DIR, pdfFilename);
  const result = {
    filename: pdfFilename,
    outDir,
    status: 'pending',
    error: null,
    canvasCount: 0,
    pdfDownloaded: false,
    elapsed: 0,
  };

  const t0 = Date.now();
  const page = await context.newPage();

  // page console 透傳 stdout 方便診斷
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning' || /Shinkansen/.test(msg.text())) {
      console.log(`  PAGE[${t}]>`, msg.text().slice(0, 200));
    }
  });
  page.on('pageerror', (err) => console.log('  PAGE[error]>', err.message));

  try {
    const url = `chrome-extension://${extensionId}/translate-doc/index.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dropzone', { state: 'visible', timeout: 10_000 });

    await page.setInputFiles('#file-input', pdfFullPath);

    // 等版面解析完成(stage-result 顯示 / error 顯示)
    const stageState = await page.waitForFunction(
      () => {
        const stageResult = document.getElementById('stage-result');
        const errEl = document.getElementById('upload-error');
        if (stageResult && !stageResult.hidden) return 'result';
        if (errEl && !errEl.hidden && errEl.textContent.trim()) return 'error';
        return false;
      },
      null,
      { timeout: PARSE_TIMEOUT_MS, polling: 250 }
    );
    const state = await stageState.jsonValue();
    if (state === 'error') {
      const errMsg = await page.evaluate(() => {
        const errEl = document.getElementById('upload-error');
        return errEl ? errEl.textContent.trim() : '(unknown error)';
      });
      throw new Error(`解析錯誤:${errMsg}`);
    }

    // 點翻譯按鈕,等 stage-reader 顯示(reader 模式 = 翻譯完成)
    await page.click('#translate-btn');
    await page.waitForSelector('#stage-reader:not([hidden])', { timeout: TRANSLATE_TIMEOUT_MS });

    // 等所有譯文 canvas render 完成(reader.js 寫好 dataset.baseHeight 才能信)
    await page.waitForFunction(
      () => {
        const ps = Array.from(document.querySelectorAll('.reader-page-translated'));
        if (ps.length === 0) return false;
        return ps.every((p) => {
          const c = p.querySelector('canvas');
          return c && c.width > 100 && c.height > 100 && p.dataset.baseHeight;
        });
      },
      { timeout: READER_CANVAS_TIMEOUT_MS, polling: 250 }
    );

    // 抓 canvas screenshot — 只抓譯文頁(原稿頁人/Claude 用不到驗收)
    const canvasDataUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.reader-page-translated canvas'))
        .map((c) => c.toDataURL('image/png'));
    });
    for (let i = 0; i < canvasDataUrls.length; i++) {
      const b64 = canvasDataUrls[i].replace(/^data:image\/png;base64,/, '');
      const shotPath = path.join(outDir, `page-${i + 1}.png`);
      fs.writeFileSync(shotPath, Buffer.from(b64, 'base64'));
    }
    result.canvasCount = canvasDataUrls.length;

    // 攔下載按鈕觸發的譯文 PDF — 這是視覺驗收 ground truth
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
      await page.click('#reader-download-pdf-btn');
      const download = await downloadPromise;
      const pdfOutPath = path.join(outDir, 'translated.pdf');
      await download.saveAs(pdfOutPath);
      result.pdfDownloaded = true;
    } catch (err) {
      console.warn(`  譯文 PDF 下載失敗:${err.message}`);
    }

    result.status = 'success';
  } catch (err) {
    result.status = 'failed';
    result.error = err.message;
    // 失敗截圖留證
    try {
      await page.screenshot({ path: path.join(outDir, 'failure.png'), fullPage: true });
    } catch { /* ignore */ }
  } finally {
    result.elapsed = Date.now() - t0;
    await page.close().catch(() => { /* ignore */ });
  }

  return result;
}

function buildManifest(results, runStartedAt) {
  const lines = [];
  lines.push('# PDF Verify Manifest');
  lines.push('');
  lines.push(`執行時間:${new Date(runStartedAt).toISOString()}`);
  lines.push(`reference set:${results.length} 份`);
  lines.push('');

  const successCount = results.filter((r) => r.status === 'success').length;
  const failCount = results.filter((r) => r.status === 'failed').length;
  lines.push(`結果:✅ ${successCount} / ${results.length} 成功${failCount > 0 ? `,❌ ${failCount} 失敗` : ''}`);
  lines.push('');

  if (failCount > 0) {
    lines.push('## ❌ 失敗清單');
    lines.push('');
    for (const r of results) {
      if (r.status !== 'failed') continue;
      lines.push(`- **${r.filename}**:${r.error}`);
      lines.push(`  - 失敗截圖:\`${path.relative(REPO_ROOT, path.join(r.outDir, 'failure.png'))}\``);
    }
    lines.push('');
  }

  lines.push('## ⏭️ 視覺驗收清單(Read 以下 PDF)');
  lines.push('');
  lines.push('> 提醒:CLAUDE.md PDF 翻譯改動必走自驗流程要求 Read 譯文 PDF。');
  lines.push('> canvas screenshot 在低 zoom + disableFontFace render 下細邊線/殘影看不清,');
  lines.push('> Read 下載 PDF 才是 ground truth。');
  lines.push('');
  for (const r of results) {
    if (r.status !== 'success' || !r.pdfDownloaded) continue;
    const pdfPath = path.relative(REPO_ROOT, path.join(r.outDir, 'translated.pdf'));
    lines.push(`- \`${pdfPath}\` ${r.canvasCount} 頁(${(r.elapsed / 1000).toFixed(1)}s)`);
  }
  lines.push('');

  // 重點檢查項目(基於歷史 bug)
  const matchedHints = [];
  for (const [keyword, hint] of Object.entries(REGRESSION_HINTS)) {
    const matched = results.find(
      (r) => r.status === 'success' && r.filename.toLowerCase().includes(keyword.toLowerCase())
    );
    if (matched) {
      matchedHints.push({ keyword, hint, filename: matched.filename });
    }
  }
  if (matchedHints.length > 0) {
    lines.push('## ⚠️ 重點檢查項目(基於歷史 bug)');
    lines.push('');
    for (const { keyword, hint, filename } of matchedHints) {
      lines.push(`- **${keyword}**(\`${filename}\`):${hint}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const referenceFiles = selectReferenceFiles();
  if (referenceFiles.length === 0) {
    console.error('沒有 reference PDF 可跑');
    process.exit(1);
  }

  console.log(`[verify] 跑 ${referenceFiles.length} 份 reference PDF:`);
  for (const r of referenceFiles) {
    console.log(`  - ${r.filename}`);
  }
  console.log('');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-pdf-verify-'));
  console.log('[verify] launch chromium with extension');
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
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  }
  const extensionId = worker.url().split('/')[2];

  // 注入 apiKey 一次,後續所有 PDF 共用
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`, {
    waitUntil: 'domcontentloaded',
  });
  await optionsPage.evaluate((apiKey) => new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ apiKey }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    } catch (err) { reject(err); }
  }), TEST_KEY);
  await optionsPage.close();
  console.log(`[verify] apiKey 已注入(${TEST_KEY.length} chars)`);
  console.log('');

  const runStartedAt = Date.now();
  const results = [];
  for (let i = 0; i < referenceFiles.length; i++) {
    const { filename } = referenceFiles[i];
    const sanitized = sanitizeName(filename);
    const outDir = path.join(OUT_ROOT, sanitized);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`[verify ${i + 1}/${referenceFiles.length}] ${filename}`);
    const result = await processOnePdf(context, extensionId, filename, outDir);
    results.push(result);
    if (result.status === 'success') {
      console.log(`  ✅ ${result.canvasCount} 頁,${result.pdfDownloaded ? '譯文 PDF 已下載' : '⚠️ PDF 下載失敗'}(${(result.elapsed / 1000).toFixed(1)}s)`);
    } else {
      console.log(`  ❌ 失敗:${result.error}(${(result.elapsed / 1000).toFixed(1)}s)`);
    }
    console.log('');
  }

  const manifest = buildManifest(results, runStartedAt);
  const manifestPath = path.join(OUT_ROOT, 'MANIFEST.md');
  fs.writeFileSync(manifestPath, manifest, 'utf-8');

  console.log('========== 跑完 ==========');
  const successCount = results.filter((r) => r.status === 'success').length;
  console.log(`✅ ${successCount} / ${results.length} 成功`);
  console.log(`📋 manifest:${path.relative(REPO_ROOT, manifestPath)}`);
  console.log('');
  console.log('下一步:Read 上述 manifest,逐份 Read 譯文 PDF 視覺驗收');

  await context.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // 任何 PDF 失敗就 exit 非零
  if (successCount < results.length) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
