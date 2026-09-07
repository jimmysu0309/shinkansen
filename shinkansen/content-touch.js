// content-touch.js — 四指手勢觸發翻譯（iOS / iPadOS Safari 專用）
//
// 設計（SPEC-PRIVATE §26.1）：
// - 四指「快點」= Alt+S 完整 toggle（主要預設 slot 2）：未翻譯 → 翻譯；翻譯中或
//   已翻譯 → 中止並還原原文。送 FOUR_FINGER_TAP 給 background → TRANSLATE_PRESET
//   slot 2（跟 commands onCommand 的 Alt+S 完全同一條路徑，含 all_frames broadcast）
// - 四指「長按」= 次要預設 slot 1（預設 Flash，即 Alt+A 那組）：四指同時壓住、不移動且持續
//   達 LONGPRESS_MS → 送 FOUR_FINGER_LONGPRESS → background → TRANSLATE_PRESET slot 1。
//   長按在門檻當下即由計時器觸發（不等抬起），翻譯進度 toast 即視覺回饋；不依賴
//   navigator.vibrate（iOS Safari 不支援震動 API）
// - 快點 / 長按以「壓住時長」單一門檻區分：抬起時計時器尚未觸發 = 快點（slot 2）；
//   壓住達門檻計時器先觸發 = 長按（slot 1）。主要動作（快點）在抬起當下即觸發、零
//   延遲——這正是選「長按」而非「雙擊」做次要預設的原因（雙擊會逼快點等消歧窗）
// - 任一指移動 < MOVE_TOLERANCE_PX 才算合格；四指 swipe / pinch（iPadOS 系統多工
//   手勢）移動量超過容差被取消，第五指落下（五指 pinch）也取消，皆不誤觸發
// - 本檔列在 manifest 全平台載入（維持 manifest 單一來源 + Playwright 可測），
//   但 handler 開頭以 IS_IOS_BUILD gate 早退：桌面 build（Chrome / Firefox /
//   macOS Safari）為 no-op，只有 safari-build-ios.sh override 的 iOS build 啟用。
//   桌面觸控螢幕（Windows touch laptop 等）不啟用——四指手勢在各桌面 OS 另有
//   系統手勢語意，誤觸發風險高
// - Options 提供「四指觸控翻譯」開關（storage.sync.fourFingerGesture），預設開啟——
//   觸控裝置開箱即有手勢入口；易誤觸發的使用者可在 Options 關閉
(function (SK) {
  'use strict';
  if (!SK) return;

  const LONGPRESS_MS = 600;      // 四指壓住達此毫秒數 = 長按 → slot 1；之前抬起 = 快點 → slot 2
  const MOVE_TOLERANCE_PX = 30;  // 任一指移動超過此距離視為 swipe / pinch，取消

  // 進行中的四指手勢：{ t0, pts: Map<identifier,{x,y}>, timer, longPressFired }
  // null = 無候選手勢
  let gesture = null;

  function clearGestureTimer() {
    if (gesture && gesture.timer) { clearTimeout(gesture.timer); gesture.timer = null; }
  }

  // 使用者可在 Options 關閉四指手勢（storage.sync.fourFingerGesture，預設開——觸控裝置
  // 開箱即有手勢入口，易誤觸發者可關閉）。不在載入期以 IS_IOS_BUILD gate 訂閱——
  // isEnabled() 才 gate IS_IOS_BUILD，讓 regression spec 可 runtime 翻 IS_IOS_BUILD 後仍
  // 吃得到這個旗標（且訂閱成本極小）。
  // 初始值必須與 lib/storage.js DEFAULT_SETTINGS.fourFingerGesture 同值（此處直接讀
  // storage.sync，沒 key 時不會經過 DEFAULT_SETTINGS merge）。
  let fourFingerEnabled = true;
  browser.storage.sync.get(['fourFingerGesture']).then((s) => {
    if (typeof s.fourFingerGesture === 'boolean') fourFingerEnabled = s.fourFingerGesture;
  }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.fourFingerGesture) {
      // key 被移除(newValue undefined)= 回預設開;只有明確 boolean 才尊重使用者值
      const nv = changes.fourFingerGesture.newValue;
      fourFingerEnabled = (typeof nv === 'boolean') ? nv : true;
    }
  });
  SK.getFourFingerEnabled = () => fourFingerEnabled;   // regression spec 讀取用

  function isEnabled() {
    // IS_IOS_BUILD 由 lib/distribution-cs.js 寫入（iOS build override 為 true）。
    // 動態讀（不在載入期快照）讓 regression spec 可在 runtime 翻 flag 測手勢邏輯。
    // 再 gate fourFingerEnabled：使用者在 Options 關掉四指手勢時整段早退。
    return SK.IS_IOS_BUILD === true && fourFingerEnabled;
  }

  window.addEventListener('touchstart', (e) => {
    if (!isEnabled()) return;
    if (e.touches.length === 4) {
      const pts = new Map();
      for (const t of e.touches) pts.set(t.identifier, { x: t.clientX, y: t.clientY });
      clearGestureTimer();
      gesture = { t0: Date.now(), pts, timer: null, longPressFired: false };
      // 四指壓住達門檻仍未抬起 / 未超移動容差 → 長按 → slot 1。touchmove / 第五指 /
      // 任一指抬起都會清掉此計時器，所以計時器觸發時必然四指仍合格壓著。
      gesture.timer = setTimeout(() => {
        if (!gesture || gesture.longPressFired) return;
        gesture.longPressFired = true;
        gesture.timer = null;
        SK.sendLog('info', 'system', 'four-finger long-press detected', { ms: LONGPRESS_MS });
        SK.safeSendMessage({ type: 'FOUR_FINGER_LONGPRESS' }).catch(() => {});
      }, LONGPRESS_MS);
    } else if (e.touches.length > 4) {
      // 第五指落下 → 不是四指手勢（iPadOS 五指 pinch 等系統手勢）
      clearGestureTimer();
      gesture = null;
    }
  }, { passive: true, capture: true });

  window.addEventListener('touchmove', (e) => {
    if (!gesture) return;
    for (const t of e.touches) {
      const start = gesture.pts.get(t.identifier);
      if (!start) continue;
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_TOLERANCE_PX) {
        clearGestureTimer();
        gesture = null; // swipe / pinch，取消候選
        return;
      }
    }
  }, { passive: true, capture: true });

  window.addEventListener('touchend', (e) => {
    if (!gesture) return;
    if (e.touches.length > 0) {
      // 部分手指抬起:長按語意 = 四指「全程」壓住,任一指抬起即取消長按候選
      // (只清計時器,保留 gesture 讓 tap 路徑在全抬起時照常判定)。touchend 的
      // e.touches 已不含剛抬起的指頭,四指手勢任一 touchend 必然 < 4 → 第一根
      // 抬起即取消。先前這裡直接 return 不清 timer:抬三指剩一指壓超過 600ms,
      // 計時器照樣觸發 FOUR_FINGER_LONGPRESS 誤發 slot 1(2026-08-03 review D2)
      if (e.touches.length < 4) clearGestureTimer();
      return; // 還有指頭沒抬起，等下一個 touchend
    }
    clearGestureTimer();
    const fired = gesture.longPressFired;
    const elapsed = Date.now() - gesture.t0;
    gesture = null;
    if (fired) return;                    // 長按已由計時器送出 slot 1，抬起不再送 slot 2
    if (elapsed >= LONGPRESS_MS) return;  // 理論上計時器已先觸發；防禦性早退
    SK.sendLog('info', 'system', 'four-finger tap detected', { elapsedMs: elapsed });
    SK.safeSendMessage({ type: 'FOUR_FINGER_TAP' }).catch(() => {});
  }, { passive: true, capture: true });

  window.addEventListener('touchcancel', () => {
    clearGestureTimer();
    gesture = null;
  }, { passive: true, capture: true });

  // ── iOS background keep-alive（SPEC-PRIVATE §26.14）─────────────────────
  // iOS Safari 的擴充功能 background（即使宣告成 event page）閒置一段時間後會被
  // 系統「永久回收」且叫不醒：sendMessage 叫不醒、開關 Safari 也沒用，只有強制
  // 關閉 Safari 才復活（Apple Developer Forums thread 758346，iOS 17.4 起、迄今
  // 未修；只發生在真機，模擬器 / macOS 不會）。表現為「用一陣子後四指 / popup 按
  // 翻譯失效」——因為四指與 popup 翻譯最後都要送請求給 background 做 API 呼叫。
  //
  // 死後救不回，所以修法不是「死了再救」而是「不讓它睡到被回收」：開一條長連線
  // port + 每 20s ping，讓 background 一直保持非閒置（收訊息會重置系統的閒置計時）。
  // 只在「分頁可見」時 ping（切到背景就斷，省電）；只在 iOS build + top frame 啟用
  // （每個分頁一條 port 就夠，iframe 不重複開）。桌面 build 不啟用——桌面的 SW
  // 生命週期正常，不需要這個 workaround。
  const KEEPALIVE_PORT_NAME = 'shinkansen-keepalive';
  const KEEPALIVE_PING_MS = 20000; // < iOS ~30s 回收窗，留餘裕
  let kaPort = null;
  let kaTimer = null;

  function stopKeepAlive() {
    if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
    if (kaPort) { try { kaPort.disconnect(); } catch (_) {} kaPort = null; }
  }

  function startKeepAlive() {
    if (kaPort || document.hidden) return;        // 已連線 / 分頁不可見 → 不開
    if (!browser.runtime?.id) return;             // context 失效（extension reload 中）
    try {
      kaPort = browser.runtime.connect({ name: KEEPALIVE_PORT_NAME });
    } catch (_) { kaPort = null; return; }
    // background 回 pong → 記錄「背景還活著」（spec 驗 port round-trip；production
    // 不依賴此值，純粹讓自動化測得到真實 content↔background 連線）
    kaPort.onMessage.addListener(() => { SK._keepAliveAlive = true; });
    // 背景被回收 / 重啟 → port 斷。仍可見就重連（context 失效時 startKeepAlive 自會早退，
    // 1s 延遲避免 reload 期間緊迴圈）
    kaPort.onDisconnect.addListener(() => {
      kaPort = null;
      if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
      if (!document.hidden) setTimeout(startKeepAlive, 1000);
    });
    const ping = () => {
      if (!kaPort) return;
      try { kaPort.postMessage({ t: Date.now() }); }
      catch (_) { stopKeepAlive(); if (!document.hidden) setTimeout(startKeepAlive, 1000); }
    };
    ping();                                       // 連線即送首 ping，不等 20s 第一輪
    kaTimer = setInterval(ping, KEEPALIVE_PING_MS);
  }

  // iOS build + top frame 才啟用。動態讀 SK.IS_IOS_BUILD（不在載入期快照），讓
  // regression spec 可 runtime 翻 flag 後手動觸發。
  function maybeStartKeepAlive() {
    if (SK.IS_IOS_BUILD !== true || window !== window.top) return;
    startKeepAlive();
  }
  SK.maybeStartKeepAlive = maybeStartKeepAlive;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopKeepAlive();
    else maybeStartKeepAlive();
  });
  maybeStartKeepAlive();

  // Phase 2（SPEC-PRIVATE §26.12）：頁面載入時請 background 拉一次 host app 設定。
  // host app onboarding / 設定畫面剛存的 API Key + 預設模型寫在 App Group，background
  // 經 native messaging 拉走套用。在「四指 tap 翻譯」之前（頁面載入 → 使用者點，有人為
  // 延遲）就完成套用，避免第一次 tap 還用到舊設定。iOS only（桌面 background 也有
  // IS_IOS_BUILD gate，這裡再 gate 一層省掉桌面的無謂訊息）。distribution-cs.js 在本檔
  // 之前載入，IS_IOS_BUILD 此時已就緒。
  if (SK.IS_IOS_BUILD === true) {
    // 批次 8 D8:補 .catch 與同檔其他 safeSendMessage 呼叫點對齊(orphan context 靜默)
    SK.safeSendMessage({ type: 'PULL_HOST_SETTINGS' }).catch(() => {});
  }
})(window.__SK);
