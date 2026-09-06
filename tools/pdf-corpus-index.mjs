#!/usr/bin/env node
// pdf-corpus-index.mjs — PDF 語料自動打標 → INDEX.md / INDEX.json；覆蓋度；代表檔挑選
//
// 計劃：docs/excluded/planning/pdf-test-plan.md §1.3（打標）/ §1.5（--pick 貪婪 set cover）
//
// 用法：
//   node tools/pdf-corpus-index.mjs                 # 靜態打標（pdfinfo / pdffonts / qpdf / pdfimages）
//                                                   # + 合併最近一次 pdf-corpus-verify 的動態標籤 → INDEX
//   node tools/pdf-corpus-index.mjs --coverage      # 印每個特性幾檔命中、哪些特性 0 檔
//   node tools/pdf-corpus-index.mjs --pick [N]      # 貪婪 set cover 挑 N 檔（預設 10）代表檔，強制含翻車三檔
//
// 特性標籤（= pdf-test-plan §2 覆蓋矩陣的觸發特徵）：
//   靜態：encrypted / rotate / mixed-page-size / landscape / big-page / tagged / type3 / cid-font /
//         font-no-unicode / non-embedded-font / acroform / link-annot / outline / objstm / linearized /
//         incremental / xref-damaged / image-heavy / many-pages / big-file
//   動態（pdf-corpus-verify 結果）：multi-column / heading / list / footnote / page-number / cjk-source /
//         rtl / bold / italic / links / tiny-font / huge-font / garbled-fonts / rotated-text / empty-page /
//         overflow-actual / ir-issues / parse-negative
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PDF_DIR = path.join(ROOT, 'docs/excluded/test pdf');
const CORPUS_DIR = path.join(PDF_DIR, 'corpus');
const argv = process.argv.slice(2);
const COVERAGE = argv.includes('--coverage');
const pickIdx = argv.indexOf('--pick');
const PICK = pickIdx >= 0 ? Number(argv[pickIdx + 1] || 10) || 10 : 0;
const FORCE_PICK = ['Plano', 'Quotation', 'Trimble'];

function run(cmd, args, opt = {}) {
  try { return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...opt }); }
  catch (err) { return err.stdout || ''; }
}
function listFiles() {
  const out = [];
  const push = (bucket, dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) if (/\.pdf$/i.test(f)) out.push({ bucket, name: f, file: path.join(dir, f) });
  };
  push('business', PDF_DIR);
  push('failed pdf', path.join(PDF_DIR, 'failed pdf'));
  if (fs.existsSync(CORPUS_DIR)) for (const b of fs.readdirSync(CORPUS_DIR).sort()) {
    const d = path.join(CORPUS_DIR, b);
    if (fs.statSync(d).isDirectory()) push(b, d);
  }
  return out;
}

// ---- 靜態打標 ----
function staticTags(file) {
  const tags = new Set();
  const info = run('pdfinfo', [file]);
  const get = (k) => (info.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1] || '';
  const pages = Number(get('Pages')) || 0;
  if (/yes/.test(get('Encrypted'))) tags.add('encrypted');
  if (get('Page rot') && get('Page rot') !== '0') tags.add('rotate');
  if (/yes/.test(get('Tagged'))) tags.add('tagged');
  const ps = get('Page size');
  const m = ps.match(/([\d.]+) x ([\d.]+)/);
  if (m) {
    const [w, h] = [Number(m[1]), Number(m[2])];
    if (w > h) tags.add('landscape');
    if (w > 1000 || h > 1400) tags.add('big-page');
  }
  if (pages > 40) tags.add('many-pages');
  const bytes = fs.statSync(file).size;
  if (bytes > 8 * 1024 * 1024) tags.add('big-file');
  // 混合頁尺寸：pdfinfo -f 1 -l N 列每頁尺寸
  if (pages > 1 && pages <= 400) {
    const all = run('pdfinfo', ['-f', '1', '-l', String(pages), file]);
    const sizes = new Set([...all.matchAll(/^Page\s+\d+ size:\s*(.+)$/gm)].map((x) => x[1].replace(/\s*\(.*\)$/, '')));
    if (sizes.size > 1) tags.add('mixed-page-size');
    const rots = new Set([...all.matchAll(/^Page\s+\d+ rot:\s*(\d+)$/gm)].map((x) => x[1]));
    if (rots.size > 1 || (rots.size === 1 && ![...rots][0].startsWith('0'))) tags.add('rotate');
  }
  const fonts = run('pdffonts', [file]);
  const fontRows = fonts.split('\n').slice(2).filter((l) => l.trim());
  for (const l of fontRows) {
    const cols = l.trim().split(/\s{2,}/);
    const type = cols[1] || '';
    if (/Type 3/.test(type)) tags.add('type3');
    if (/CID/.test(type)) tags.add('cid-font');
    // 欄位：name type encoding emb sub uni
    const tail = l.trim().split(/\s+/);
    const uniIdx = tail.length - 3; // ... emb sub uni object ID → uni 在倒數第 3
    if (tail[uniIdx] === 'no') tags.add('font-no-unicode');
    if (tail[uniIdx - 2] === 'no') tags.add('non-embedded-font');
  }
  if (fontRows.length === 0 && pages > 0) tags.add('no-fonts');
  // qpdf --json：annots / AcroForm / objstm / linearized / 增量更新 / xref 壞
  const qj = run('qpdf', ['--json', '--json-key=pages', '--json-key=acroform', '--json-key=objectinfo', file]);
  if (qj) {
    try {
      const j = JSON.parse(qj);
      const annots = [];
      for (const p of (j.pages || [])) for (const a of (p.annotations || [])) annots.push(a);
      // pages[].annotations 只有 object ref，用 --show-npages 之外的簡易法：直接掃原檔字串
    } catch { /* qpdf 對壞檔可能輸出非 JSON */ }
  }
  const head = fs.readFileSync(file).toString('latin1');
  if (/\/AcroForm/.test(head)) tags.add('acroform');
  if (/\/Subtype\s*\/Link/.test(head)) tags.add('link-annot');
  if (/\/Subtype\s*\/Widget/.test(head)) tags.add('form-widget');
  if (/\/Outlines/.test(head)) tags.add('outline');
  if (/\/Type\s*\/ObjStm/.test(head)) tags.add('objstm');
  if (/\/Linearized/.test(head)) tags.add('linearized');
  if ((head.match(/%%EOF/g) || []).length > 1) tags.add('incremental');
  if (/\/Type\s*\/XObject[^>]*\/Subtype\s*\/Image/.test(head) || /\/Subtype\s*\/Image/.test(head)) tags.add('has-image');
  const check = run('qpdf', ['--check', file]);
  if (/xref|damaged|recover|error/i.test(check) && !/No syntax or stream encoding errors found/.test(check)) tags.add('xref-damaged');
  // 影像面積佔比（掃描判定）：pdfimages -list
  const imgs = run('pdfimages', ['-list', file]);
  const imgRows = imgs.split('\n').slice(2).filter((l) => l.trim());
  if (imgRows.length >= pages && pages > 0) {
    let bigImgPages = 0;
    const seen = new Set();
    for (const l of imgRows) {
      const c = l.trim().split(/\s+/);
      const [pg, , type, w, h] = [c[0], c[1], c[2], Number(c[3]), Number(c[4])];
      if (type === 'image' && w * h > 800 * 800 && !seen.has(pg)) { seen.add(pg); bigImgPages++; }
    }
    if (bigImgPages >= Math.max(1, pages * 0.5)) tags.add('image-heavy');
  }
  return { tags: [...tags], pages, bytes, producer: get('Producer') };
}

// ---- 動態標籤（合併最近一次 corpus-verify 報表）----
function loadDynamic() {
  const dirs = fs.readdirSync(PDF_DIR).filter((d) => /test pdf output$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(PDF_DIR, d, 'pdf-corpus-report.json');
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const map = new Map();
      for (const r of arr) map.set(`${r.bucket}/${r.name}`, r);
      return { date: d, map };
    }
  }
  return { date: null, map: new Map() };
}
function dynamicTags(r) {
  const tags = new Set();
  if (!r) return tags;
  if (r.status.startsWith('NEG')) { tags.add('parse-negative'); tags.add(`neg-${r.status.slice(4, -1)}`); return tags; }
  if (r.status === 'FAIL' && r.error && r.error.startsWith('parse:')) { tags.add('parse-fail'); return tags; }
  const d = r.doc;
  if (!d) return tags;
  if (d.maxColumnCount >= 2) tags.add('multi-column');
  if (d.maxColumnCount >= 3) tags.add('three-column');
  for (const t of Object.keys(d.typeCounts || {})) if (t !== 'paragraph') tags.add(t);
  if (d.cjkRatio >= 0.3) tags.add('cjk-source');
  if (d.rtlRatio >= 0.2) tags.add('rtl');
  if (d.boldSegments > 0) tags.add('bold');
  if (d.italicSegments > 0) tags.add('italic');
  if (d.linkUrls > 0) tags.add('links');
  if (d.tinyFontBlocks > 0) tags.add('tiny-font');
  if (d.hugeFontBlocks > 0) tags.add('huge-font');
  for (const w of d.warnings || []) tags.add(w === 'rotated-text-dropped' ? 'rotated-text' : w);
  if (d.emptyPages > 0) tags.add('empty-page');
  if (r.overflow?.actual > 0) tags.add('overflow-actual');
  if (r.structure?.issueCount > 0) tags.add('ir-issues');
  if (r.bold?.lost > 0) tags.add('bold-lost');
  if (r.links?.lost > 0) tags.add('links-lost');
  if (r.textLayer?.missing > 0) tags.add('missing-pseudo');
  if (r.drawSkips && r.drawSkips.count > r.drawSkips.probeEmojiBlocks) tags.add('draw-skip');
  return tags;
}

// ---- 主流程 ----
const files = listFiles();
const dyn = loadDynamic();
const indexPath = path.join(CORPUS_DIR, 'INDEX.json');
let index;
if (PICK || COVERAGE) {
  if (!fs.existsSync(indexPath)) { console.error('先跑一次不帶參數的 index 產生 INDEX.json'); process.exit(1); }
  index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
} else {
  index = [];
  for (const f of files) {
    const st = staticTags(f.file);
    const r = dyn.map.get(`${f.bucket}/${f.name}`);
    const tags = [...new Set([...st.tags, ...dynamicTags(r)])].sort();
    index.push({ bucket: f.bucket, name: f.name, pages: st.pages, bytes: st.bytes, producer: st.producer, blocks: r?.doc?.totalBlocks ?? null, status: r?.status ?? null, tags });
    process.stdout.write('.');
  }
  console.log('');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1), 'utf-8');
  const lines = [`# PDF 測試語料清單（${index.length} 檔，不入 repo）`, '',
    `> 靜態標籤來自 pdfinfo / pdffonts / qpdf / pdfimages；動態標籤合併自 ${dyn.date ? dyn.date + ' 的 pdf-corpus-verify 報表' : '（尚未跑 pdf-corpus-verify）'}。`,
    '> 來源與授權見 SOURCES.json；僅本機測試用，不隨產品散布。', '',
    '| bucket | 檔案 | 頁 | KB | blocks | 狀態 | 特性 |', '|---|---|---|---|---|---|---|'];
  for (const e of index) lines.push(`| ${e.bucket} | ${e.name} | ${e.pages} | ${Math.round(e.bytes / 1024)} | ${e.blocks ?? '-'} | ${e.status ?? '-'} | ${e.tags.join(', ') || '—'} |`);
  fs.writeFileSync(path.join(CORPUS_DIR, 'INDEX.md'), lines.join('\n') + '\n', 'utf-8');
  console.log(`INDEX.md / INDEX.json 已更新（${index.length} 檔）`);
}

const ALL_TAGS = ['encrypted', 'rotate', 'mixed-page-size', 'landscape', 'big-page', 'tagged', 'type3', 'cid-font', 'font-no-unicode', 'non-embedded-font', 'acroform', 'form-widget', 'link-annot', 'outline', 'objstm', 'linearized', 'incremental', 'xref-damaged', 'image-heavy', 'has-image', 'many-pages', 'big-file',
  'multi-column', 'three-column', 'heading', 'list-item', 'footnote', 'page-number', 'cjk-source', 'rtl', 'bold', 'italic', 'links', 'tiny-font', 'huge-font', 'garbled-fonts', 'rotated-text', 'empty-page', 'overflow-actual', 'ir-issues', 'parse-negative'];
if (COVERAGE || PICK) {
  const counts = {};
  for (const t of ALL_TAGS) counts[t] = index.filter((e) => e.tags.includes(t)).length;
  if (COVERAGE) {
    console.log('特性覆蓋（檔數）：');
    for (const t of ALL_TAGS) console.log(`  ${counts[t] === 0 ? '✗' : ' '} ${t.padEnd(20)} ${counts[t]}`);
    console.log('0 檔特性：', ALL_TAGS.filter((t) => counts[t] === 0).join(', ') || '無');
  }
}
if (PICK) {
  // 貪婪 set cover：只在「可翻譯成功」的檔中挑（parse-negative 不進真翻名單）
  const pool = index.filter((e) => !e.tags.includes('parse-negative') && !e.tags.includes('parse-fail') && e.status && e.status !== 'FAIL');
  const covered = new Set();
  const picked = [];
  for (const kw of FORCE_PICK) {
    const e = pool.find((x) => x.name.toLowerCase().includes(kw.toLowerCase()));
    if (e) { picked.push({ ...e, reason: '翻車紀錄強制入選' }); for (const t of e.tags) covered.add(t); }
  }
  const target = new Set(ALL_TAGS.filter((t) => index.some((e) => e.tags.includes(t))));
  while (picked.length < PICK) {
    let best = null; let bestGain = 0;
    for (const e of pool) {
      if (picked.some((p) => p.name === e.name && p.bucket === e.bucket)) continue;
      const gain = e.tags.filter((t) => target.has(t) && !covered.has(t)).length;
      // 同 gain 偏好頁數少的（真翻成本低）
      if (gain > bestGain || (gain === bestGain && best && gain > 0 && e.pages < best.pages)) { best = e; bestGain = gain; }
    }
    if (!best || bestGain === 0) break;
    picked.push({ ...best, reason: '新增覆蓋：' + best.tags.filter((t) => target.has(t) && !covered.has(t)).join(', ') });
    for (const t of best.tags) covered.add(t);
  }
  const uncovered = [...target].filter((t) => !covered.has(t));
  console.log(`代表檔（${picked.length}）：`);
  for (const p of picked) console.log(`  - ${p.bucket}/${p.name}（${p.pages} 頁）— ${p.reason}`);
  console.log('未覆蓋特性：', uncovered.join(', ') || '無');
  fs.writeFileSync(path.join(CORPUS_DIR, 'PICK.json'), JSON.stringify(picked.map((p) => ({ bucket: p.bucket, name: p.name, reason: p.reason })), null, 1), 'utf-8');
  console.log('已寫 corpus/PICK.json');
}
