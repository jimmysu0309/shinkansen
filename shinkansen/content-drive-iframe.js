// content-drive-iframe.js — Shinkansen Drive ASR 字幕 URL 偵測(youtube.googleapis.com/embed iframe)
// commit 1 — 路徑 B
//
// 執行環境:isolated world,run_at: document_start,僅 https://youtube.googleapis.com/embed/* + all_frames: true
// 職責:用 PerformanceObserver 監聽 iframe 內發出的 fetch resource entries,
//      抓到 drive.google.com timedtext ASR URL 後 sendMessage 給 background。
//
// 為什麼:Drive 影片用 youtube.googleapis.com/embed 當 player,字幕從 iframe
//        cross-origin fetch 到 drive.google.com/u/0/timedtext。authpayload 自含
//        auth(已驗 credentials:'omit' 也 200),background 拿到 URL 直接 refetch 即可。
//
// 為什麼不裝 webRequest 權限:加 webRequest 會觸發 Chrome 對 CWS 既有使用者強制
//        re-enable 提示(sensitive permission),UX 干擾遠大於 PerformanceObserver
//        多一層轉送的成本。

(function () {
  // 只在「Drive 嵌入 player」場景啟動。Drive 的 embed iframe URL 帶 post_message_origin
  // / origin = drive.google.com;單獨開 youtube.googleapis.com/embed/ 不會有這條,避免誤觸。
  let isDriveEmbed = false;
  try {
    const params = new URL(location.href).searchParams;
    const origin = params.get('post_message_origin') || params.get('origin') || '';
    isDriveEmbed = origin.includes('drive.google.com');
  } catch (_) {}
  if (!isDriveEmbed) return;

  // 用 kind=asr(track 請求)而非 caps=asr——後者連 type=list 也會 match,但 list
  // response 不是 JSON,background handler res.json() 會 throw。kind=asr 只在 track 請求出現。
  const TIMEDTEXT_RE = /^https:\/\/drive\.google\.com\/u\/\d+\/timedtext.*[?&]kind=asr/;
  const reportedUrls = new Set();

  // v1.8.19: 此檔在 youtube.googleapis.com/* 獨立注入, 不載入 SK 命名空間,
  // 必須自己處理 context invalidated。同步 try/catch 接 sync throw, runtime.id
  // guard 接 fast path, .catch 接 async reject。
  function reportTimedtextUrl(url) {
    if (!url || reportedUrls.has(url)) return;
    if (!TIMEDTEXT_RE.test(url)) return;
    reportedUrls.add(url);
    if (!chrome?.runtime?.id) return;
    try {
      chrome.runtime.sendMessage({ type: 'DRIVE_TIMEDTEXT_URL', payload: { url } })?.catch?.(() => {});
    } catch (_) {}
  }

  // 既有 entries(observer 註冊前已載入)
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      reportTimedtextUrl(entry.name);
    }
  } catch (_) {}

  // 後續 entries
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        reportTimedtextUrl(entry.name);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (_) {}
})();
