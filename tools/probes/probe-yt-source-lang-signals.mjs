// probe-yt-source-lang-signals.mjs — 一次 dump 多支 YouTube 影片「原始語言」相關的所有訊號,
// 用來設計 / 驗證 chooser 的源語推導(字幕軌 kind、音軌原音標記、標題語言等)。
// 不載 extension、不需 API key。
//
// 用法: VIDEO_IDS=id1,id2,... node tools/probes/probe-yt-source-lang-signals.mjs

import { chromium } from 'playwright';

const IDS = (process.env.VIDEO_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (IDS.length === 0) { console.error('請給 VIDEO_IDS'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', `--lang=${process.env.PROBE_LOCALE || 'zh-TW'}`],
  });
  const ctx = await browser.newContext({ locale: process.env.PROBE_LOCALE || 'zh-TW', viewport: { width: 1280, height: 800 } });
  for (const id of IDS) {
    const page = await ctx.newPage();
    try {
      await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(5000);
      const data = await page.evaluate(() => {
        const player = document.querySelector('#movie_player');
        let resp = null;
        try { if (player?.getPlayerResponse) resp = player.getPlayerResponse(); } catch (_) {}
        if (!resp) resp = window.ytInitialPlayerResponse;
        const r = resp?.captions?.playerCaptionsTracklistRenderer;
        let at = null;
        try { at = player?.getOption?.('captions', 'track') || null; } catch (_) {}
        const fmts = (resp?.streamingData?.adaptiveFormats || []).filter((f) => f.audioTrack);
        const uniq = [...new Map(fmts.map((f) => [f.audioTrack.id, {
          id: f.audioTrack.id, displayName: f.audioTrack.displayName,
          audioIsDefault: f.audioTrack.audioIsDefault, isAutoDubbed: f.audioTrack.isAutoDubbed,
          xtags: f.xtags, xtagsDecoded: (() => { try { return atob((f.xtags || '').replace(/-/g, '+').replace(/_/g, '/')).replace(/[^\x20-\x7e]+/g, '|'); } catch (_) { return null; } })(),
        }])).values()];
        return {
          title: resp?.videoDetails?.title,
          tracks: (r?.captionTracks || []).map((t) => `${t.languageCode}${t.kind ? ':' + t.kind : ''}`),
          audioTracks: (r?.audioTracks || []).map((a) => ({ id: a.audioTrackId, defCap: a.defaultCaptionTrackIndex, vis: a.visibility, hasDef: a.hasDefaultTrack })),
          defaultAudioTrackIndex: r?.defaultAudioTrackIndex,
          active: at && `${at.languageCode}${at.kind ? ':' + at.kind : ''}${at.translationLanguage ? '→' + at.translationLanguage.languageCode : ''}`,
          adaptiveAudio: uniq,
          microDefaultAudioLanguage: resp?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage ?? null,
        };
      });
      console.log(`\n=== ${id} ===\n` + JSON.stringify(data, null, 1));
    } catch (e) {
      console.log(`\n=== ${id} === 失敗: ${e.message}`);
    }
    await page.close();
  }
  await browser.close();
}

main().catch((e) => { console.error('[probe] 失敗:', e.message); process.exit(1); });
