'use strict';

/**
 * v1.10.46 批次 5-1（code review 2026-06-11）：cache key 組裝 + glossary 合併收斂單一資料源。
 *
 * 背景：handleTranslate / handleTranslateStream / handleTranslateCustom 原是三份手抄
 * （批次 1-2 的 `=` vs `+=` 就是抄漏證據）。streaming 的 fixedGlossary 合併另外 drift 出
 * 兩個行為差：無 Map dedup（buildFixedGlossaryEntries 有）、沒呼叫
 * preferArticleGlossaryEntries（handleTranslate 有）→ global+domain 同 source 重疊時
 * batch 0（streaming）與 batch 1+（non-streaming）算出不同 _g hash，同頁兩個 cache
 * namespace。修法：抽 buildCacheKeySuffix 共用 + streaming 直接呼叫
 * buildFixedGlossaryEntries / preferArticleGlossaryEntries。
 *
 * 測試手法（行為級，批次 1 完成註記預告的補強）：background.js 是 ES module、top-level
 * 大量 side effect，jest cjs 無法整檔載入 → 用 brace-counting 從 source 抽出
 * buildCacheKeySuffix / buildFixedGlossaryEntries / preferArticleGlossaryEntries 三個
 * 純函式本體，new Function 注入 stub cache 後直接呼叫驗行為。
 *
 * 訊號層界定：驗「函式本體的組裝／合併行為」與「單一資料源結構」，不驗三條 handler 在
 * 真實 SW 環境端到端組出的 key（那要真 SW；getBatch/setBatch 呼叫點的接線由
 * cache-key-stream-mismatch.test.cjs 的 source 斷言鎖住）。
 *
 * SANITY 紀錄（已驗證，2026-06-11）：
 *   - 暫時把 buildCacheKeySuffix 的 `suffix += '_g'` 改成 `suffix = '_g'` →
 *     「cacheTag 起頭」case fail；還原 → pass
 *   - 暫時把 buildFixedGlossaryEntries 的 Map dedup 改回 concat →「同 source dedup」
 *     case fail；還原 → pass
 *
 * SANITY 紀錄（已驗證，2026-07-27，docExtraPrompt _x suffix）：
 *   - 暫時把 buildCacheKeySuffix 的 `_x` append 條件改成 `if (false && …)` →
 *     兩個 _x case fail；還原 → 14 pass
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'),
  'utf-8'
);

// 以 brace counting 抽出具名 function 宣告本體（函式內的 template literal `${}` 括號
// 自身平衡，不影響計數；這三個函式內沒有不平衡括號字串）
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`source 找不到 function ${name}`);
  const asyncStart = SRC.slice(Math.max(0, start - 6), start).includes('async')
    ? start - 6 : start;
  // 先配對參數括號（參數可能是解構 { ... }，不能直接從第一個 '{' 數 brace）
  let i = SRC.indexOf('(', start);
  let parenDepth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') parenDepth++;
    else if (SRC[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  // 參數結束後的第一個 '{' 才是函式本體
  let depth = 0;
  i = SRC.indexOf('{', i);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return SRC.slice(asyncStart, i + 1);
}

// stub cache：hashText 決定性假 hash（內容不同 → hash 不同），hashForbiddenTerms 空清單回 ''
const stubCache = {
  async hashText(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0').repeat(5); // 40 chars,夠 slice(0,12)
  },
  async hashForbiddenTerms(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return 'fb' + (await this.hashText(list.join('|'))).slice(0, 6);
  },
};

const buildCacheKeySuffix = new Function(
  'cache',
  `${extractFn('buildCacheKeySuffix')}; return buildCacheKeySuffix;`
)(stubCache);

const buildFixedGlossaryEntries = new Function(
  `${extractFn('buildFixedGlossaryEntries')}; return buildFixedGlossaryEntries;`
)();

const preferArticleGlossaryEntries = new Function(
  `${extractFn('preferArticleGlossaryEntries')}; return preferArticleGlossaryEntries;`
)();

describe('buildCacheKeySuffix 組裝行為', () => {
  test("cacheTag 永遠是起頭（有 glossary 時 '_g' 附加在後,不覆蓋）", async () => {
    const suffix = await buildCacheKeySuffix({
      cacheTag: '_doc',
      glossary: [{ source: 'Trump', target: '川普' }],
      modelKeyPart: 'gemini-3-flash-lite',
      targetLanguage: 'zh-TW',
    });
    expect(suffix.startsWith('_doc_g')).toBe(true);
    // _doc 標記在 → clearDocTranslationCache 的 /_doc(_m|$)/ 掃得到
    expect(suffix).toMatch(/_doc(_m|_g)/);
  });

  test('無 glossary 無 forbidden 時只有 cacheTag + _m', async () => {
    const suffix = await buildCacheKeySuffix({
      cacheTag: '_yt',
      modelKeyPart: 'm1',
      targetLanguage: 'zh-TW',
    });
    expect(suffix).toBe('_yt_mm1');
  });

  test('forbiddenTerms 非空加 _b;targetLanguage 非 zh-TW 加 _lang;zh-TW 不加', async () => {
    const a = await buildCacheKeySuffix({
      cacheTag: '', forbiddenTermsList: ['視頻'], modelKeyPart: 'm1', targetLanguage: 'en',
    });
    expect(a).toMatch(/_bfb[0-9a-f]{6}_mm1_langen$/);
    const b = await buildCacheKeySuffix({
      cacheTag: '', modelKeyPart: 'm1', targetLanguage: 'zh-TW',
    });
    expect(b).toBe('_mm1');
  });

  test('docTemperature 有限數值才加 _t（undefined / NaN 不加）', async () => {
    const withT = await buildCacheKeySuffix({
      cacheTag: '_doc', modelKeyPart: 'm1', docTemperature: 0.3,
    });
    expect(withT.endsWith('_t0.30')).toBe(true);
    const noT = await buildCacheKeySuffix({
      cacheTag: '_doc', modelKeyPart: 'm1', docTemperature: NaN,
    });
    expect(noT.includes('_t')).toBe(false);
  });

  test('glossary 內容不同 → _g hash 不同（不同術語表不共用快取）', async () => {
    const a = await buildCacheKeySuffix({
      cacheTag: '', glossary: [{ source: 'a', target: 'b' }], modelKeyPart: 'm1',
    });
    const b = await buildCacheKeySuffix({
      cacheTag: '', glossary: [{ source: 'a', target: 'c' }], modelKeyPart: 'm1',
    });
    expect(a).not.toBe(b);
  });
});

describe('docExtraPrompt（本文件額外翻譯指令，2026-07-27）_x suffix', () => {
  test('非空加 _x<hash12> 且附加在 _t 之後（固定順序）；空 / 空白 / 未傳不加（清空回原 key，舊快取直接可用）', async () => {
    const base = { cacheTag: '_doc', modelKeyPart: 'm1', docTemperature: 0.5 };
    const withX = await buildCacheKeySuffix({ ...base, docExtraPrompt: '語氣請古典一點' });
    expect(withX).toMatch(/_t0\.50_x[0-9a-f]{12}$/);
    const noX = await buildCacheKeySuffix(base);
    const emptyX = await buildCacheKeySuffix({ ...base, docExtraPrompt: '' });
    const blankX = await buildCacheKeySuffix({ ...base, docExtraPrompt: '   \n ' });
    expect(noX.includes('_x')).toBe(false);
    expect(emptyX).toBe(noX);
    expect(blankX).toBe(noX);
  });

  test('trim 後相同內容 → 同 hash（前後空白不分裂快取）；內容不同 → hash 不同', async () => {
    const base = { cacheTag: '_doc', modelKeyPart: 'm1' };
    const a = await buildCacheKeySuffix({ ...base, docExtraPrompt: '人名一律音譯' });
    const b = await buildCacheKeySuffix({ ...base, docExtraPrompt: '  人名一律音譯  ' });
    const c = await buildCacheKeySuffix({ ...base, docExtraPrompt: '人名保留原文' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('handler 接線：兩條 doc handler（gemini / openai-compat）prompt 組裝與 cache key 都讀 payload.extraPrompt，且 marker 協定收尾', () => {
    // docExtraPromptOf(payload) 應出現 ≥4 次：2 條 handler 的 prompt 組裝 + 2 條翻譯
    // 路徑（handleTranslate / handleTranslateCustom）的 buildCacheKeySuffix 傳參
    const calls = SRC.match(/docExtraPromptOf\(payload\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // 附加位置：extraPrompt 在前、DOC_INLINE_MARKER_INSTRUCTION 收尾（協定規則不被
    // per-document 指令蓋掉）——兩條 handler 都要是這個順序
    const orderRe = /extraPrompt ? \? '\\n\\n' \+ extraPrompt : ''\)\s*\+ DOC_INLINE_MARKER_INSTRUCTION/g;
    expect((SRC.match(orderRe) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('streaming glossary drift 修復:global+domain 同 source 重疊', () => {
  const fg = {
    global: [{ source: 'Trump', target: '川普' }, { source: 'AI', target: '人工智慧' }],
    byDomain: { 'example.com': [{ source: 'Trump', target: '特朗普' }] },
  };
  const sender = { tab: { url: 'https://example.com/article' } };

  test('buildFixedGlossaryEntries 對同 source 做 Map dedup（domain 蓋 global）', () => {
    const entries = buildFixedGlossaryEntries(fg, sender);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.source === 'Trump').target).toBe('特朗普');
  });

  test('dedup 後的 entries → 同一組輸入算出同一個 _g hash（單頁單一 cache namespace）', async () => {
    // 模擬 streaming（batch 0）與 non-streaming（batch 1+）各自走共用函式組 key:
    // 兩邊都呼叫 buildFixedGlossaryEntries → 同 entries → 同 hash。
    // （舊 streaming 手抄版是 concat 不 dedup → 3 條 entry → hash 必不同,本 case 鎖住修復後等價性）
    const entries1 = buildFixedGlossaryEntries(fg, sender);
    const entries2 = buildFixedGlossaryEntries(fg, sender);
    const k1 = await buildCacheKeySuffix({ cacheTag: '', fixedGlossaryEntries: entries1, modelKeyPart: 'm1' });
    const k2 = await buildCacheKeySuffix({ cacheTag: '', fixedGlossaryEntries: entries2, modelKeyPart: 'm1' });
    expect(k1).toBe(k2);
    // 舊手抄 concat（不 dedup）的結果跟 dedup 後不同 → 證明 dedup 與否確實改變 key
    const concatEntries = [...fg.global, ...fg.byDomain['example.com']];
    const kOld = await buildCacheKeySuffix({ cacheTag: '', fixedGlossaryEntries: concatEntries, modelKeyPart: 'm1' });
    expect(kOld).not.toBe(k1);
  });

  test('streaming 路徑 source 接線:呼叫 buildFixedGlossaryEntries + preferArticleGlossaryEntries', () => {
    // 從 handleTranslateStream 函式本體內找兩個共用函式呼叫（不得回退手抄 merge）
    const fnBody = extractFn('handleTranslateStream');
    expect(fnBody).toMatch(/buildFixedGlossaryEntries\(/);
    expect(fnBody).toMatch(/preferArticleGlossaryEntries\(/);
  });
});

describe('preferArticleGlossaryEntries 行為（streaming 補上的另一半 drift）', () => {
  test('enabled 時 article 同 source 的 fixed entry 被移除', () => {
    const fixed = [{ source: 'AI', target: '人工智慧' }, { source: 'Trump', target: '川普' }];
    const article = [{ source: 'AI', target: 'AI' }];
    const out = preferArticleGlossaryEntries(fixed, article, true);
    expect(out).toEqual([{ source: 'Trump', target: '川普' }]);
  });

  test('全部被 article 蓋掉時回 null（不留空陣列）', () => {
    const fixed = [{ source: 'AI', target: '人工智慧' }];
    const out = preferArticleGlossaryEntries(fixed, [{ source: 'AI', target: 'AI' }], true);
    expect(out).toBeNull();
  });

  test('未 enabled 時原樣返回', () => {
    const fixed = [{ source: 'AI', target: '人工智慧' }];
    expect(preferArticleGlossaryEntries(fixed, [{ source: 'AI', target: 'AI' }], false)).toBe(fixed);
  });
});
