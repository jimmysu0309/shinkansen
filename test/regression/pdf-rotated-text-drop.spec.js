// Regression: pdf-rotated-text-drop(§27 批次 4-4「垂直 / 旋轉文字 run 的 bbox 全錯」bug)
//
// Fixture:spec 內動態生成(vendored pdf-lib node 端 eval UMD):一段水平正文 +
// 一段 rotate 90° 的文字(模擬圖表軸標籤)。
// Bug:pdf-engine.js 的 bbox 公式假設 run 水平(top = baseline - fontSize、
// right = left + width);旋轉 90° 的 run 算出水平窄帶 bbox → 下游 mask / 譯文
// 位置全錯位(白條蓋在不相干位置)。
// 修法:|m[1]| > |m[0]|(glyph 前進方向偏垂直)的 run 丟棄不送翻 + 計數告警
// (doc warning 提示使用者「旋轉或直排文字維持原文」)。
// 2026-08-03 擴充:閾值改 |m[1]| > |m[0]| × 0.09(≈ tan 5°)——斜 30-40° 的
// 對角浮水印原本漏過(<45°),axis-aligned bbox 橫跨半頁,譯成水平大字蓋住
// 頁面內容(Stella 簡報實測)。新增斜 35° 浮水印 case。
// SANITY(已驗證):閾值暫時改回 |m[1]| > |m[0]| → 斜角浮水印斷言 fail → 還原 pass。
//
// 訊號層界定:本 spec 驗「parsePdf 抽取層丟棄旋轉 run + warning 產出」;不驗
// 真實圖表 PDF 的視覺結果(那層靠 pdf-translate-verify 流程)。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 pdf-engine.js 的 |m[1]| > |m[0]| 丟棄
// guard 改成恆 false → 「旋轉 run 不得進 textRuns」斷言 fail;還原 → pass。
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

async function makeRotatedTextPdfBytes() {
  const { PDFDocument, StandardFonts, degrees } = loadPdfLib();
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('This horizontal paragraph provides enough characters to pass the scanned threshold.', {
    x: 50, y: 700, size: 12, font,
  });
  // 旋轉 90° 的「圖表軸標籤」
  page.drawText('ROTATEDAXISLABEL', { x: 80, y: 300, size: 12, font, rotate: degrees(90) });
  // 斜 35° 的對角浮水印(模擬「PROPRIETARY AND CONFIDENTIAL」斜印)——
  // 原條件 |m[1]| > |m[0]| 只擋 >45°,這類 run 漏過後 axis-aligned bbox 橫跨
  // 半頁,譯成一條水平大字蓋住頁面內容(Stella 簡報實測)
  page.drawText('DIAGONALWATERMARK CONFIDENTIAL', { x: 150, y: 200, size: 24, font, rotate: degrees(35) });
  return Buffer.from(await doc.save());
}

test('pdf-rotated-text-drop: 旋轉 90° 的 run 丟棄不送翻 + 產出 warning', async ({ context, extensionId }) => {
  const pdfBuffer = await makeRotatedTextPdfBytes();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#dropzone', { state: 'visible' });
  // 批次 8 G6:_rawPages 改 opt-in(production 不再無條件掛數 MB raw runs),
  // 本 spec 要讀 textRuns → parse 前先設旗標
  await page.evaluate(() => { window.__skKeepRawPages = true; });
  await page.setInputFiles('#file-input', {
    name: 'rotated-text-fixture.pdf', mimeType: 'application/pdf', buffer: pdfBuffer,
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('stage-result');
    return r && !r.hidden;
  }, null, { timeout: 30_000 });

  const probe = await page.evaluate(() => {
    const d = window.__skLayoutDoc;
    const runTexts = d._rawPages[0].textRuns.map((r) => r.text);
    return {
      runTexts,
      warnings: (d.warnings || []).map((w) => w.code),
    };
  });

  // 旋轉 run 不得進 textRuns(進了就會以全錯的水平窄帶 bbox 走完 mask / 譯文注入)
  expect(probe.runTexts.some((t) => t.includes('ROTATEDAXISLABEL')), '旋轉 run 不得進 textRuns').toBe(false);
  // 斜 35° 浮水印同樣丟棄(2026-08-03 閾值改 tan(5°):偏離水平 >5° 即丟)
  expect(probe.runTexts.some((t) => t.includes('DIAGONALWATERMARK')), '斜角浮水印 run 不得進 textRuns').toBe(false);
  // 水平正文仍在
  expect(probe.runTexts.some((t) => t.includes('horizontal paragraph')), '水平 run 應保留').toBe(true);
  // 計數告警產出(使用者可見 warning banner)
  expect(probe.warnings, 'rotated-text-dropped warning 必須產出').toContain('rotated-text-dropped');

  await page.close();
});
