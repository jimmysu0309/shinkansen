// content-youtube-main.js — Shinkansen YouTube XHR 字幕攔截（MAIN world）
// v1.3.12（從 v1.3.8 恢復）
//
// 執行環境：MAIN world，run_at: document_start（manifest 獨立宣告）
// 職責：monkey-patch XMLHttpRequest 與 fetch，攔截 YouTube 播放器
//       自己發出的 /api/timedtext 請求，把字幕原文透過 CustomEvent
//       傳給 isolated world（content-youtube.js）。
//
// 為什麼這樣做：YouTube 的 /api/timedtext 對所有主動的 fetch() 呼叫
// 一律回傳空 body（包含 main world / isolated world / service worker），
// 即使是 same-origin 的請求也一樣（只要 URL 含 exp=xpv/xpe 就需要 POT）。
// 唯一能拿到資料的方式，是等 YouTube 播放器自己發出請求，再擷取 response。

(function () {
  const TIMEDTEXT_RE = /\/api\/timedtext/;
  const CAPTION_EVENT = 'shinkansen-yt-captions';

  // ─── bridge detail 雙格式相容讀 ───────────────────────────
  // Firefox：isolated world dispatch 的 object detail 在 main world 讀屬性會
  // throw Permission denied（Xray 安全模型）→ isolated 端（content-youtube.js
  // bridgeRequest）一律送 JSON 字串（primitive 跨 compartment 可讀）。
  // 這裡字串就 parse、物件直收 —— Chrome 新舊協定皆通，不需兩側同步升級。
  function parseBridgeDetail(e) {
    const d = e?.detail;
    if (typeof d === 'string') {
      try { return JSON.parse(d); } catch (_) { return null; }
    }
    return d || null;
  }

  // ─── XMLHttpRequest monkey-patch ──────────────────────────
  // YouTube 播放器用 XHR 抓字幕，攔截 open() 記錄 URL，
  // 在 readystatechange 等到完成時把 responseText 丟出去。

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    this.__shinkansenUrl =
      typeof args[1] === 'string' ? args[1] : (args[1]?.href || '');
    return _open.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__shinkansenUrl || '';
    if (TIMEDTEXT_RE.test(url)) {
      this.addEventListener('readystatechange', function () {
        // 批次 8 C7:整段包 try/catch + responseType 檢查。若 YouTube 對 timedtext
        // 改用 responseType='json'/'arraybuffer',讀 responseText 會 throw
        // InvalidStateError——monkey-patch 對宿主頁的防禦原則是「絕不往頁面丟例外」,
        // 攔截失效要靜默(字幕功能退化),不能讓頁面收到 unhandled error。
        try {
          if (this.responseType && this.responseType !== 'text') return;
          if (this.readyState === 4 && this.status === 200 && this.responseText) {
            window.dispatchEvent(new CustomEvent(CAPTION_EVENT, {
              detail: { url, responseText: this.responseText },
            }));
          }
        } catch (_) { /* 靜默:攔截為 best-effort,不干擾宿主頁 */ }
      });
    }
    return _send.apply(this, args);
  };

  // ─── fetch monkey-patch ───────────────────────────────────
  // 部分情境 YouTube 可能改用 fetch；攔截並克隆 response 讀取內容。

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string'
      ? args[0]
      : (args[0]?.url || args[0]?.href || '');
    const response = await _fetch.apply(this, args);
    if (TIMEDTEXT_RE.test(url)) {
      try {
        response.clone().text().then(text => {
          if (text) {
            window.dispatchEvent(new CustomEvent(CAPTION_EVENT, {
              detail: { url, responseText: text },
            }));
          }
        }).catch(() => {});
      } catch (_) {}
    }
    return response;
  };

  // ─── player response bridge(v1.9.9)───────────────
  // isolated world(content-youtube.js)5s「沒字幕」啟發式之前先 query 本 bridge,
  // 拿 captionTracks 權威訊號決定是否真的沒字幕(不靠 timeout 猜)。
  // 只回傳 captionTracks 子集合避免 serialize 整個 playerResponse;additionally
  // 多回 activeTrack（從 #movie_player.getOption 抓），給 caption track 自動選擇邏輯
  // 判斷當前是不是 YT 自翻譯軌（activeTrack.translationLanguage 有值）。
  //
  // 資料源:優先 `#movie_player.getPlayerResponse()`(反映「當前正在播」的影片),
  // 拿不到才 fallback 回 `window.ytInitialPlayerResponse`。
  // Why:`ytInitialPlayerResponse` 只是「整頁初次載入那支影片」的快照,SPA 站內切片後
  //     不更新 → videoId 一直 stale → isolated 端 videoId 比對失敗 → chooser noop 放棄切軌
  //     → YT 黏性自翻譯沒被關掉 → 偶發「日→英→中」二手翻譯(實測 mSUxnf6rmUE:URL 跟
  //     getPlayerResponse 都是 mSUxnf6rmUE,但 ytInitialPlayerResponse 停在前一支 SGt2lYaPP00)。

  window.addEventListener('shinkansen-yt-query-player-response', () => {
    let captionTracks = null;
    let playerResponseAvailable = false;
    let videoId = null;
    let activeTrack = null;
    const player = document.querySelector('#movie_player');
    try {
      let resp = null;
      try {
        // fresh:當前播放中的影片(SPA 切片後也正確)
        if (player?.getPlayerResponse) resp = player.getPlayerResponse();
      } catch (_) {}
      // fallback:player 還沒準備好(document_start ~ player 初始化之間)→ 用初次載入快照
      if (!resp) resp = window.ytInitialPlayerResponse;
      playerResponseAvailable = !!resp;
      videoId = resp?.videoDetails?.videoId || null;
      const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks)) {
        captionTracks = tracks.map((t) => ({
          languageCode:   t?.languageCode || null,
          kind:           t?.kind || '',
          isTranslatable: !!t?.isTranslatable,
          vssId:          t?.vssId || null,
          name:           t?.name?.simpleText || t?.name?.runs?.[0]?.text || null,
        }));
      }
      // videoId 給 isolated world 跟 URL videoId 比對:走 fallback 快照時仍可能 stale,
      // videoId 對不上 = stale,isolated 端會 retry。
    } catch (_) {
      captionTracks = null;
    }
    try {
      if (player?.getOption) {
        const at = player.getOption('captions', 'track');
        if (at && typeof at === 'object') {
          activeTrack = {
            languageCode:            at.languageCode || null,
            kind:                    at.kind || '',
            translationLanguageCode: at.translationLanguage?.languageCode || null,
          };
        }
      }
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('shinkansen-yt-player-response', {
      detail: { captionTracks, playerResponseAvailable, videoId, activeTrack },
    }));
  });

  // ─── CC control bridge(mweb 用)──────────────────────────
  // m.youtube.com 沒有 .ytp-subtitles-button,isolated world 的 forceSubtitleReload
  // 無按鈕可點。改用 #movie_player 的 captions module API 控制 CC:
  //   op: 'status' → 回報 CC 是否開啟(getOption('captions','track') 有 languageCode = 開)
  //   op: 'enable' → loadModule('captions') + setOption 切到第一個可用軌
  //                  (probe 實證:mweb 只 loadModule 不會發 timedtext XHR,必須 setOption
  //                  指定軌才觸發;軌的最終選擇仍由 isolated 端 track chooser 透過
  //                  shinkansen-yt-set-caption-track 修正,這裡只求「讓播放器發出 XHR」)
  //   op: 'reload' → unloadModule + loadModule + setOption 回原軌,強迫重發 XHR
  //                  (等同桌面「CC 關掉再開」)
  // 結果以 shinkansen-yt-cc-control-result 回送 { op, ok, ccOn, error }。

  window.addEventListener('shinkansen-yt-cc-control', (e) => {
    const op = parseBridgeDetail(e)?.op || 'status';
    let ok = false;
    let ccOn = false;
    let error = null;
    try {
      const player = document.querySelector('#movie_player');
      if (!player) throw new Error('no-movie-player');

      const currentTrack = (() => {
        try {
          const t = player.getOption?.('captions', 'track');
          return (t && typeof t === 'object' && t.languageCode) ? t : null;
        } catch (_) { return null; }
      })();
      ccOn = !!currentTrack;

      if (op === 'status') {
        ok = true;
      } else if (op === 'enable') {
        player.loadModule?.('captions');
        // 軌來源:tracklist(loadModule 後可能仍空)→ playerResponse captionTracks fallback
        let track = null;
        try {
          const list = player.getOption?.('captions', 'tracklist');
          if (Array.isArray(list) && list.length) track = list[0];
        } catch (_) {}
        if (!track) {
          let resp = null;
          try { if (player.getPlayerResponse) resp = player.getPlayerResponse(); } catch (_) {}
          if (!resp) resp = window.ytInitialPlayerResponse;
          // videoId guard:廣告播放中 / SPA 切片後 getPlayerResponse 可能回廣告或
          // 前一支影片的 stale response,此時 setOption 會作用在錯的對象。對 URL ?v=
          // 比對,不符就回錯誤讓 isolated 端稍後重試(同 query-player-response 的
          // stale 防護思路)。
          // /live/<id> 直播連結 videoId 在 path(v2.0.87)。與 content-youtube.js
          // getVideoIdFromUrl 是同一份事實的雙實作(MAIN world 隔離),改這裡必同步那邊
          const _liveM = location.pathname.match(/^\/live\/([A-Za-z0-9_-]{6,})/);
          const urlVid = new URL(location.href).searchParams.get('v') || (_liveM ? _liveM[1] : null);
          const respVid = resp?.videoDetails?.videoId || null;
          if (urlVid && respVid && urlVid !== respVid) throw new Error('stale-player-response');
          const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(tracks) && tracks.length) track = tracks[0];
        }
        if (!track?.languageCode) throw new Error('no-caption-track');
        player.setOption('captions', 'track', {
          languageCode: track.languageCode,
          kind: track.kind || '',
        });
        ccOn = true;
        ok = true;
      } else if (op === 'reload') {
        if (!currentTrack) throw new Error('cc-not-on');
        player.unloadModule?.('captions');
        // unload → load 需隔一個 tick 讓播放器清掉字幕狀態,再切回原軌觸發新 XHR
        setTimeout(() => {
          try {
            player.loadModule?.('captions');
            player.setOption('captions', 'track', {
              languageCode: currentTrack.languageCode,
              kind: currentTrack.kind || '',
            });
          } catch (_) {}
        }, 200);
        ok = true;
      } else {
        throw new Error('unknown-op');
      }
    } catch (err) {
      error = err?.message || String(err);
    }
    window.dispatchEvent(new CustomEvent('shinkansen-yt-cc-control-result', {
      detail: { op, ok, ccOn, error },
    }));
  });

  // ─── caption track switch bridge ─────────────────────────
  // isolated world 跑完 track chooser 後，若決定 'switch' 就丟此事件來
  // 呼叫 #movie_player.setOption('captions', 'track', {languageCode, kind})，
  // 切換掉 YT 自翻譯軌 / 切到指定 manual or ASR 軌。
  // 結果以 shinkansen-yt-set-caption-track-result 回送（ok / error）。

  window.addEventListener('shinkansen-yt-set-caption-track', (e) => {
    const { languageCode, kind } = parseBridgeDetail(e) || {};
    let ok = false;
    let error = null;
    try {
      const player = document.querySelector('#movie_player');
      if (player?.setOption && languageCode) {
        player.setOption('captions', 'track', {
          languageCode,
          kind: kind || '',
        });
        ok = true;
      } else {
        error = 'no-player-or-langcode';
      }
    } catch (err) {
      error = err?.message || String(err);
    }
    window.dispatchEvent(new CustomEvent('shinkansen-yt-set-caption-track-result', {
      detail: { ok, error },
    }));
  });

})();
