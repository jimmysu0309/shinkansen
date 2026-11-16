#!/usr/bin/env node
// probe-doc-cache-migration.mjs — 升級時自動清文件翻譯快取（v2.6.9 一次性 migration）的真實路徑驗證
//
// 用法：node tools/probes/probe-doc-cache-migration.mjs
// 做法：全新 profile 載入擴充功能 → 在擴充功能頁面塞幾筆假快取（文件 / 網頁 / 字幕 / 術語表）並拿掉
//   migration 旗標（模擬「舊版留下快取、還沒跑過這次清除」）→ 關掉瀏覽器、同一個 profile 重開
//   （service worker 重新啟動 = 升級後第一次啟動會走的路）→ 讀回 storage。
// 驗的層次：真實 service worker 啟動時真的跑了清除、範圍正確。不驗：商店自動更新本身的觸發（onInstalled）。
import { chromium } from 'playwright';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXT = process.env.SK_EXT_PATH || path.join(ROOT, 'shinkansen');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mig-'));
const FLAG = '__shinkansen_v269_doc_cache_cleared';
const A = 'a'.repeat(40);
const seed = { [`tc_${A}_doc_mgemini-3-flash-lite`]: { v: 'doc', t: 1 }, [`tc_${A}_oc_doc`]: { v: 'doc2', t: 1 },
  [`tc_${A}`]: { v: 'web', t: 1 }, [`tc_${A}_yt`]: { v: 'yt', t: 1 }, [`gloss_${A}`]: { v: 'g', t: 1 }, bookgloss_x: { v: 'bg' } };
const launch = () => chromium.launchPersistentContext(ud, { headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio'] });
const open = async (ctx) => {
  let [w] = ctx.serviceWorkers(); if (!w) w = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${w.url().split('/')[2]}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  return page;
};
try {
  let ctx = await launch(); let page = await open(ctx);
  await page.waitForTimeout(1500);
  console.log('首次啟動後旗標：', await page.evaluate((f) => chrome.storage.local.get(f), FLAG));
  await page.evaluate(async ({ seed, f }) => { await chrome.storage.local.set(seed); await chrome.storage.local.remove(f); }, { seed, f: FLAG });
  await ctx.close();
  ctx = await launch(); page = await open(ctx);
  await page.waitForTimeout(2000);
  const after = await page.evaluate((keys) => chrome.storage.local.get(keys), [...Object.keys(seed), FLAG]);
  for (const k of Object.keys(seed)) console.log(k in after && after[k] !== undefined ? '保留' : '清掉', k.replace(A, '<sha1>'));
  console.log('旗標：', after[FLAG], '版本：', await page.evaluate(() => chrome.runtime.getManifest().version));
  await ctx.close();
} finally { fs.rmSync(ud, { recursive: true, force: true }); }
