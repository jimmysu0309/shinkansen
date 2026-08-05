'use strict';

/**
 * 批次 8 C5(部分)/C8/C10/C11/C12(code review 2026-08-03):content-youtube.js
 * source 鎖定 + C11 半行為驗證。
 *
 * 為什麼走 source 斷言(訊號層界定):
 *   - C8 是 iOS-only timer 時序(_isIOSSafari 在 Chromium 恆 false,自動環境碰不到
 *     setTimeout callback);同型 gate 的行為由既有 youtube-ios-fullscreen-track spec
 *     族群覆蓋 cue 組裝層。
 *   - C10 的 stale-retry 雙鏈需真 bridge 時序,youtube-no-caption-tracks.spec.js 已
 *     驗 queryAndDecide 主流程(修後 20 條全綠);這裡鎖「單鏈 dedupe 結構不被拆」。
 *   - C12 的 onChanged 全量合併行為需 storage event 端到端;結構鎖 + 既有
 *     bilingual toggle spec 覆蓋。
 *   - C11 從 source 抽出 _reEsc 實作 eval 驗真實 regex 行為(半行為測試)。
 *   - C5 的 _hasVisibleTargetCaption 鎖「target-aware 判斷取代 zh 假設」。
 * 斷言全部先剝註解行再匹配。
 *
 * SANITY 紀錄(已驗證,2026-08-05):
 *   C11:把 `_ASR_END_WORDS.map(_reEsc).join` 改回 `_ASR_END_WORDS.join` →
 *     「ppm 不誤命中」case fail → 還原後 pass。
 *   C10:把 handler stale 分支的 `scheduleRetry()` 改回 `setTimeout(queryAndDecide,
 *     BRIDGE_RETRY_MS)` → 「不再有裸 setTimeout 排 retry」case fail → 還原後 pass。
 */

const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/content-youtube.js'),
  'utf-8',
);
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

describe('C5:caption status 的 target-aware 判斷', () => {
  test('_hasVisibleTargetCaption 存在且走 SK.isAlreadyInTarget;舊 zh 假設函式已移除', () => {
    expect(code).toMatch(/function _hasVisibleTargetCaption\(\)/);
    expect(code).toMatch(/SK\.isAlreadyInTarget\(text, target\)/);
    expect(code).not.toMatch(/function _hasVisibleChineseCaption/);
  });

  test('使用者可見 status / toast 字串走 SK.t,不再硬編碼繁中', () => {
    expect(code).toMatch(/showCaptionStatus\(SK\.t\('yt\.status\.translating'\)\)/);
    expect(code).toMatch(/showCaptionStatus\(SK\.t\('yt\.status\.waitingCaption'\)\)/);
    expect(code).toMatch(/SK\.t\('toast\.ytSwitchedNativeTarget'\)/);
    // 硬編碼殘餘檢查(排除 debug 面板 _debugRender 的內部欄位)
    expect(code).not.toMatch(/showCaptionStatus\('[^)]*'\)/);
  });
});

describe('C8:iOS FS refresh timer 的 session 守門', () => {
  test('debounce callback 內有 YT.active gate', () => {
    const fn = code.match(/function _scheduleIosFsTrackRefresh\(\) \{[\s\S]*?\n  \}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/setTimeout\(\(\) => \{[\s\S]*?if \(!SK\.YT\.active\) return;[\s\S]*?_refreshIosFsTrack\(\);/);
  });
});

describe('C10:activation bridge stale-retry 單鏈化', () => {
  test('scheduleRetry dedupe 存在,stale 分支與 safety net 都走它', () => {
    expect(code).toMatch(/let retryScheduled = false;/);
    const dedupe = code.match(/const scheduleRetry = \(\) => \{[\s\S]*?\};/);
    expect(dedupe).not.toBeNull();
    expect(dedupe[0]).toContain('if (retryScheduled) return;');
    // 不再有裸 setTimeout(queryAndDecide) 排 retry(雙鏈來源)
    expect(code).not.toMatch(/setTimeout\(queryAndDecide, BRIDGE_RETRY_MS\)[\s\S]{0,40}return;\s*\}\s*\n[\s\S]{0,400}setTimeout\(queryAndDecide, BRIDGE_RETRY_MS\)/);
    const bareRetries = (code.match(/setTimeout\(queryAndDecide, BRIDGE_RETRY_MS\)/g) || []).length;
    expect(bareRetries).toBe(1); // 只剩 scheduleRetry 內那一處
  });
});

describe('C11:_ASR_END_WORDS regex escape(半行為)', () => {
  test('endRe / startRe 走 _reEsc;p.m 不再誤命中 ppm / pam', () => {
    expect(code).toMatch(/_ASR_END_WORDS\.map\(_reEsc\)\.join/);
    expect(code).toMatch(/_ASR_START_WORDS\.map\(_reEsc\)\.join/);
    // 從 source 抽 _reEsc 實作 eval,用真實 word list 驗 regex 行為
    const m = src.match(/const _reEsc = (\(w\) => w\.replace\(.*\));/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    const reEsc = eval(m[1]);
    const words = ['p.m', 'a.m', 'gpt'];
    const endRe = new RegExp(`\\b(${words.map(reEsc).join('|')})\\s*$`, 'i');
    expect(endRe.test('the level is 300 ppm')).toBe(false);
    expect(endRe.test('her name is pam')).toBe(false);
    expect(endRe.test('see you at 3 p.m')).toBe(true);
    expect(endRe.test('powered by gpt')).toBe(true);
  });
});

describe('C12:getYtConfig 快取與 onChanged 全量同步', () => {
  test('onChanged handler 全量合併 config(與 getYtConfig 同構造式)', () => {
    expect(code).toMatch(/if \(SK\.YT\.config\) SK\.YT\.config = \{ \.\.\.DEFAULT_YT_CONFIG, \.\.\.newVal \};/);
    // 舊的單欄位回寫已移除
    expect(code).not.toMatch(/SK\.YT\.config\.bilingualMode = newBilingual/);
  });
});
