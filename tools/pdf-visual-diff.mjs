#!/usr/bin/env node
// pdf-visual-diff.mjs — L4-a 像素比對 + contact sheet（PDF 版的「多重集比對」）
//
// 計劃：docs/excluded/planning/pdf-test-plan.md §3 L4-a。把「有沒有動到不該動的東西」機械隔離：
//   - 原檔與譯文 PDF 各以 pdftoppm 同 DPI 轉 PNG
//   - 從 layout.json 取每個已翻 block 的 bbox，膨脹 padding 並向下擴到「下一個阻擋 block」
//     （= pdf-renderer fit-to-box 允許擴展的範圍）合成 allowed mask
//   - mask 外逐像素比對（pixelmatch）：差異像素超門檻 = 遮罩蓋到框線 / 圖 / 彩底、頁面幾何變了、
//     掃描影像被塗白、譯文溢出到別人的區域 → flag `outside-diff`
//   - bbox 內：譯文圖與原圖幾乎相同 → 沒翻到 / 沒畫遮罩 → flag `block-unchanged`；
//     原圖 bbox 外圍環帶眾數非白（renderer 會採用的底色）但譯文 bbox 內眾數是白 → flag `bg-lost`
//   - 每頁產 contact sheet：原文 | 譯文 | 差異熱圖（紅 = mask 外差異、藍框 = 已翻 bbox、
//     橙框 = flag 的 block），存 <case>/sheet-{i}.png；SHEETS.md 只列有 flag 的頁
//
// 用法：
//   node tools/pdf-visual-diff.mjs                       # 最近一次 pdf-corpus-verify 輸出全部 case
//   node tools/pdf-visual-diff.mjs --only tables         # bucket 或檔名子字串
//   node tools/pdf-visual-diff.mjs --all-sheets          # 沒 flag 的頁也出 sheet
//   node tools/pdf-visual-diff.mjs --dpi 72              # 預設 100
//
// 驗的層次：像素級「不該變的地方有沒有變」「該變的地方有沒有變」。不驗：譯文內容、字身是否被切
// （bbox 內差異本來就大，交 Read PDF）、殘影（v1 未實作，見計劃 R3）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const ROOT = path.resolve(import.meta.dirname, '..');
const PDF_DIR = path.join(ROOT, 'docs/excluded/test pdf');
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1].toLowerCase() : null;
const ALL_SHEETS = argv.includes('--all-sheets');
const dpiIdx = argv.indexOf('--dpi');
const DPI = dpiIdx >= 0 ? Number(argv[dpiIdx + 1]) : 100;
const SCALE = DPI / 72;
const PAD_PT = 3;                 // bbox 膨脹（pt）：renderer 遮罩 padding 上限附近
const OUTSIDE_DIFF_RATIO = 0.0015; // mask 外差異像素 / 頁面像素 > 0.15% 即 flag
const OUTSIDE_DIFF_MIN = 150;      // 且至少 150 px（小頁面防抖）
const UNCHANGED_RATIO = 0.003;     // bbox 內差異像素 / bbox 面積 < 0.3% 視為沒翻到

// 找最近一次輸出
const outDirs = fs.readdirSync(PDF_DIR).filter((d) => /test pdf output$/.test(d)).sort().reverse();
const OUT_ROOT = outDirs.map((d) => path.join(PDF_DIR, d)).find((d) => fs.existsSync(path.join(d, 'corpus')));
if (!OUT_ROOT) { console.error('找不到 pdf-corpus-verify 輸出'); process.exit(1); }
const CORPUS_OUT = path.join(OUT_ROOT, 'corpus');

function listCases() {
  const out = [];
  for (const b of fs.readdirSync(CORPUS_OUT).sort()) {
    const bd = path.join(CORPUS_OUT, b);
    if (!fs.statSync(bd).isDirectory()) continue;
    for (const c of fs.readdirSync(bd).sort()) {
      const cd = path.join(bd, c);
      if (!fs.existsSync(path.join(cd, 'result.json'))) continue;
      const r = JSON.parse(fs.readFileSync(path.join(cd, 'result.json'), 'utf-8'));
      if (!fs.existsSync(path.join(cd, 'translated.pdf')) || !fs.existsSync(path.join(cd, 'layout.json'))) continue;
      if (ONLY && !(r.bucket.toLowerCase() === ONLY || r.name.toLowerCase().includes(ONLY))) continue;
      out.push({ dir: cd, r });
    }
  }
  return out;
}

function renderPages(pdf, prefix, tmp) {
  // pdftoppm 輸出 <prefix>-<n>.png（n 依頁數補零）；-cropbox：layout 座標是 PDF.js viewport（CropBox）空間，預設 MediaBox 會對不上
  execFileSync('pdftoppm', ['-r', String(DPI), '-cropbox', '-png', pdf, path.join(tmp, prefix)], { stdio: 'ignore', timeout: 600_000 });
  return fs.readdirSync(tmp).filter((f) => f.startsWith(prefix + '-') && f.endsWith('.png')).sort((a, b) => Number(a.match(/-(\d+)\.png$/)[1]) - Number(b.match(/-(\d+)\.png$/)[1])).map((f) => path.join(tmp, f));
}
const readPng = (p) => PNG.sync.read(fs.readFileSync(p));

function maxAllowedBottom(block, blocks, pageH) {
  const [cx0, , cx1, cy1] = block.bbox;
  let minY0 = pageH;
  for (const b of blocks) {
    if (b === block || !Array.isArray(b.bbox)) continue;
    const [bx0, by0, bx1] = b.bbox;
    if (by0 <= cy1) continue;
    if (bx0 >= cx1 || bx1 <= cx0) continue;
    if (by0 < minY0) minY0 = by0;
  }
  return Math.max(cy1, minY0 - 2);
}
function rect(img, x0, y0, x1, y1, rgb) {
  const { width, height, data } = img;
  const put = (x, y) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255; };
  for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y0 + 1); put(x, y1); put(x, y1 - 1); }
  for (let y = y0; y <= y1; y++) { put(x0, y); put(x0 + 1, y); put(x1, y); put(x1 - 1, y); }
}
// 量化眾數（每通道 16 階），回 { luma, share }
function modeColor(img, pixels) {
  const counts = new Map(); let n = 0;
  for (const [x, y] of pixels) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const i = (y * img.width + x) * 4;
    const k = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
    counts.set(k, (counts.get(k) || 0) + 1); n++;
  }
  if (!n) return null;
  let bk = -1; let bn = 0;
  for (const [k, c] of counts) if (c > bn) { bn = c; bk = k; }
  const r = ((bk >> 8) & 15) * 17; const g = ((bk >> 4) & 15) * 17; const bl = (bk & 15) * 17;
  return { luma: 0.299 * r + 0.587 * g + 0.114 * bl, share: bn / n };
}
function ringModeColor(img, x0, y0, x1, y1) {
  const px = [];
  for (let y = y0 - 4; y <= y1 + 4; y++) for (let x = x0 - 4; x <= x1 + 4; x++) {
    const inside = x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1;
    if (!inside) px.push([x, y]);
  }
  return modeColor(img, px);
}
function innerModeColor(img, x0, y0, x1, y1) {
  const px = [];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 4000)));
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) px.push([x, y]);
  return modeColor(img, px);
}
function lumaAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 255;
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
}

const cases = listCases();
if (cases.length === 0) { console.error('沒有 case'); process.exit(1); }
if (argv.includes('--report-only')) {
  // 不重算像素，只用各 case result.json 內上一次的 visualDiff 重組 SHEETS.md
  const lines = ['# 視覺比對 flag 清單（--report-only 重組）', ''];
  const counts = {};
  let flagged = 0;
  for (const { dir, r } of cases) {
    const vd = r.visualDiff;
    if (!vd) continue;
    const all = [...(vd.caseFlags || []), ...(vd.pageFlags || []).flatMap((p) => p.flags)];
    if (!all.length) continue;
    flagged++;
    lines.push(`## ${r.bucket}/${r.name}`, '');
    for (const f of vd.caseFlags || []) lines.push(`- ${f}`);
    for (const p of vd.pageFlags || []) lines.push(`- p${p.page}：${p.flags.join(' ')} → \`${path.relative(ROOT, path.join(dir, `sheet-${p.page}.png`))}\``);
    lines.push('');
    for (const f of all) { const k = f.split(':')[0]; counts[k] = (counts[k] || 0) + 1; }
  }
  lines.push('## flag 統計（頁次）', '');
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${n}`);
  fs.writeFileSync(path.join(OUT_ROOT, 'SHEETS.md'), lines.join('\n') + '\n', 'utf-8');
  console.log(`=== report-only: ${flagged} / ${cases.length} case 有 flag ===`);
  process.exit(0);
}
const sheetLines = ['# 視覺比對 flag 清單', '', `輸出：${path.relative(ROOT, OUT_ROOT)}；DPI ${DPI}`, ''];
let flaggedCases = 0;
const summary = [];
for (const { dir, r } of cases) {
  const orig = path.join(ROOT, r.file);
  const trans = path.join(dir, 'translated.pdf');
  const layout = JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf-8'));
  const tmp = fs.mkdtempSync(path.join(dir, '.vd-'));
  const caseFlags = [];
  const pageReports = [];
  try {
    const oPages = renderPages(orig, 'o', tmp);
    const tPages = renderPages(trans, 't', tmp);
    if (oPages.length !== tPages.length) caseFlags.push(`page-count:${oPages.length}->${tPages.length}`);
    const n = Math.min(oPages.length, tPages.length, layout.pages.length);
    for (let i = 0; i < n; i++) {
      const o = readPng(oPages[i]);
      const t = readPng(tPages[i]);
      const lp = layout.pages[i];
      const flags = [];
      if (o.width !== t.width || o.height !== t.height) { flags.push(`size:${o.width}x${o.height}->${t.width}x${t.height}`); pageReports.push({ i, flags }); continue; }
      const { width, height } = o;
      // 座標換算：layout 是 viewport scale 1（pt，y 向下）→ px；pdftoppm 對 /Rotate 頁會轉正，
      // layout viewport 同樣是轉正後座標，直接乘 SCALE
      const sx = width / lp.viewport.width;
      const sy = height / lp.viewport.height;
      const diff = new PNG({ width, height });
      const diffCount = pixelmatch(o.data, t.data, diff.data, width, height, { threshold: 0.12, includeAA: false, diffColor: [255, 0, 0], alpha: 0.35 });
      // allowed mask
      const mask = new Uint8Array(width * height);
      const translated = lp.blocks.filter((b) => b.translated && Array.isArray(b.bbox));
      const pad = PAD_PT;
      for (const b of translated) {
        const bottom = maxAllowedBottom(b, lp.blocks, lp.viewport.height);
        const x0 = Math.max(0, Math.floor((b.bbox[0] - pad) * sx)); const x1 = Math.min(width - 1, Math.ceil((b.bbox[2] + pad) * sx));
        const y0 = Math.max(0, Math.floor((b.bbox[1] - pad) * sy)); const y1 = Math.min(height - 1, Math.ceil((bottom + pad) * sy));
        for (let y = y0; y <= y1; y++) mask.fill(1, y * width + x0, y * width + x1 + 1);
      }
      // mask 外差異
      let outside = 0;
      for (let p = 0; p < width * height; p++) {
        const i4 = p * 4;
        const isDiff = diff.data[i4] === 255 && diff.data[i4 + 1] === 0 && diff.data[i4 + 2] === 0;
        if (!isDiff) continue;
        if (mask[p]) { diff.data[i4] = 90; diff.data[i4 + 1] = 90; diff.data[i4 + 2] = 220; } // mask 內差異改藍（預期）
        else outside++;
      }
      if (translated.length > 0 && outside > OUTSIDE_DIFF_MIN && outside / (width * height) > OUTSIDE_DIFF_RATIO) flags.push(`outside-diff:${outside}px`);
      if (translated.length === 0 && outside > OUTSIDE_DIFF_MIN) flags.push(`untouched-page-diff:${outside}px`);
      // bbox 內：unchanged / bg-lost
      const flaggedBlocks = [];
      for (const b of translated) {
        const x0 = Math.max(0, Math.floor(b.bbox[0] * sx)); const x1 = Math.min(width - 1, Math.ceil(b.bbox[2] * sx));
        const y0 = Math.max(0, Math.floor(b.bbox[1] * sy)); const y1 = Math.min(height - 1, Math.ceil(b.bbox[3] * sy));
        const area = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));
        let d = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i4 = (y * width + x) * 4;
          if (diff.data[i4 + 2] === 220 && diff.data[i4] === 90) d++;
        }
        if (area > 400 && d / area < UNCHANGED_RATIO) flaggedBlocks.push({ b, why: 'unchanged' });
        // 底色：與 pdf-renderer 取樣同款——原圖 bbox 外圍環帶（外擴 1–4px）量化眾數為非白且佔比 ≥ 0.6
        // （= renderer 會採用的底色），而譯文圖 bbox 內眾數卻是白 → 遮罩沒吃到底色。舊版取四角
        // 像素在密排文字會踩到鄰行字身，白底文件大量誤報
        const ringMode = ringModeColor(o, x0, y0, x1, y1);
        if (ringMode && ringMode.share >= 0.6 && ringMode.luma < 235) {
          const inner = innerModeColor(t, x0, y0, x1, y1);
          if (inner && inner.luma > 245) flaggedBlocks.push({ b, why: 'bg-lost' });
        }
      }
      const unchanged = flaggedBlocks.filter((f) => f.why === 'unchanged').length;
      const bgLost = flaggedBlocks.filter((f) => f.why === 'bg-lost').length;
      if (unchanged) flags.push(`block-unchanged:${unchanged}`);
      if (bgLost) flags.push(`bg-lost:${bgLost}`);
      pageReports.push({ i, flags, outside, translated: translated.length });
      // contact sheet
      if (flags.length || ALL_SHEETS) {
        for (const b of translated) {
          const x0 = Math.floor(b.bbox[0] * sx); const x1 = Math.ceil(b.bbox[2] * sx); const y0 = Math.floor(b.bbox[1] * sy); const y1 = Math.ceil(b.bbox[3] * sy);
          rect(diff, x0, y0, x1, y1, [40, 90, 230]);
        }
        for (const f of flaggedBlocks) {
          const b = f.b;
          rect(diff, Math.floor(b.bbox[0] * sx) - 2, Math.floor(b.bbox[1] * sy) - 2, Math.ceil(b.bbox[2] * sx) + 2, Math.ceil(b.bbox[3] * sy) + 2, f.why === 'bg-lost' ? [255, 140, 0] : [255, 0, 200]);
        }
        const gap = 8;
        const sheet = new PNG({ width: width * 3 + gap * 2, height });
        sheet.data.fill(128);
        for (const [k, img] of [[0, o], [1, t], [2, diff]]) {
          const ox = k * (width + gap);
          for (let y = 0; y < height; y++) img.data.copy(sheet.data, ((y * sheet.width) + ox) * 4, y * width * 4, (y + 1) * width * 4);
        }
        fs.writeFileSync(path.join(dir, `sheet-${i + 1}.png`), PNG.sync.write(sheet));
      }
    }
  } catch (err) {
    caseFlags.push(`error:${err.message.slice(0, 120)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const pageFlags = pageReports.filter((p) => p.flags.length);
  const allFlags = [...caseFlags, ...pageFlags.flatMap((p) => p.flags.map((f) => `p${p.i + 1}:${f}`))];
  const vd = { pages: pageReports.length, caseFlags, pageFlags: pageFlags.map((p) => ({ page: p.i + 1, flags: p.flags })) };
  r.visualDiff = vd;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 1));
  summary.push({ bucket: r.bucket, name: r.name, flags: allFlags });
  if (allFlags.length) {
    flaggedCases++;
    sheetLines.push(`## ${r.bucket}/${r.name}`, '');
    for (const f of caseFlags) sheetLines.push(`- ${f}`);
    for (const p of pageFlags) sheetLines.push(`- p${p.i + 1}：${p.flags.join(' ')} → \`${path.relative(ROOT, path.join(dir, `sheet-${p.i + 1}.png`))}\``);
    sheetLines.push('');
  }
  console.log(`${allFlags.length ? 'FLAG' : 'ok  '} ${r.bucket}/${r.name}  ${allFlags.slice(0, 6).join(' ')}${allFlags.length > 6 ? ` …+${allFlags.length - 6}` : ''}`);
}
const flagCounts = {};
for (const s of summary) for (const f of s.flags) { const k = f.replace(/^p\d+:/, '').split(':')[0]; flagCounts[k] = (flagCounts[k] || 0) + 1; }
sheetLines.push('## flag 統計（頁次）', '');
for (const [k, n] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) sheetLines.push(`- ${k}: ${n}`);
fs.writeFileSync(path.join(OUT_ROOT, 'SHEETS.md'), sheetLines.join('\n') + '\n', 'utf-8');
console.log(`\n=== pdf-visual-diff: ${flaggedCases} / ${cases.length} case 有 flag ===`);
console.log('SHEETS.md:', path.relative(ROOT, path.join(OUT_ROOT, 'SHEETS.md')));
