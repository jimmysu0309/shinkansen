// Shinkansen 真實站點 debug harness（v1.6.11 起）
//
// 為什麼不用 test/fixtures/extension.js:
//   - test/regression/* 是 fixture-based forcing function（鎖行為不回歸），
//     用最小 HTML 抽出結構特徵驗證演算法
//   - 本 harness 是 probe tool:跑真實站點的真實 DOM,觀察 extension 在
//     有第三方廣告 / SPA / lazy-load / 整站 wrapper 的環境下實際行為
//   - fixture 過了不代表真實站點過,真實站點才會出現「div.wp-site-blocks
//     後代 p 太多贏過真主文」這種競爭 candidate（Shinkansen 之前有過：
//     維基百科 ambox v0.51-v0.54 三輪修復都是因為 fixture 沒抓到競爭結構）
//
// 用法（不需要 Chrome MCP，也不需要使用者介入）:
//   node tools/debug-harness.js
//   TARGET_URL=https://en.wikipedia.org/wiki/Taiwan node tools/debug-harness.js
//   node tools/debug-harness.js --keep              # 不關 browser,留著看
//   node tools/debug-harness.js --no-translate      # 只開頁面+截圖,不觸發翻譯
//   node tools/debug-harness.js --fresh             # 砍 user data dir 重新來
//   SHINKANSEN_HEADED=1 node tools/debug-harness.js # 顯示視窗（除錯用,會搶 focus）
//
// 截圖會存到 .playwright-mcp/before-*.png 與 after-*.png。
// 結束後 Read 這幾張肉眼驗,搭配 stdout 的 PAGE>/SW> log + DOM 翻譯狀態判斷。
//
// 重要:dispatch Debug Bridge CustomEvent 必須走 isolated world(CDP）,page.evaluate
// 走 main world,看不到 content script 的 listener。詳見 CLAUDE.md「Regression test
// 撰寫常見坑」段落。

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXT_PATH = path.resolve(__dirname, '..', 'shinkansen');
const TARGET_URL = process.env.TARGET_URL || 'https://en.wikipedia.org/wiki/Taiwan';
const HEADED = process.env.SHINKANSEN_HEADED === '1';
const KEEP = process.argv.includes('--keep');
const NO_TRANSLATE = process.argv.includes('--no-translate');
const FRESH = process.argv.includes('--fresh');
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '.playwright-mcp');
const PERSISTENT_PROFILE = path.resolve(os.tmpdir(), 'shinkansen-debug-pw-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 截圖容錯包裝:長頁(Wikipedia/論壇)的 fullPage screenshot 會超時,給更長 timeout
// 並 try/catch 不中斷整個流程——viewport 截圖通常都能拿到,fullPage 是 nice-to-have
async function safeScreenshot(page, opts) {
  try {
    await page.screenshot({ ...opts, timeout: 90000 });
    return true;
  } catch (err) {
    console.log(`[harness] screenshot 失敗 (${opts.path}):`, err.message.slice(0, 120));
    return false;
  }
}

// CDP 取 Shinkansen 的 isolated world execution context。
// 跟 test/regression/helpers/run-inject.js 的 getShinkansenEvaluator 同套邏輯,
// 只是這裡是 Node 端 standalone 不是 Playwright fixture。
async function getIsolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  cdp.on('Runtime.executionContextDestroyed', (e) => {
    const idx = contexts.findIndex((c) => c.id === e.executionContextId);
    if (idx >= 0) contexts.splice(idx, 1);
  });
  await cdp.send('Runtime.enable');
  await sleep(500);

  const isolated = contexts.filter((c) => c?.auxData?.type === 'isolated');
  let target = isolated.find((c) => c.name === 'Shinkansen')
    || isolated.find((c) => /Shinkansen/i.test(c.name || ''));
  if (!target) {
    const dump = isolated.map((c) => ({ id: c.id, name: c.name, origin: c.origin }));
    throw new Error(`找不到 Shinkansen isolated world。候選: ${JSON.stringify(dump, null, 2)}`);
  }

  async function evaluate(expression) {
    const r = await cdp.send('Runtime.evaluate', {
      contextId: target.id, expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`evaluate 失敗: ${r.exceptionDetails.text}\nexpression: ${expression}`);
    }
    return r.result.value;
  }
  return { evaluate, contextId: target.id };
}

// 透過 Debug Bridge CustomEvent 觸發 content script 的 action。
// listener 與 dispatch 都必須在同一個 world,所以包進 isolated world evaluate。
async function debugBridge(evaluate, action, opts = {}) {
  const { afterSeq = 0, timeoutMs = 60000 } = opts;
  return await evaluate(`
    new Promise((resolve) => {
      const onResp = (e) => {
        window.removeEventListener('shinkansen-debug-response', onResp);
        resolve(e.detail);
      };
      window.addEventListener('shinkansen-debug-response', onResp);
      window.dispatchEvent(new CustomEvent('shinkansen-debug-request',
        { detail: { action: ${JSON.stringify(action)}, afterSeq: ${afterSeq} } }));
      setTimeout(() => {
        window.removeEventListener('shinkansen-debug-response', onResp);
        resolve({ ok: false, error: 'TIMEOUT' });
      }, ${timeoutMs});
    })
  `);
}

async function main() {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error(`找不到 extension manifest: ${EXT_PATH}/manifest.json`);
  }
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (FRESH) {
    fs.rmSync(PERSISTENT_PROFILE, { recursive: true, force: true });
  }
  fs.mkdirSync(PERSISTENT_PROFILE, { recursive: true });

  console.log('[harness] EXT_PATH:', EXT_PATH);
  console.log('[harness] TARGET_URL:', TARGET_URL);
  console.log('[harness] profile dir:', PERSISTENT_PROFILE);
  console.log('[harness] mode:', HEADED ? 'headed' : 'headless=new');

  const ctx = await chromium.launchPersistentContext(PERSISTENT_PROFILE, {
    headless: false,  // 必須 false,真正的 headless 會壞 SW
    viewport: { width: 1280, height: 900 },
    args: [
      ...(HEADED ? [] : ['--headless=new']),  // Chrome 原生新 headless,SW 仍正常
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',   // Jimmy 指示(2026-08-06):playwright 測試(含 YouTube)一律靜音
    ],
  });

  // 等 service worker 起來
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('[harness] SW URL:', sw.url());
  sw.on('console', (m) => console.log(`SW> ${m.type()}`, m.text().slice(0, 300)));

  // SEED_SYNC:navigate 前種入 chrome.storage.sync(JSON 字串)。用途:重現依賴
  // 設定的自動路徑(例 autoConvertZh 的 document_idle 競態,GET_STORAGE 唯讀不夠)
  //   SEED_SYNC='{"autoConvertZh":true}' TARGET_URL=... node tools/debug-harness.js --no-translate
  if (process.env.SEED_SYNC) {
    const seed = JSON.parse(process.env.SEED_SYNC);
    await sw.evaluate((s) => new Promise((res) => chrome.storage.sync.set(s, res)), seed);
    console.log('[harness] SEED_SYNC 已種入:', Object.keys(seed).join(', '));
  }

  // 關掉 extension 載入前已存在的 about:blank tab(content script 不會回頭注入)
  for (const p of ctx.pages()) { try { await p.close(); } catch { /* ignore */ } }

  const page = await ctx.newPage();
  page.on('console', (m) => {
    const txt = m.text();
    // 過濾掉 extension 自己的 SK> log(會 spammy);只留 PAGE 自身與 error
    if (m.type() === 'error' || !/^\[Shinkansen/.test(txt)) {
      console.log(`PAGE> ${m.type()}`, txt.slice(0, 200));
    }
  });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

  // THROTTLE_CPU:CDP CPU 降速倍率(例 6 = 6 倍慢)。用途:翻轉「content script
  // document_idle 注入 vs SPA hydration」時序,重現 hydration 沖銷競態
  if (process.env.THROTTLE_CPU) {
    const rate = Number(process.env.THROTTLE_CPU) || 1;
    const throttleCdp = await page.context().newCDPSession(page);
    await throttleCdp.send('Emulation.setCPUThrottlingRate', { rate });
    console.log(`[harness] CPU throttle x${rate}`);
  }

  console.log(`[harness] navigate → ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);  // 等 document_idle 的 content script 跑完 init

  const { evaluate } = await getIsolatedEvaluator(page);

  // ─── 翻譯前狀態 + 截圖 ─────
  const beforeState = await debugBridge(evaluate, 'GET_STATE');
  console.log('[harness] before state:', beforeState);

  await page.evaluate(() => { document.body.style.zoom = '0.5'; });
  await sleep(300);
  await safeScreenshot(page, { path: path.join(SCREENSHOT_DIR, 'before-viewport.png') });
  await safeScreenshot(page, { path: path.join(SCREENSHOT_DIR, 'before-fullpage.png'), fullPage: true });
  await page.evaluate(() => { document.body.style.zoom = ''; });

  if (NO_TRANSLATE) {
    console.log('[harness] --no-translate,跳過翻譯,只截圖前態');
  } else {
    // 清快取確保走真實 API 路徑(不走 cache hit)
    console.log('[harness] CLEAR_CACHE + CLEAR_LOGS...');
    await debugBridge(evaluate, 'CLEAR_CACHE');
    await debugBridge(evaluate, 'CLEAR_LOGS');

    // 觸發翻譯
    console.log('[harness] TRANSLATE...');
    const trigger = await debugBridge(evaluate, 'TRANSLATE');
    console.log('[harness] trigger response:', trigger);

    // 輪詢等翻譯完成(translating === false 且 translated === true)
    const POLL_MS = 500;
    const MAX_POLLS = 240;  // 120s
    let pollCount = 0;
    let lastSegmentCount = -1;
    while (pollCount < MAX_POLLS) {
      const state = await debugBridge(evaluate, 'GET_STATE');
      if (state.segmentCount !== lastSegmentCount) {
        console.log(`[harness] poll ${pollCount}: translating=${state.translating} translated=${state.translated} segments=${state.segmentCount}`);
        lastSegmentCount = state.segmentCount;
      }
      if (!state.translating && state.translated && state.segmentCount > 0) {
        console.log(`[harness] 翻譯完成,segments=${state.segmentCount}`);
        break;
      }
      await sleep(POLL_MS);
      pollCount++;
    }
    if (pollCount === MAX_POLLS) {
      console.log('[harness] 翻譯 120s 逾時,繼續往下做');
    }

    const afterState = await debugBridge(evaluate, 'GET_STATE');
    console.log('[harness] after state:', afterState);

    // 拉 log 顯示 warn/error
    const logs = await debugBridge(evaluate, 'GET_LOGS', { afterSeq: 0 });
    if (logs && logs.ok && Array.isArray(logs.logs)) {
      const interesting = logs.logs.filter((l) => l.level === 'warn' || l.level === 'error');
      console.log(`[harness] log 共 ${logs.logs.length} 條,warn/error ${interesting.length} 條`);
      for (const l of interesting.slice(0, 30)) {
        console.log(`  [${l.level}] ${l.category}: ${l.message}`);
        if (l.data) console.log(`         data:`, JSON.stringify(l.data).slice(0, 200));
      }
    }
  }

  // PROBE_WAIT_MS:DOM dump / probe 前額外等待(例等 SPA hydration 沖銷發生)
  if (process.env.PROBE_WAIT_MS) {
    const extra = Number(process.env.PROBE_WAIT_MS) || 0;
    console.log(`[harness] PROBE_WAIT_MS:額外等待 ${extra}ms`);
    await sleep(extra);
  }

  // ─── DOM 副作用 dump ─────
  // 這段走 main world page.evaluate 即可——只讀 shared DOM(data-* attribute、
  // custom element），不碰 isolated world 的 window.__SK
  const domSummary = await page.evaluate(() => {
    const translated = document.querySelectorAll('[data-shinkansen-translated]');
    const dualSource = document.querySelectorAll('[data-shinkansen-dual-source]');
    const dualWrappers = document.querySelectorAll('shinkansen-translation');
    const sample = (nodes, n) => Array.from(nodes).slice(0, n).map((el) => ({
      tag: el.tagName,
      classes: (el.className && el.className.toString().slice(0, 80)) || '',
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    }));
    return {
      translatedCount: translated.length,
      dualSourceCount: dualSource.length,
      dualWrapperCount: dualWrappers.length,
      sampleTranslated: sample(translated, 8),
      sampleDualWrapper: sample(dualWrappers, 4),
    };
  });
  console.log('[harness] DOM 翻譯狀態:');
  console.log(JSON.stringify(domSummary, null, 2));

  // PROBE_EXPR:結尾在 isolated world 執行任意 expression(可讀 window.__SK 內部
  // state,例 STATE.nodeValueMutateBackup.size)。除錯專用,結果 JSON 印出:
  //   PROBE_EXPR='window.__SK.STATE.translatedBy' node tools/debug-harness.js ...
  if (process.env.PROBE_EXPR) {
    try {
      // async IIFE 亦可(evaluate 帶 awaitPromise:true)
      const probeResult = await evaluate(`(async () => JSON.stringify(await (${process.env.PROBE_EXPR})))()`);
      console.log('[harness] PROBE_EXPR 結果:', probeResult);
    } catch (e) {
      console.log('[harness] PROBE_EXPR 失敗:', e.message);
    }
  }


  // ─── 翻譯後截圖 ─────
  await page.evaluate(() => { document.body.style.zoom = '0.5'; });
  await sleep(300);
  await safeScreenshot(page, { path: path.join(SCREENSHOT_DIR, 'after-viewport.png') });
  await safeScreenshot(page, { path: path.join(SCREENSHOT_DIR, 'after-fullpage.png'), fullPage: true });
  console.log(`[harness] 截圖存到 ${SCREENSHOT_DIR}/`);
  console.log('[harness] 用 Read tool 看 after-fullpage.png 肉眼驗排版');

  if (KEEP) {
    console.log('[harness] --keep:browser 保持開啟,Ctrl+C 結束');
    await new Promise(() => { /* 永不 resolve */ });
  } else {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error('[harness] 失敗:', e.message);
  console.error(e.stack);
  process.exit(1);
});
