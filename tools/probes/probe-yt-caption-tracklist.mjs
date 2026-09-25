// probe-yt-caption-tracklist.mjs — dump 一支 YouTube 影片的字幕軌 / 音軌結構
// (playerCaptionsTracklistRenderer 的 captionTracks + audioTracks + defaultAudioTrackIndex),
// 用來查「chooser 抓錯 ASR 軌」類 bug(例:英文口說影片被選成日文自動字幕)。
// 不載 extension、不需 API key,純看 YouTube 給的 metadata。
//
// 用法: VIDEO_ID=<id> node tools/probes/probe-yt-caption-tracklist.mjs
//       (或 TARGET_URL=<完整網址>)

import { chromium } from 'playwright';

const VIDEO_ID = process.env.VIDEO_ID || '';
const TARGET_URL = process.env.TARGET_URL || `https://www.youtube.com/watch?v=${VIDEO_ID}`;
if (!VIDEO_ID && !process.env.TARGET_URL) {
  console.error('請給 VIDEO_ID 或 TARGET_URL');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--lang=zh-TW'],
  });
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  console.log('[probe] TARGET_URL:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 同意頁(EU cookie consent)偶發:嘗試點掉
  try {
    const btn = page.locator('button:has-text("Accept all"), button:has-text("全部接受"), button:has-text("接受全部")').first();
    if (await btn.isVisible({ timeout: 2000 })) await btn.click();
  } catch (_) {}
  await sleep(4000);

  const data = await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    let resp = null;
    try { if (player?.getPlayerResponse) resp = player.getPlayerResponse(); } catch (_) {}
    if (!resp) resp = window.ytInitialPlayerResponse;
    const r = resp?.captions?.playerCaptionsTracklistRenderer;
    let activeTrack = null;
    try { activeTrack = player?.getOption?.('captions', 'track') || null; } catch (_) {}
    let audioTrackApi = null;
    try {
      audioTrackApi = {
        current: player?.getAudioTrack?.() || null,
        available: player?.getAvailableAudioTracks?.() || null,
      };
    } catch (_) {}
    return {
      videoId: resp?.videoDetails?.videoId || null,
      title: resp?.videoDetails?.title || null,
      defaultAudioLanguage: resp?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage || null,
      captionTracks: (r?.captionTracks || []).map((t, i) => ({
        i,
        languageCode: t.languageCode,
        kind: t.kind || '',
        vssId: t.vssId,
        name: t.name?.simpleText || t.name?.runs?.[0]?.text || null,
        isTranslatable: !!t.isTranslatable,
        trackName: t.trackName ?? undefined,
      })),
      audioTracks: (r?.audioTracks || []).map((a, i) => ({
        i,
        audioTrackId: a.audioTrackId,
        captionTrackIndices: a.captionTrackIndices,
        defaultCaptionTrackIndex: a.defaultCaptionTrackIndex,
        visibility: a.visibility,
        hasDefaultTrack: a.hasDefaultTrack,
        captionsInitialState: a.captionsInitialState,
      })),
      defaultAudioTrackIndex: r?.defaultAudioTrackIndex,
      translationLanguagesCount: (r?.translationLanguages || []).length,
      activeTrack: activeTrack && {
        languageCode: activeTrack.languageCode, kind: activeTrack.kind, vssId: activeTrack.vssId,
        translationLanguage: activeTrack.translationLanguage?.languageCode || null,
      },
      audioTrackApi,
      adaptiveAudioTracks: [...new Map((resp?.streamingData?.adaptiveFormats || [])
        .filter((f) => f.audioTrack)
        .map((f) => [f.audioTrack.id, { id: f.audioTrack.id, displayName: f.audioTrack.displayName, audioIsDefault: f.audioTrack.audioIsDefault }])).values()],
    };
  });
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
}

main().catch((e) => { console.error('[probe] 失敗:', e.message); process.exit(1); });
