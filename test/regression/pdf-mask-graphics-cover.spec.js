// Regression: pdf-mask-graphics-cover(§27 批次 4-3「fit-to-box 擴 box 後白底 mask
// 蓋掉 block 間的圖片 / 向量圖形」bug)
//
// Fixture:spec 內動態生成(vendored pdf-lib 在 node 端 eval UMD;repo 不收 PDF 二進位)。
// 結構:單欄頁面,上方一個短文字 block,下方一塊紅色向量矩形(代表圖片——
// layout-analyzer 的 blocks 全來自 text run,圖形不是 fit-to-box 的阻擋物),
// 再下方一個文字 block 當擴 box 的下界。
// Bug:譯文比原文長 → fitSegmentsToBox Phase 0/B 向下擴 box 到下一個文字 block 上緣,
// mask 以「整個 finalBox」起算 → 紅色矩形整塊被白底蓋掉,即使譯文實際只畫 3 行。
// 修法(結構性):mask 基底 = 原 block.bbox ∪ 譯文實際畫字範圍(最寬行寬 × 行高總和),
// 不再用整個 finalBox;擴 box 多出來但沒畫字的區域不蓋白。
//
// 訊號層界定:本 spec 驗「pdf-renderer mask 幾何 → 譯文 PDF render 後的 pixel」這層;
// 不驗真實 LLM 譯文 / 真實含圖 PDF 的 layout 分析(那層靠 pdf-translate-verify 流程)。
//
// SANITY 紀錄(已驗證,2026-06-11):修法套用前本 spec 即 fail(紅色矩形中心 pixel 被 mask 蓋成
// 白色,「rect 中心應保持紅色」斷言 fail)= 重現確認;套用 mask 限縮修法後 pass。
import { test, expect } from '../fixtures/extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// vendored pdf-lib 是 UMD;repo package.json type=module 讓 require() 把它當 ESM
// 解析(exports 空),改用 Function wrapper 手動餵 CJS exports
function loadPdfLib() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'shinkansen/lib/vendor/pdf-lib/pdf-lib.min.js'),
    'utf8',
  );
  const exp = {};
  new Function('exports', 'module', src)(exp, { exports: exp });
  return exp;
}

// 生成最小重現 PDF:
//   block A(canvas top ≈ 80):短文字,譯文會比它長很多
//   紅色矩形(canvas top 150-250, x 60-210):block A 與 block B 之間的「圖形」
//   block B(canvas top ≈ 400):擴 box 的下界(沒有它就擴到頁底,一樣重現)
async function makeFixturePdfBytes() {
  const { PDFDocument, StandardFonts, rgb } = loadPdfLib();
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Project overview summary heading line', { x: 50, y: 700, size: 12, font });
  page.drawRectangle({ x: 60, y: 542, width: 150, height: 100, color: rgb(0.85, 0.1, 0.1) });
  page.drawText('This trailing paragraph anchors the page bottom region with enough characters.', {
    x: 50, y: 380, size: 12, font,
  });
  return Buffer.from(await doc.save());
}

test('pdf-mask-graphics-cover: 擴 box 後 mask 不可蓋掉 block 間的向量圖形', async ({ context, extensionId }) => {
  const pdfBuffer = await makeFixturePdfBytes();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#dropzone', { state: 'visible' });

  await page.setInputFiles('#file-input', {
    name: 'mask-graphics-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuffer,
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('stage-result');
    return r && !r.hidden;
  }, null, { timeout: 30_000 });

  // 注入譯文:全部 block 先用 plainText 墊底,再把最上方 block(top < 100)換成
  // 48 字 CJK 長譯文 → 原 bbox(1 行)塞不下、擴右(2 行)也塞不下 → 向下擴 box
  await page.evaluate(() => window.__skInstallVerify()); // 批次 8 G6:lazy install
  const injected = await page.evaluate(() => {
    const r = window.__skVerify.injectPlainTextAsTranslation();
    const blocks = window.__skLayoutDoc.pages[0].blocks;
    const topBlock = blocks.find((b) => b.bbox[1] < 100);
    if (!topBlock) return { ...r, topBlockFound: false };
    topBlock.translation = '譯'.repeat(48);
    topBlock.translationSegments = null; // 走 fallback 單一 plain segment
    return { ...r, topBlockFound: true, topBbox: topBlock.bbox };
  });
  expect(injected.topBlockFound).toBe(true);

  // 生成譯文 PDF → 頁內用 PDF.js render → 取紅色矩形範圍內 3 個取樣點的 pixel。
  // 矩形 canvas 座標 x 60-210 / y 150-250;譯文 3 行實際畫到 y ≈ 134 為止,
  // 取樣點全部在 y ≥ 170 避開譯文實畫區
  const pixels = await page.evaluate(async () => {
    const bytesArr = await window.__skVerify.buildTranslatedPdfBytes();
    if (!bytesArr) return { error: 'no-bytes' };
    const pdfjs = await import('../lib/vendor/pdfjs/pdf.min.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytesArr).buffer, disableFontFace: false });
    const pdfDoc = await task.promise;
    const p1 = await pdfDoc.getPage(1);
    const viewport = p1.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await p1.render({ canvasContext: ctx, viewport }).promise;
    const sample = (x, y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { x, y, r: d[0], g: d[1], b: d[2] };
    };
    const out = { samples: [sample(135, 175), sample(135, 200), sample(180, 230)] };
    await pdfDoc.destroy();
    return out;
  });

  expect(pixels.error).toBeUndefined();
  for (const s of pixels.samples) {
    // 紅色矩形(0.85, 0.1, 0.1)≈ rgb(217, 25, 25);mask 蓋掉時是純白(255,255,255)
    expect(s.r, `(${s.x},${s.y}) 應保持紅色(矩形未被 mask 蓋白)`).toBeGreaterThan(150);
    expect(s.g, `(${s.x},${s.y}) 應保持紅色(矩形未被 mask 蓋白)`).toBeLessThan(120);
  }

  await page.close();
});
