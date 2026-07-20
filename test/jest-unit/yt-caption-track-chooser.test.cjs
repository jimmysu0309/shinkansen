'use strict';

/**
 * YouTube caption track 自動選擇邏輯 unit test。
 *
 * 對象：`SK._chooseBestCaptionTrack(tracks, activeTrack, targetLanguage)` —
 *       pure function，定義在 shinkansen/content-youtube.js,IIFE 載入後 attach 到 __SK。
 *
 * 三優先序（見 content-youtube.js 函式上方註解）:
 *   P1) target lang 原生 track（任 kind):
 *       - activeTrack 已是該 native(同 kind 無 translation)→ action='skip'
 *       - 否則 → action='switch-to-native'(切到 native 軌)
 *       不分單語 / 雙語都走 P1。雙語下使用者後續手動切到非 target 軌時,
 *       XHR interceptor 抓到 → translateWindowFrom 自動觸發 → captionMap 寫入
 *       → _applyBilingualMode 動態藏 native CC + 顯示 overlay。
 *   P1.5) 模糊 base-lang `zh` 軌(zh-TW / zh-CN target,手動優先於 ASR)→ action='switch'
 *       (繁簡未定不可盲目 stop,切軌後由下游內容偵測決定 skip 或翻譯;
 *        active 已是該軌無 translation → 'noop' 留給下游)
 *   P2) 影片原始語 manual track（kind=''，source lang 從唯一 ASR track 動態推導）→ action='switch'
 *   P3) 影片原始語 ASR track（kind='asr'）→ action='switch'
 *   沒 ASR 軌 / activeTrack 已對齊目標 → action='noop'
 *
 * 用 createEnv() 載完 7 個 content script 後額外 eval content-youtube.js,
 * 把 chrome / browser stub 都接上（content-youtube.js IIFE 載入時不會打到 storage,
 * 但 attach listener 用得到 window）。pure function 不打 storage / DOM，直接呼叫即可。
 *
 * SANITY 紀錄（已驗證）:
 *   把 _chooseBestCaptionTrack 內 P1 分支拔掉 → P1 case 預期 'switch-to-native' 變 'switch' 失敗 → 還原 pass
 *   把「已對齊目標 → noop」分支拔掉 → already-on-target case 預期 'noop' 變 'switch' 失敗 → 還原 pass
 *   把 P1 內 activeIsP1 skip 分支拔掉 → 'P1 active 已是 native → skip' case 變 'switch-to-native' 失敗 → 還原 pass
 *   把 P1.5 分支的 ambigSet 改 null(等效拔掉整個分支)→ 5 條 P1.5 case fail
 *   (真實 bug 情境 / YT 自翻譯 en active / active 已是 zh 軌 / en ASR+zh manual 優先序 /
 *    zh-CN target 皆 fail;「zh manual+zh ASR」與「target=en」兩條舊路徑同結果屬預期)→ 還原 30/30 pass
 */

const fs = require('fs');
const path = require('path');
const { createEnv, SHINKANSEN_DIR } = require('./helpers/create-env.cjs');

const YT_CODE = fs.readFileSync(path.join(SHINKANSEN_DIR, 'content-youtube.js'), 'utf-8');

function setup() {
  const env = createEnv({ url: 'https://www.youtube.com/watch?v=abc123' });
  // content-youtube.js IIFE 載入時需 window.browser.storage.sync.get（未實際呼叫，只是 closure 引用）,
  // 統一補一份 chrome alias 進 browser 命名空間就好。
  env.window.browser = env.chrome;
  env.window.eval(YT_CODE);
  return env;
}

describe('_chooseBestCaptionTrack', () => {
  let env;
  let chooser;
  afterEach(() => { if (env) { env.cleanup(); env = null; } });

  beforeEach(() => {
    env = setup();
    chooser = env.window.__SK._chooseBestCaptionTrack;
    expect(typeof chooser).toBe('function');
  });

  test('auto skip 簡中：active YT 自翻譯軌 en→zh-Hans 時先略過，不切回原始字幕', () => {
    const tracks = [
      { languageCode: 'en', kind: 'asr' },
      { languageCode: 'en', kind: '' },
    ];
    const activeTrack = {
      languageCode: 'en', kind: 'asr', translationLanguageCode: 'zh-Hans',
    };
    expect(chooser(tracks, activeTrack, 'zh-TW', { skipSimplifiedForZhTw: true }))
      .toMatchObject({ action: 'skip-simplified', reason: 'active-simplified-allowed' });
  });

  test('auto skip 簡中：選項關閉時同一 en→zh-Hans 軌維持既有 switch 行為', () => {
    const tracks = [
      { languageCode: 'en', kind: 'asr' },
      { languageCode: 'en', kind: '' },
    ];
    const activeTrack = {
      languageCode: 'en', kind: 'asr', translationLanguageCode: 'zh-Hans',
    };
    expect(chooser(tracks, activeTrack, 'zh-TW', { skipSimplifiedForZhTw: false }).action)
      .toBe('switch');
  });

  // ─── P1:target lang 原生 track ─────
  //   active 已是 native → skip;active 不是(包含 null=CC off / 別軌)→ switch-to-native

  test('P1: zh-TW native + active=null(CC off)→ switch-to-native', () => {
    const tracks = [
      { languageCode: 'en',    kind: 'asr' },
      { languageCode: 'zh-TW', kind: '' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.reason).toBe('p1-switch-to-native');
    expect(decision.track.languageCode).toBe('zh-TW');
  });

  test('P1: zh-TW native + active 已是 zh-TW manual → skip', () => {
    const tracks = [
      { languageCode: 'en',    kind: 'asr' },
      { languageCode: 'zh-TW', kind: '' },
    ];
    const activeTrack = { languageCode: 'zh-TW', kind: '', translationLanguageCode: null };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('p1-active-already-native');
  });

  test('P1: zh-TW native + active 是 zh-TW ASR(kind 不同)→ switch-to-native(切到 manual)', () => {
    const tracks = [
      { languageCode: 'zh-TW', kind: ''    },
      { languageCode: 'zh-TW', kind: 'asr' },
    ];
    // p1 會挑到陣列第一條 = manual。active 是 ASR kind 不同 → switch-to-native
    const activeTrack = { languageCode: 'zh-TW', kind: 'asr', translationLanguageCode: null };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.track.kind).toBe('');
  });

  test('P1: 真實 bug 回報情境 — native zh-Hant 存在但 active=en → switch-to-native', () => {
    // OHAjc-ayhus 類型:影片同時有 native EN + native zh-Hant,
    // YT 帳號預設顯示 EN。修法前:P1 命中 skip,使用者看到沒翻的英文。
    // 修法後:active=en ≠ p1(zh-Hant)→ switch-to-native 切到 zh-Hant。
    const tracks = [
      { languageCode: 'en',      kind: '' },
      { languageCode: 'zh-Hant', kind: '' },
    ];
    const activeTrack = { languageCode: 'en', kind: '', translationLanguageCode: null };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.track.languageCode).toBe('zh-Hant');
  });

  test('P1: active 是 zh-Hant 但 translationLanguageCode 有值 → switch-to-native(清掉自翻譯)', () => {
    const tracks = [{ languageCode: 'zh-Hant', kind: '' }];
    const activeTrack = { languageCode: 'zh-Hant', kind: '', translationLanguageCode: 'ja' };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
  });

  test('P1: zh-Hant native + null active → switch-to-native（繁體變體）', () => {
    const tracks = [
      { languageCode: 'en',      kind: 'asr' },
      { languageCode: 'zh-Hant', kind: '' },
    ];
    expect(chooser(tracks, null, 'zh-TW').action).toBe('switch-to-native');
  });

  test('P1: zh-HK native + null active → switch-to-native（港式繁體也算）', () => {
    const tracks = [
      { languageCode: 'en',    kind: 'asr' },
      { languageCode: 'zh-HK', kind: '' },
    ];
    expect(chooser(tracks, null, 'zh-TW').action).toBe('switch-to-native');
  });

  test('P1: zh-TW ASR 唯一 + null active → switch-to-native', () => {
    const tracks = [
      { languageCode: 'zh-TW', kind: 'asr' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.track.kind).toBe('asr');
  });

  test('P1: zh-CN manual 不算 zh-TW target 的 P1（簡轉繁不在此 path 內）', () => {
    const tracks = [
      { languageCode: 'zh-CN', kind: '' },
      { languageCode: 'en',    kind: 'asr' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).not.toBe('skip');
    expect(decision.action).not.toBe('switch-to-native');
  });

  // ─── P2：英文 manual track 優先 ─────
  test('P2: en manual + en ASR 都在 → 切到 en manual(kind=\'\')', () => {
    const tracks = [
      { languageCode: 'en', kind: ''    },
      { languageCode: 'en', kind: 'asr' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p2-source-manual');
    expect(decision.track.kind).toBe('');
  });

  // ─── P3：只剩 en ASR → 切到 ASR ─────
  test('P3: 只有 en ASR → 切到 ASR', () => {
    const tracks = [{ languageCode: 'en', kind: 'asr' }];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p3-source-asr');
    expect(decision.track.kind).toBe('asr');
  });

  // ─── 已對齊目標 → noop ─────
  test('activeTrack 已是 en ASR 無 translation → noop（不重複 setOption）', () => {
    const tracks = [{ languageCode: 'en', kind: 'asr' }];
    const activeTrack = { languageCode: 'en', kind: 'asr', translationLanguageCode: null };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('noop');
    expect(decision.reason).toBe('already-on-target');
  });

  test('activeTrack 是 en ASR 但 translationLanguage=zh-Hans → switch（YT 自翻譯軌）', () => {
    const tracks = [{ languageCode: 'en', kind: 'asr' }];
    const activeTrack = { languageCode: 'en', kind: 'asr', translationLanguageCode: 'zh-Hans' };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.track.languageCode).toBe('en');
  });

  // ─── 多語 source(generalize 之後)─────
  test('zh-TW target + 只有 ja ASR → switch 到 ja ASR(sourceLanguage=ja)', () => {
    const tracks = [{ languageCode: 'ja', kind: 'asr' }];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p3-source-asr');
    expect(decision.sourceLanguage).toBe('ja');
    expect(decision.track.languageCode).toBe('ja');
  });

  test('zh-TW target + ja ASR + ja manual → switch 到 ja manual(P2 優先)', () => {
    const tracks = [
      { languageCode: 'ja', kind: 'asr' },
      { languageCode: 'ja', kind: ''    },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p2-source-manual');
    expect(decision.sourceLanguage).toBe('ja');
    expect(decision.track.kind).toBe('');
  });

  test('zh-TW target + ja ASR + en manual → switch 到 ja ASR(只 honor 原始口說語,不被 en manual 帶偏)', () => {
    const tracks = [
      { languageCode: 'ja', kind: 'asr' },
      { languageCode: 'en', kind: ''    },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.sourceLanguage).toBe('ja');
    expect(decision.track.languageCode).toBe('ja');
    expect(decision.track.kind).toBe('asr');
  });

  test('沒 ASR 軌(只有 manual)→ noop 無法可靠決定 source lang', () => {
    const tracks = [{ languageCode: 'en', kind: '' }];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('noop');
    expect(decision.reason).toBe('no-source-asr-track');
  });

  test('空 tracks → noop', () => {
    expect(chooser([], null, 'zh-TW').action).toBe('noop');
    expect(chooser(null, null, 'zh-TW').action).toBe('noop');
  });

  // ─── 動態 target lang ─────
  test('target=zh-CN:zh-Hans manual + null active → switch-to-native', () => {
    const tracks = [
      { languageCode: 'zh-Hans', kind: '' },
      { languageCode: 'en',      kind: 'asr' },
    ];
    const decision = chooser(tracks, null, 'zh-CN');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.track.languageCode).toBe('zh-Hans');
  });

  test('target=ja:ja ASR + null active → switch-to-native（不該被當英文路徑處理）', () => {
    const tracks = [
      { languageCode: 'ja', kind: 'asr' },
      { languageCode: 'en', kind: ''    },
    ];
    const decision = chooser(tracks, null, 'ja');
    expect(decision.action).toBe('switch-to-native');
  });

  test('target=en:en ASR + active 已是 en ASR → skip', () => {
    // 邊角 case：使用者 target=en 看英文影片,active 已是 en ASR → P1 active 對齊 → skip。
    const tracks = [{ languageCode: 'en', kind: 'asr' }];
    const activeTrack = { languageCode: 'en', kind: 'asr', translationLanguageCode: null };
    const decision = chooser(tracks, activeTrack, 'en');
    expect(decision.action).toBe('skip');
  });

  // ─── 多 track 優先級 ─────
  test('en manual + zh-TW manual + null active → P1 優先 → switch-to-native(zh-TW)', () => {
    const tracks = [
      { languageCode: 'en',    kind: '' },
      { languageCode: 'zh-TW', kind: '' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.track.languageCode).toBe('zh-TW');
  });

  // ─── P1.5:模糊 base-lang `zh` 原生候選(zh-TW / zh-CN target)─────
  // Regression:台灣影片只有一條 `zh` 手動軌、沒 ASR 軌 → 舊版 chooser noop
  // (no-source-asr-track),YT 帳號 auto-translate 偏好讓字幕停在英文自翻軌,
  // Shinkansen 再把英文翻回中文(雙重翻譯)。修法:`zh` 軌視為可能原生候選,
  // action='switch' 切過去,由下游內容偵測決定 skip(已是繁中)或翻譯(簡中)。

  test('P1.5: 真實 bug 回報情境 — 只有 `zh` 手動軌沒 ASR + active=null → switch(不再 noop)', () => {
    // 對應影片 6tzoIQman-s 的真實 player response track 結構
    const tracks = [{ languageCode: 'zh', kind: '', isTranslatable: true, vssId: '.zh', name: '中文' }];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p1b-ambiguous-native');
    expect(decision.track.languageCode).toBe('zh');
    expect(decision.sourceLanguage).toBe('zh');
  });

  test('P1.5: `zh` 手動軌 + active 是 zh 被 YT 自翻譯成 en → switch(清掉自翻譯)', () => {
    const tracks = [{ languageCode: 'zh', kind: '' }];
    const activeTrack = { languageCode: 'zh', kind: '', translationLanguageCode: 'en' };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p1b-ambiguous-native');
  });

  test('P1.5: active 已是 `zh` 手動軌無 translation → noop(留給下游內容偵測)', () => {
    const tracks = [{ languageCode: 'zh', kind: '' }];
    const activeTrack = { languageCode: 'zh', kind: '', translationLanguageCode: null };
    const decision = chooser(tracks, activeTrack, 'zh-TW');
    expect(decision.action).toBe('noop');
    expect(decision.reason).toBe('p1b-ambiguous-native-active');
  });

  test('P1.5: `zh` 手動軌 + `zh` ASR 軌 → 選手動軌', () => {
    const tracks = [
      { languageCode: 'zh', kind: 'asr' },
      { languageCode: 'zh', kind: '' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.track.kind).toBe('');
  });

  test('P1.5 優先於 P2/P3: en ASR + `zh` 手動軌 → 切 `zh` 手動軌(不切去翻 en 源語)', () => {
    const tracks = [
      { languageCode: 'en', kind: 'asr' },
      { languageCode: 'zh', kind: '' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p1b-ambiguous-native');
    expect(decision.track.languageCode).toBe('zh');
  });

  test('P1 優先於 P1.5: zh-Hant 軌 + `zh` 軌 → switch-to-native(zh-Hant)', () => {
    const tracks = [
      { languageCode: 'zh',      kind: '' },
      { languageCode: 'zh-Hant', kind: '' },
    ];
    const decision = chooser(tracks, null, 'zh-TW');
    expect(decision.action).toBe('switch-to-native');
    expect(decision.track.languageCode).toBe('zh-Hant');
  });

  test('P1.5 只對 zh target: target=en + 只有 `zh` 手動軌沒 ASR → 維持 noop', () => {
    const tracks = [{ languageCode: 'zh', kind: '' }];
    const decision = chooser(tracks, null, 'en');
    expect(decision.action).toBe('noop');
    expect(decision.reason).toBe('no-source-asr-track');
  });

  test('P1.5: target=zh-CN + 只有 `zh` 手動軌 → switch(簡中 target 同樣適用)', () => {
    const tracks = [{ languageCode: 'zh', kind: '' }];
    const decision = chooser(tracks, null, 'zh-CN');
    expect(decision.action).toBe('switch');
    expect(decision.reason).toBe('p1b-ambiguous-native');
  });

  // chooser 不再吃 bilingualMode 參數 — bilingual 的差異化處理移到 caller
  // (activate flow:雙語下 switch-to-native 不 stop;_applyBilingualMode:caption 是 target 不藏 CC)
});
