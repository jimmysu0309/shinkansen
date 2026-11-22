// platform.js — runtime 平台偵測(iOS build 跑在 macOS 的辨別)。
//
// 為什麼需要:iOS build(safari-build-ios.sh,IS_IOS_BUILD=true)可透過 Apple
// Silicon Mac 的「iPhone 與 iPad App 在 Mac 上執行」直接裝進 macOS。這時
// IS_IOS_BUILD 仍是 true,但執行環境是 macOS Safari ——必須尊重 macOS 特性
// (popup 用桌面 popover 尺寸不放大、快速鍵提示用鍵盤而非四指 tap)。
//
// 「build 屬性」vs「平台屬性」分離(見 lib/distribution.js):
//   - 文件翻譯頁的手機版面(直向「請轉成橫向」提示、編輯頁整頁捲動)→ 平台屬性,
//     translate-doc/index.js 依 isPhoneDevice() 加 body.runtime-phone
//   - popup 放大 / 四指 tap 提示是 **平台屬性** → 只在真觸控裝置套用,Mac 上不套,
//     用 body.runtime-ios-touch(IS_IOS_BUILD && isTouchScreenDevice() 才加)
//
// 偵測訊號:Mac 沒有觸控螢幕 → navigator.maxTouchPoints === 0;真 iPhone / iPad
// 一律 ≥ 1。iPad 桌面模式雖把 navigator.platform 偽裝成 'MacIntel',maxTouchPoints
// 仍 = 5,所以不能用 platform 判,要用 maxTouchPoints(與 content-youtube.js 判
// 「iPad 偽裝 Mac」同一套訊號)。且為 **同步** 呼叫:popup zoom 必須在繪製前決定,
// 不能用 async 的 browser.runtime.getPlatformInfo()。
//
// 註:content-touch.js 的四指 tap 不需另外 gate —— Mac 無觸控硬體,根本不會派發
// TouchEvent,handler 在 Mac 上本就是 no-op(維持 IS_IOS_BUILD gate 即可)。

// 是否為真實觸控裝置(iPhone / iPad)。false = 桌面(含 iOS build 跑在 Mac)。
export function isTouchScreenDevice() {
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) >= 1;
}

// 是否為手機尺寸裝置(iPhone)。文件翻譯頁是大版面工作頁(雙欄預覽、譯文編輯),
// 手機只能橫向使用 → translate-doc 在手機上套專用版面(見 translate-doc/index.css 手機段)。
// 兩個訊號擇一成立即判手機:
//   1. UA 含 iPhone / iPod(iPhone Safari 的擴充功能頁不套「要求桌面版網站」,UA 誠實)
//   2. 觸控裝置且螢幕短邊 < 600pt(UA 被改時的保底;iPhone 短邊 ≤ 440、iPad mini 744)
// iPad 桌面模式 UA 偽裝成 Macintosh 但短邊 ≥ 744 → 兩條都不成立,正確判為非手機。
export function isPhoneDevice() {
  if (typeof navigator === 'undefined') return false;
  if (/\b(iPhone|iPod)\b/.test(navigator.userAgent || '')) return true;
  if (!isTouchScreenDevice() || typeof screen === 'undefined') return false;
  const shortSide = Math.min(screen.width || 0, screen.height || 0);
  return shortSide > 0 && shortSide < 600;
}
