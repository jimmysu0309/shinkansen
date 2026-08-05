// Regression: pdf-parse-cancel(§27 批次 4-1「解析中按取消完全無效且留壞 state」bug)
//
// Fixture:spec 內動態生成 50 頁 PDF(vendored pdf-lib node 端 eval UMD;每頁 30 行
// 文字讓 parse 耗時夠長,取消點擊落在 parse in-flight 期間)。
// Bug:parseAbortController 從未被賦值(只有宣告 / abort / 清 null)→ 取消按鈕
// 實際上什麼都停不掉;取消 handler 清 currentOriginalArrayBuffer 後,in-flight 的
// handleFile 繼續跑完 showStage('result') 把取消後的 upload 畫面蓋掉,之後按
// 「開始翻譯」因 !currentOriginalArrayBuffer 卡死在 stage-translating。
// 修法:handleFile generation token(取消 / 新上傳 ++gen,舊輪 resume 後丟棄結果)
// + AbortController 真的接進 parsePdf page loop(取消立即中止 parse)。
//
// 訊號層界定:本 spec 驗「取消後 stage 不被舊輪蓋掉 + 重新上傳可正常解析」這層;
// parsePdf 中途 abort 的 pdfDoc 釋放(4-2 洩漏防護)無法從 DOM 觀測,由
// test/jest-unit/pdf-parse-leak-guards.test.cjs source 斷言鎖住。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 cancel handler 的 parseGeneration++ 與 abort 拿掉
// (還原成只 releaseCurrentDoc + showStage('upload') 的舊行為)→ 「取消後 5 秒內
// stage-result 不得出現」斷言 fail(舊輪 parse 跑完把畫面蓋回 result);還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function loadPdfLib() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'shinkansen/lib/vendor/pdf-lib/pdf-lib.min.js'),
    'utf8',
  );
  const exp = {};
  new Function('exports', 'module', src)(exp, { exports: exp });
  return exp;
}

async function makeBigPdfBytes(pageCount, linesPerPage) {
  const { PDFDocument, StandardFonts } = loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([612, 792]);
    for (let i = 0; i < linesPerPage; i++) {
      page.drawText(`Page ${p + 1} paragraph line ${i + 1} with enough words to be a text run.`, {
        x: 50, y: 740 - i * 22, size: 11, font,
      });
    }
  }
  return Buffer.from(await doc.save());
}

async function makeSmallPdfBytes() {
  const { PDFDocument, StandardFonts } = loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('A short document with just enough characters to pass the scanned threshold.', {
    x: 50, y: 700, size: 12, font,
  });
  return Buffer.from(await doc.save());
}

test('pdf-parse-cancel: 解析中取消 → 舊輪不得蓋回 result,重新上傳正常', async ({ context, extensionId }) => {
  const bigPdf = await makeBigPdfBytes(50, 30);
  const smallPdf = await makeSmallPdfBytes();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#dropzone', { state: 'visible' });

  await page.setInputFiles('#file-input', {
    name: 'big-cancel-fixture.pdf', mimeType: 'application/pdf', buffer: bigPdf,
  });
  // parsing stage 在 handleFile 開頭同步出現,點取消時 parse 必定 in-flight
  await page.waitForFunction(() => {
    const el = document.getElementById('stage-parsing');
    return el && !el.hidden;
  }, null, { timeout: 10_000 });
  await page.click('#cancel-btn');

  // 取消立即回 upload
  await page.waitForFunction(() => {
    const el = document.getElementById('stage-upload');
    return el && !el.hidden;
  }, null, { timeout: 5_000 });

  // 關鍵斷言:5 秒觀察窗內 stage-result 不得出現(舊 bug:in-flight handleFile
  // 跑完 parse 後 showStage('result') 蓋掉取消)。50 頁 parse 實測遠短於 5 秒,
  // 觀察窗足以涵蓋舊輪跑完的時點
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const leaked = await page.evaluate(() => {
      const r = document.getElementById('stage-result');
      const u = document.getElementById('stage-upload');
      return { resultShown: !!r && !r.hidden, uploadShown: !!u && !u.hidden };
    });
    expect(leaked.resultShown, '取消後 stage-result 不得被舊輪蓋回來').toBe(false);
    expect(leaked.uploadShown, '取消後應停在 stage-upload').toBe(true);
    await page.waitForTimeout(250);
  }

  // state 沒殘留壞值:重新上傳小 PDF 正常解析到 result
  await page.setInputFiles('#file-input', {
    name: 'small-after-cancel.pdf', mimeType: 'application/pdf', buffer: smallPdf,
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('stage-result');
    return el && !el.hidden;
  }, null, { timeout: 30_000 });
  // 批次 8 G6:verify harness 改 lazy install
  await page.evaluate(() => window.__skInstallVerify());
  const hasDoc = await page.evaluate(() => window.__skVerify && window.__skVerify.hasDoc());
  expect(hasDoc).toBe(true);

  await page.close();
});
