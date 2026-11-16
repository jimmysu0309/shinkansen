// probe-ui-i18n-overflow.mjs — 設定頁全分頁 + 工具列圖示選單 × 八語介面的版面機械檢查 + 截圖
//
// 用法：node tools/probes/probe-ui-i18n-overflow.mjs [輸出目錄]
//   預設輸出 .playwright-mcp/ui-i18n/（截圖 + report.json）
//
// 驗的訊號層：
//   - 整頁出現水平捲軸
//   - 可見元素右 / 左緣超出所屬 .tab-panel（popup 為 body）
//   - 按鈕 / 分頁鈕 / label 內文字被切掉（scrollWidth > clientWidth 且 overflow 非 visible）
//   - 按鈕文字折成多行
// 不驗：譯文品質、顏色對比、互動後才出現的狀態（對話框、展開區塊、錯誤訊息）、
//   Safari / Firefox / iOS 的字體寬度差異、有資料時的表格與圖表。截圖仍需人眼看過
import { chromium } from '@playwright/test';
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..', '..');
const ext = path.join(root, 'shinkansen');
const out = path.resolve(process.argv[2] || path.join(root, '.playwright-mcp', 'ui-i18n'));
fs.mkdirSync(out, { recursive: true });
const LANGS = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];

const check = (scopeSel) => {
  const scope = document.querySelector(scopeSel) || document.body;
  const sr = scope.getBoundingClientRect();
  const issues = [];
  const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].join('.') : ''} 「${(el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)}」`;
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    issues.push({ type: 'page-hscroll', by: document.documentElement.scrollWidth - document.documentElement.clientWidth });
  }
  for (const el of scope.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 祖先有水平捲動 / 裁切容器的元素不算超出（表格捲動區等）
    let clipped = false;
    for (let a = el.parentElement; a && a !== scope; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { clipped = true; break; }
    }
    if (!clipped && (r.right > sr.right + 1.5 || r.left < sr.left - 1.5)) {
      issues.push({ type: 'out-of-panel', el: desc(el), by: Math.round(Math.max(r.right - sr.right, sr.left - r.left)) });
    }
    const isCtl = el.matches('button, .tab-btn, label, th, .summary-label, summary, a, h1, h2, h3');
    // 按鈕本身 overflow 是 visible 時，文字會溢出後被外層容器裁掉，一樣算被切
    const isBtn = el.matches('button, .tab-btn');
    if (isCtl && el.scrollWidth > el.clientWidth + 1 && (isBtn || cs.overflowX !== 'visible')) {
      issues.push({ type: 'text-clipped', el: desc(el), by: el.scrollWidth - el.clientWidth, ellipsis: cs.textOverflow === 'ellipsis' });
    }
    if (el.matches('button, .tab-btn') && el.children.length === 0 && el.firstChild) {
      // 用文字本身的行框數判斷折行（按鈕固定高度大於行高時，用高度推算會誤報）
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
      if (tops.size > 1) issues.push({ type: 'button-wrap', el: desc(el), lines: tops.size });
    }
  }
  return issues;
};

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ui-')), {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--mute-audio'],
  viewport: { width: 1100, height: 800 },
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
const report = [];

for (const lang of LANGS) {
  await sw.evaluate((l) => chrome.storage.sync.set({ uiLanguage: l }), lang);
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/options/options.html`);
  await p.waitForTimeout(500);
  const tabs = await p.$$eval('.tab-btn', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.dataset.tab));
  for (const tab of tabs) {
    await p.click(`.tab-btn[data-tab="${tab}"]`);
    await p.waitForTimeout(350);
    const issues = await p.evaluate(check, `#tab-${tab}`);
    const navIssues = tab === tabs[0] ? await p.evaluate(check, '.container') : [];
    const file = `options-${lang}-${tab}.png`;
    await p.screenshot({ path: path.join(out, file), fullPage: true });
    report.push({ page: 'options', lang, tab, file, issues: [...issues, ...navIssues.filter((i) => i.type !== 'out-of-panel' || !issues.some((j) => j.el === i.el))] });
  }
  await p.close();

  const pp = await ctx.newPage();
  await pp.setViewportSize({ width: 280, height: 640 });
  await pp.goto(`chrome-extension://${id}/popup/popup.html`);
  await pp.waitForTimeout(600);
  const pissues = await pp.evaluate(check, 'body');
  const pfile = `popup-${lang}.png`;
  await pp.screenshot({ path: path.join(out, pfile), fullPage: true });
  report.push({ page: 'popup', lang, tab: '-', file: pfile, issues: pissues });
  await pp.close();
}
await ctx.close();

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let total = 0;
for (const r of report) {
  if (!r.issues.length) continue;
  total += r.issues.length;
  console.log(`\n[${r.page} ${r.lang} ${r.tab}] ${r.issues.length}`);
  for (const i of r.issues.slice(0, 12)) console.log('  ', JSON.stringify(i));
  if (r.issues.length > 12) console.log(`   …另 ${r.issues.length - 12} 條`);
}
console.log(`\n${report.length} 個畫面，${total} 條機械命中；輸出 ${out}`);
