// probe-yt-multi-asr-chooser.mjs — 載 extension(dev tail)到真實自動配音影片,
// 走 Debug Bridge YT_TRANSLATE 觸發 chooser,讀 'caption track chooser' log 與切軌後 activeTrack,
// 驗「多條 ASR 時挑到原音 ASR」整條真實路徑(對應 test/regression/youtube-multi-asr-source.spec.js
// 與 jest yt-caption-track-chooser 多 ASR case;真實回報影片 BiN5ERktXz0)。
// 不需 API key:chooser 在翻譯之前跑,翻譯本身失敗不影響本 probe 觀察的訊號。
//
// 用法: VIDEO_ID=BiN5ERktXz0 node tools/probes/probe-yt-multi-asr-chooser.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..', '..', 'shinkansen');
const VIDEO_ID = process.env.VIDEO_ID || 'BiN5ERktXz0';
const TARGET_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const PROFILE = path.resolve(os.tmpdir(), 'shinkansen-yt-probe-profile-multi-asr');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getIsolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(500);
  const target = contexts.filter((c) => c?.auxData?.type === 'isolated').find((c) => /Shinkansen/i.test(c.name || ''));
  if (!target) throw new Error('找不到 Shinkansen isolated world');
  return async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { contextId: target.id, expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
}

const bridge = (action, extra = {}) => `
  new Promise((r) => {
    window.addEventListener('shinkansen-debug-response', (e) => r(JSON.stringify(e.detail)), { once: true });
    window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: ${JSON.stringify({ action, ...extra })} }));
    setTimeout(() => r('"TIMEOUT"'), 5000);
  })`;

async function main() {
  if (process.env.FRESH === '1') fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log('[probe] TARGET_URL:', TARGET_URL);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-TW',
    args: [
      ...(process.env.SHINKANSEN_HEADED === '1' ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await ctx.newPage();
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/timedtext')) {
      const u = new URL(url);
      console.log(`[probe] timedtext RES: lang=${u.searchParams.get('lang')} kind=${u.searchParams.get('kind')} tlang=${u.searchParams.get('tlang')}`);
    }
  });
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  try { await page.evaluate(() => document.querySelector('video')?.play().catch(() => {})); } catch (_) {}
  await sleep(2000);

  const evaluate = await getIsolatedEvaluator(page);
  const state0 = JSON.parse(await evaluate(bridge('GET_STATE')));
  console.log('[probe] version:', state0?.version, ' yt.active(before):', state0?.yt?.active);

  const dumpChooserLogs = async (label) => {
    const logs = JSON.parse(await evaluate(bridge('GET_LOGS', { afterSeq: 0 })))?.logs || [];
    const chooserLogs = logs.filter((l) => /chooser/i.test(JSON.stringify(l)));
    console.log(`[probe] ${label} chooser 相關 log(${chooserLogs.length} 條):`);
    for (const l of chooserLogs) console.log('  ', JSON.stringify(l).slice(0, 700));
  };
  // 自動啟動 session(autoTranslate 預設)的 chooser 決策
  await dumpChooserLogs('auto session');

  // 模擬使用者回報狀態:字幕停在 ja 配音 ASR 軌,再手動觸發 Shinkansen 字幕翻譯
  if (state0?.yt?.active) { await evaluate(bridge('YT_STOP')); await sleep(1000); }
  await page.evaluate(() => {
    const p = document.querySelector('#movie_player');
    p?.setOption?.('captions', 'track', { languageCode: 'ja', kind: 'asr' });
  });
  await sleep(2500);
  const before = await page.evaluate(() => document.querySelector('#movie_player')?.getOption?.('captions', 'track'));
  console.log('[probe] activeTrack 手動切 ja 後(觸發前):', JSON.stringify({ languageCode: before?.languageCode, kind: before?.kind }));
  await evaluate(bridge('CLEAR_LOGS'));
  console.log('[probe] YT_TRANSLATE →', (await evaluate(bridge('YT_TRANSLATE'))).slice(0, 200));
  await sleep(8000);
  await dumpChooserLogs('manual trigger');

  const detail = JSON.parse(await evaluate(`
    new Promise((resolve) => {
      window.addEventListener('shinkansen-yt-player-response', (e) => resolve(JSON.stringify(e.detail)), { once: true });
      window.dispatchEvent(new CustomEvent('shinkansen-yt-query-player-response'));
      setTimeout(() => resolve('"TIMEOUT"'), 3000);
    })`));
  console.log('[probe] bridge hints:', JSON.stringify({ defaultCaptionTrackIndex: detail?.defaultCaptionTrackIndex, originalAudioLang: detail?.originalAudioLang }));
  console.log('[probe] asr tracks:', (detail?.captionTracks || []).filter((t) => t.kind === 'asr').map((t) => t.languageCode).join(','));
  console.log('[probe] activeTrack after chooser:', JSON.stringify(detail?.activeTrack));

  const state1 = JSON.parse(await evaluate(bridge('GET_STATE')));
  console.log('[probe] yt state after:', JSON.stringify({ active: state1?.yt?.active, captionLang: state1?.yt?.captionLang, isAsr: state1?.yt?.isAsr, rawCount: state1?.yt?.rawCount }));
  await ctx.close();
}

main().catch((e) => { console.error('[probe] 失敗:', e.message); process.exit(1); });
