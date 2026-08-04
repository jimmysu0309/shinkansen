// Regression: translate-doc-state-machine（code review 2026-08-03 批次 5 G2 + G9——
// PDF 翻譯頁的編輯儲存與整體失敗兩條狀態機）
//
// G2：saveEdits 原本無條件把所有 edit row 標 done + userEdited——失敗段
//   （placeholder 空 textarea）若使用者留空只存別段的修改，該段被抹平成
//   `translation: ''` + status done → countCurrentFailedBlocks 歸零、summary
//   重試按鈕永久隱藏、reader 橘框警示消失（失去 retryAllFailed 入口）；
//   同時所有 block 被打上 userEdited 污染「跳過 re-translate」語意。
//   修法：textarea 用 defaultValue 存初始值，`value === defaultValue`（零變動）
//   的 row 完全不動。
//
// G9：PDF 路徑 translateDocument throw 時 exception 被包成 error summary 後直接
//   openReader()，fillSummaryDialog 只顯示計數欄不讀 summary.error → 使用者拿到
//   全未翻譯的 reader 看不到失敗原因（EPUB 路徑有 showChaptersError 對等處理）。
//   修法：reader stage 加 #reader-error banner，summary.error 時顯示。
//
// 驅動方式：pdf-lib 動態生成 2 段落 PDF（同 pdf-parse-cancel 手法）+ main world
// stub chrome.runtime.sendMessage（同 epub-translate 手法）。G9 的「translateDocument
// 整體 throw」用 block.plainText getter 毒針觸發（queue 收集迴圈在 per-batch
// catch 之外，真實 top-level throw 形態）。
//
// SANITY 紀錄（已驗證，2026-08-04）：
//   (a) saveEdits 的 `if (text === ta.defaultValue) continue;` 註解掉 → G2 case
//       fail（失敗段被抹平成 done、summary 失敗計數歸零）→ 還原 → pass。
//   (b) startTranslate 尾端 `if (summary.error) showReaderError(...)` 註解掉 →
//       G9 case fail（#reader-error 不可見）→ 還原 → pass。
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

// 兩個垂直遠離的文字群 → layout-analyzer 切成 2 個 block
async function makeTwoBlockPdfBytes() {
  const { PDFDocument, StandardFonts } = loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (let i = 0; i < 3; i++) {
    page.drawText(`First paragraph sentence number ${i + 1} with enough words to be a run.`, {
      x: 50, y: 700 - i * 16, size: 11, font,
    });
  }
  for (let i = 0; i < 3; i++) {
    page.drawText(`Second paragraph sentence number ${i + 1} with enough words to be a run.`, {
      x: 50, y: 400 - i * 16, size: 11, font,
    });
  }
  return Buffer.from(await doc.save());
}

// main world stub：TRANSLATE_DOC_BATCH 依 failMatch 讓特定段回空字串（→ failed）
async function installPdfStub(page, { failMatch = null } = {}) {
  await page.addInitScript((opts) => {
    const install = () => {
      if (!window.chrome?.runtime?.sendMessage) return false;
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.type === 'TRANSLATE_DOC_BATCH' || msg?.type === 'TRANSLATE_DOC_BATCH_CUSTOM') {
          return {
            ok: true,
            result: msg.payload.texts.map((t) =>
              (opts.failMatch && t.includes(opts.failMatch)) ? '' : ('譯' + t)),
            usage: { inputTokens: 100, billedInputTokens: 100, outputTokens: 50, billedCostUSD: 0.001, cacheHits: 0 },
          };
        }
        if (msg?.type === 'LOG_USAGE') return { ok: true };
        return orig(msg);
      };
      return true;
    };
    if (!install()) document.addEventListener('DOMContentLoaded', install);
  }, { failMatch });
}

async function uploadPdfAndReachResult(page, bytes) {
  await page.setInputFiles('#file-input', {
    name: 'state-machine-fixture.pdf', mimeType: 'application/pdf', buffer: bytes,
  });
  await page.waitForSelector('#stage-result:not([hidden])', { timeout: 20_000 });
}

function blockStatuses(page) {
  return page.evaluate(() => {
    const out = [];
    for (const p of window.__skLayoutDoc.pages) {
      for (const b of p.blocks) {
        if (b.plainText && b.plainText.trim()) {
          out.push({ text: b.plainText.slice(0, 20), status: b.translationStatus,
            translation: b.translation, userEdited: !!b.userEdited });
        }
      }
    }
    return out;
  });
}

test('G2: 編輯頁零變動儲存 → 失敗段不被抹平、userEdited 不污染；真編輯後才轉 done', async ({
  context, extensionId,
}) => {
  const bytes = await makeTwoBlockPdfBytes();
  const page = await context.newPage();
  await installPdfStub(page, { failMatch: 'Second paragraph' });
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await uploadPdfAndReachResult(page, bytes);

  await page.click('#translate-btn');
  await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 30_000 });

  const before = await blockStatuses(page);
  const failedBefore = before.filter((b) => b.status === 'failed');
  expect(failedBefore.length, '前置：Second paragraph 段應為 failed').toBeGreaterThanOrEqual(1);

  // 開編輯頁 → 不改任何內容直接儲存
  await page.click('#reader-edit-btn');
  await page.waitForSelector('#stage-edit:not([hidden])', { timeout: 10_000 });
  await page.click('#edit-save-btn');
  await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 30_000 });

  const after = await blockStatuses(page);
  const failedAfter = after.filter((b) => b.status === 'failed');
  expect(failedAfter.length, '零變動儲存不得把失敗段抹平成 done（retryAllFailed 入口不得消失）')
    .toBe(failedBefore.length);
  expect(after.every((b) => b.userEdited === false), '零變動儲存不得打 userEdited flag').toBe(true);

  // 對照組：真的填入失敗段譯文 → 儲存 → 轉 done + userEdited
  await page.click('#reader-edit-btn');
  await page.waitForSelector('#stage-edit:not([hidden])', { timeout: 10_000 });
  await page.locator('.edit-block--failed textarea').first().fill('手動補上的譯文段落');
  await page.click('#edit-save-btn');
  await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 30_000 });

  const final = await blockStatuses(page);
  expect(final.filter((b) => b.status === 'failed').length, '真編輯後失敗段轉 done').toBe(failedBefore.length - 1);
  const edited = final.find((b) => b.translation === '手動補上的譯文段落');
  expect(edited, '編輯內容應寫進 block').toBeTruthy();
  expect(edited.userEdited, '真編輯的 block 才標 userEdited').toBe(true);
  await page.close();
});

test('G9: translateDocument 整體 throw → reader 顯示 #reader-error 失敗原因', async ({
  context, extensionId,
}) => {
  const bytes = await makeTwoBlockPdfBytes();
  const page = await context.newPage();
  await installPdfStub(page);
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await uploadPdfAndReachResult(page, bytes);

  // 毒針：第一個 block 的 plainText getter throw——queue 收集迴圈在 per-batch
  // catch 之外，重現「translateDocument 整體 throw → summary.error」形態
  await page.evaluate(() => {
    const b = window.__skLayoutDoc.pages[0].blocks[0];
    Object.defineProperty(b, 'plainText', { get() { throw new Error('G9-boom'); } });
  });

  await page.click('#translate-btn');
  await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 30_000 });

  const banner = page.locator('#reader-error');
  await expect(banner, '整體失敗必須讓使用者看到原因（不是拿到全未翻譯的 reader 卻無提示）').toBeVisible();
  expect(await banner.textContent()).toContain('G9-boom');
  await page.close();
});
