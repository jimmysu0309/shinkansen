// pdf-download-encrypted.spec.js
//
// 鎖死 W6 譯文 PDF 下載對「owner-password + AESv2 弱加密」PDF 的支援。
//
// 背景:hopding/pdf-lib 1.17.1 的 PDFDocument.load 對 R=4 + 空 user pwd +
// owner permissions 限制的 PDF 直接拋 EncryptedPDFError。換 @cantoo/pdf-lib
// 2.6.5 fork(補 mozilla/pdf.js port 的 AES decrypt)+ 加 password='' 參數
// 解開。完整根因 + probe 結果見 v1.8.46 PENDING_REGRESSION 已清條目。
//
// SANITY 紀錄(已驗證):
//   1. 暫時把 shinkansen/translate-doc/pdf-renderer.js 的
//      `PDFDocument.load(originalArrayBuffer, { ignoreEncryption: true, password: '' })`
//      改回 `PDFDocument.load(originalArrayBuffer)` → 跑此 spec → fail in
//      stage:'parsing' (EncryptedPDFError)。還原 fix → spec pass。
//
// fixture:`docs/excluded/test pdf/022516-708C-en-US_TrimbleTDC6_DataCollector_SpecSheet_USL_0124_LRsec.pdf`
// 是 docs/excluded 下的測試 PDF(整個資料夾被 .gitignore 排除以避免使用者 PDF
// 進 repo)。CI 上沒這份 PDF → spec auto-skip,只在 Jimmy 本機跑。

import { test, expect } from '../fixtures/extension.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const TRIMBLE_PDF = path.join(
  REPO_ROOT,
  'docs/excluded/test pdf/022516-708C-en-US_TrimbleTDC6_DataCollector_SpecSheet_USL_0124_LRsec.pdf',
);

test('W6 譯文 PDF 下載對 owner-password 弱加密 PDF 可成功生成', async ({ context, extensionId }) => {
  test.skip(!fs.existsSync(TRIMBLE_PDF), `fixture not found: ${TRIMBLE_PDF}(本機才有,docs/excluded 整個 ignored)`);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#dropzone', { state: 'visible' });

  // 上傳 → 等 stage-result(代表 PDF.js parse + analyzeLayout 都過了)
  await page.setInputFiles('#file-input', TRIMBLE_PDF);
  await page.waitForFunction(
    () => {
      const r = document.getElementById('stage-result');
      return r && !r.hidden;
    },
    null,
    { timeout: 60_000 },
  );

  // doc IR 結構面 baseline:Trimble 是 4 頁
  const docMeta = await page.evaluate(() => {
    const d = window.__skLayoutDoc;
    return d ? { pageCount: d.pages.length, totalBlocks: d.pages.reduce((s, p) => s + p.blocks.length, 0) } : null;
  });
  expect(docMeta).not.toBeNull();
  expect(docMeta.pageCount).toBe(4);
  expect(docMeta.totalBlocks).toBeGreaterThan(0);

  // 注入 fake translation = plainText(英文當譯文,只驗 pipeline 不真的翻譯)
  await page.evaluate(() => window.__skInstallVerify()); // 批次 8 G6:lazy install
  const inject = await page.evaluate(() => window.__skVerify.injectPlainTextAsTranslation());
  expect(inject.translatableCount).toBeGreaterThan(0);

  // 觸發 W6 PDF download + 重 parse 驗證(透過 dev hook;production 行為等同
  // 使用者點 reader-download-pdf-btn)
  const result = await page.evaluate(() => window.__skVerify.generateAndVerifyPdf());
  expect(result, 'generateAndVerifyPdf 應該成功生成 PDF bytes').not.toBeNull();
  expect(result.ok, `generateAndVerifyPdf failed: ${result.error}`).toBe(true);
  expect(result.byteLength).toBeGreaterThan(100 * 1024); // 至少 100KB
  expect(result.reparsed, 'reparse 應該成功').not.toBeNull();
  expect(result.reparseError).toBeNull();
  expect(result.reparsed.numPages).toBe(4);
  // 每頁都該有 textRun(包含原 PDF embedded form XObject 的字 + 我們加的譯文)
  for (const p of result.reparsed.pages) {
    expect(p.runCount, `page ${p.pageIndex} 應該有 textRun`).toBeGreaterThan(0);
  }

  await page.close();
});
