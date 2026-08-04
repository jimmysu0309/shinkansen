// Regression: reader-lazy-render(對應 code review 2026-08-03 G5,dev tail 2.0.81.1 修)
//
// Bug(G5,記憶體 P2):reader 全頁一次性 render——兩欄 × N 頁 canvas,scale 1.5 ×
//   DPR,Retina(DPR 2)下 A4 每 bitmap ~18MB → 50 頁書峰值 ~1.8GB,疊加
//   originalArrayBuffer + translatedBytes + PDF.js 內部 copy;retryAllFailed 成功
//   後不管改幾段、全書重繪。
// 修法(reader.js):
//   (1) 可視區 lazy render——page div 尺寸由 getViewport 先就位(scroll sync /
//       zoom 不依賴 render),各欄 IntersectionObserver(margin ±200% 欄高)進區
//       render、出區釋放 bitmap(canvas.width=0,div 尺寸固定版面不動);
//   (2) retryAllFailed 只重繪含重翻成功 block 的頁(rerenderRightColumn 帶
//       successPages Set);
//   (3) window.__skReaderRenderAll 全量 render hook(pdf harness 批次截圖用)。
//
// 驅動方式:pdf-lib 動態生成 10 頁 PDF + 小 viewport(500px 高),讓後段頁落在
//   lazy 邊界外;main world stub TRANSLATE_DOC_BATCH(同 translate-doc-state-machine
//   手法)。repaint 偵測用 sentinel pixel:初始 render 後在 canvas (0,0) 畫已知色,
//   被重繪的頁 sentinel 消失。
//
// 本 spec 鎖的訊號層:驗 lazy render / 釋放 / 重繪範圍的行為契約(真實 PDF.js
//   render 路徑)。不驗真實記憶體峰值數字(環境相依);Retina DPR 分支同一條
//   renderPageToCanvas,不另驗。
//
// SANITY 紀錄(已驗證,2026-08-05):
//   ① reader.js queueRender 內 `if (!m || m.rendered || !m.inZone)` 的 inZone
//      條件改掉並於 observe 後對所有頁 queueRender(退化回全量 render)→
//      「離區頁不得有 bitmap」斷言 fail → 還原後 pass。
//   ② retryAllFailed 的 `rerenderRightColumn(successPages)` 改回
//      `rerenderRightColumn(null)`(全書重繪)→ 「未含 retry block 的頁 sentinel
//      應保留」斷言 fail(page 0 被重繪)→ 還原後 pass。
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

const PAGE_COUNT = 10;

async function makeMultiPagePdfBytes() {
  const { PDFDocument, StandardFonts } = loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < PAGE_COUNT; p++) {
    const page = doc.addPage([612, 792]);
    for (let i = 0; i < 3; i++) {
      page.drawText(`Page ${p + 1} paragraph sentence number ${i + 1} with enough words to be a run.`, {
        x: 50, y: 700 - i * 16, size: 11, font,
      });
    }
  }
  return Buffer.from(await doc.save());
}

// main world stub:TRANSLATE_DOC_BATCH 成功;failOncePattern 命中的段第一次回空
// (→ failed),之後成功(讓 retry 能翻成功)
async function installPdfStub(page, { failOncePattern = null } = {}) {
  await page.addInitScript((opts) => {
    const state = { failedOnce: false };
    const install = () => {
      if (!window.chrome?.runtime?.sendMessage) return false;
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg) => {
        if (msg?.type === 'TRANSLATE_DOC_BATCH' || msg?.type === 'TRANSLATE_DOC_BATCH_CUSTOM') {
          return {
            ok: true,
            result: msg.payload.texts.map((t) => {
              if (opts.failOncePattern && t.includes(opts.failOncePattern) && !state.failedOnce) {
                state.failedOnce = true;
                return '';
              }
              return '譯' + t;
            }),
            usage: { inputTokens: 100, billedInputTokens: 100, outputTokens: 50, billedCostUSD: 0.001, cacheHits: 0 },
          };
        }
        if (msg?.type === 'LOG_USAGE') return { ok: true };
        return orig(msg);
      };
      return true;
    };
    if (!install()) document.addEventListener('DOMContentLoaded', install);
  }, { failOncePattern });
}

// 右欄第 i 頁 canvas 的 bitmap 寬(0 = 未 render / 已釋放)
function rightCanvasWidth(page, i) {
  return page.evaluate((idx) => {
    const c = document.querySelectorAll('.reader-page-translated')[idx]?.querySelector('canvas');
    return c ? c.width : -1;
  }, i);
}

async function pollUntil(page, fn, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

test('G5-1: 可視區 lazy render——首頁就緒、離區頁無 bitmap、捲動進區 render、出區釋放、hook 全量', async ({
  context, extensionId,
}) => {
  const bytes = await makeMultiPagePdfBytes();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 500 });
  await installPdfStub(page);
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file-input', {
    name: 'lazy-render-fixture.pdf', mimeType: 'application/pdf', buffer: bytes,
  });
  await page.waitForSelector('#stage-result:not([hidden])', { timeout: 20_000 });
  await page.click('#translate-btn');
  await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 60_000 });

  const LAST = PAGE_COUNT - 1;

  // 斷言 1:可視首頁 render 完成(lazy 路徑會 render 進區頁)
  expect(
    await pollUntil(page, async () => (await rightCanvasWidth(page, 0)) > 100),
    '可視區首頁應被 render',
  ).toBe(true);

  // 斷言 2:全部頁的尺寸(dataset.baseHeight)未 render 也已就位(scroll sync 依賴)
  const allSized = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.reader-page-translated'))
      .every((p) => parseFloat(p.dataset.baseHeight) > 100));
  expect(allSized, '所有頁 div 尺寸應先就位(不依賴 render)').toBe(true);

  // 斷言 3(核心):遠離可視區的最後一頁不得有 bitmap
  await page.waitForTimeout(800); // 讓 render chain settle
  expect(await rightCanvasWidth(page, LAST), '離區頁不得有 bitmap(lazy)').toBe(0);

  // 斷言 4:捲到底 → 最後一頁進區被 render
  await page.evaluate(() => {
    const col = document.querySelector('.reader-page-translated').closest('.reader-col');
    col.scrollTop = col.scrollHeight;
  });
  expect(
    await pollUntil(page, async () => (await rightCanvasWidth(page, LAST)) > 100),
    '捲動進區後應被 render',
  ).toBe(true);

  // 斷言 5:捲回頂 → 最後一頁出區釋放 bitmap
  await page.evaluate(() => {
    const col = document.querySelector('.reader-page-translated').closest('.reader-col');
    col.scrollTop = 0;
  });
  expect(
    await pollUntil(page, async () => (await rightCanvasWidth(page, LAST)) === 0),
    '出區後 bitmap 應被釋放',
  ).toBe(true);

  // 斷言 6:harness 契約——__skReaderRenderAll 全量 render 後所有 canvas 有 bitmap
  await page.evaluate(() => window.__skReaderRenderAll());
  const allRendered = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.reader-page-translated canvas'))
      .every((c) => c.width > 100));
  expect(allRendered, '__skReaderRenderAll 後全書 canvas 應有 bitmap').toBe(true);

  await page.close();
});

test('G5-2: retryAllFailed 只重繪含重翻成功 block 的頁(sentinel pixel)', async ({
  context, extensionId,
}) => {
  const bytes = await makeMultiPagePdfBytes();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 500 });
  await installPdfStub(page, { failOncePattern: 'Page 2 paragraph' }); // 第 2 頁(index 1)首輪 failed
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file-input', {
    name: 'lazy-retry-fixture.pdf', mimeType: 'application/pdf', buffer: bytes,
  });
  await page.waitForSelector('#stage-result:not([hidden])', { timeout: 20_000 });
  await page.click('#translate-btn');
  await page.waitForSelector('#stage-reader:not([hidden])', { timeout: 60_000 });

  // 等 page 0 / page 1(都在可視區 ±200% 內)render 完
  expect(await pollUntil(page, async () =>
    (await rightCanvasWidth(page, 0)) > 100 && (await rightCanvasWidth(page, 1)) > 100)).toBe(true);
  await page.waitForTimeout(500);

  // 前置:page 1 有 failed block
  const failedPages = await page.evaluate(() => {
    const out = [];
    window.__skLayoutDoc.pages.forEach((p, i) => {
      if (p.blocks.some((b) => b.translationStatus === 'failed')) out.push(i);
    });
    return out;
  });
  expect(failedPages, '前置:failed block 應在 page index 1').toEqual([1]);

  // sentinel:在 page 0 / page 1 的 canvas (0,0) 畫已知色
  await page.evaluate(() => {
    for (const idx of [0, 1]) {
      const c = document.querySelectorAll('.reader-page-translated')[idx].querySelector('canvas');
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(1,2,3)';
      ctx.fillRect(0, 0, 1, 1);
    }
  });
  const readSentinel = (idx) => page.evaluate((i) => {
    const c = document.querySelectorAll('.reader-page-translated')[i].querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
    return d[0] === 1 && d[1] === 2 && d[2] === 3;
  }, idx);
  expect(await readSentinel(0)).toBe(true);
  expect(await readSentinel(1)).toBe(true);

  // 觸發 retry(按鈕在 summary dialog 內,直接 dispatch click)
  await page.evaluate(() => document.getElementById('summary-retry-btn').click());
  // 等 page 1 被重繪(sentinel 消失)
  expect(
    await pollUntil(page, async () => !(await readSentinel(1))),
    '含 retry 成功 block 的頁應被重繪',
  ).toBe(true);
  await page.waitForTimeout(500);

  // 核心:page 0 沒有 retry block → 不得被重繪(sentinel 保留)
  expect(await readSentinel(0), '未含 retry block 的頁 sentinel 應保留(不整書重繪)').toBe(true);

  // retry 後 failed 歸零
  const failedAfter = await page.evaluate(() =>
    window.__skLayoutDoc.pages.flatMap((p) => p.blocks).filter((b) => b.translationStatus === 'failed').length);
  expect(failedAfter).toBe(0);

  await page.close();
});
