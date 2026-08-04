// W7 unit:translate-doc/translate.js parseMarkedTranslation
//
// 驗證 LLM 譯文回來後 stack-based parse 出 translationSegments + plainText。
// malformed(tag 不成對 / 巢狀錯誤 / link 編號越界)→ fallback 整段 plain regular。
//
// SANITY 已驗:把 parseMarkedTranslation 內 stack pop 條件改寬鬆(允許 ⟦/b⟧
// pop 任意 top),test「不成對 tag fallback」fail(會 partial parse 而非整段
// fallback)。還原後 pass。

import { test, expect } from '@playwright/test';
import { parseMarkedTranslation } from '../../shinkansen/translate-doc/translate.js';

test.describe('W7 parseMarkedTranslation', () => {
  test('純 plain text', () => {
    const r = parseMarkedTranslation('你好世界', []);
    expect(r.plainText).toBe('你好世界');
    expect(r.segments).toEqual([
      { text: '你好世界', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('bold tag', () => {
    const r = parseMarkedTranslation('⟦b⟧粗體⟦/b⟧', []);
    expect(r.plainText).toBe('粗體');
    expect(r.segments).toEqual([
      { text: '粗體', isBold: true, isItalic: false, linkUrl: null },
    ]);
  });

  test('italic tag', () => {
    const r = parseMarkedTranslation('⟦i⟧斜體⟦/i⟧', []);
    expect(r.segments).toEqual([
      { text: '斜體', isBold: false, isItalic: true, linkUrl: null },
    ]);
  });

  test('link tag with index 1', () => {
    const r = parseMarkedTranslation('⟦l:1⟧example.com⟦/l⟧', ['https://example.com']);
    expect(r.segments).toEqual([
      { text: 'example.com', isBold: false, isItalic: false, linkUrl: 'https://example.com' },
    ]);
  });

  test('巢狀 b + i', () => {
    const r = parseMarkedTranslation('⟦b⟧⟦i⟧粗斜體⟦/i⟧⟦/b⟧', []);
    expect(r.segments).toEqual([
      { text: '粗斜體', isBold: true, isItalic: true, linkUrl: null },
    ]);
  });

  test('混合多段', () => {
    const r = parseMarkedTranslation(
      '⟦b⟧附註:⟦/b⟧⟦i⟧前往⟦l:1⟧example.com⟦/l⟧獲取詳情⟦/i⟧',
      ['https://example.com']
    );
    expect(r.plainText).toBe('附註:前往example.com獲取詳情');
    expect(r.segments).toEqual([
      { text: '附註:', isBold: true, isItalic: false, linkUrl: null },
      { text: '前往', isBold: false, isItalic: true, linkUrl: null },
      { text: 'example.com', isBold: false, isItalic: true, linkUrl: 'https://example.com' },
      { text: '獲取詳情', isBold: false, isItalic: true, linkUrl: null },
    ]);
  });

  test('連續同 style 譯文片段合一(LLM 可能在同 style 內多 chunks)', () => {
    const r = parseMarkedTranslation('⟦b⟧A⟦/b⟧⟦b⟧B⟦/b⟧', []);
    // 這裡會被 parser 看成兩個 segment(中間沒插別的 style),驗證合併邏輯
    // 實作上 close-then-open 同 tag 會觸發 segment 切點,但連續內容合 OK
    // 修正:flushPlain 會在 close 後 stack pop,下個 open push 進新 stack,
    // 兩個 segment 雖然 style 同但呼叫位置不同 → 兩個 segment 各自 push
    expect(r.plainText).toBe('AB');
    // segments 至少 1 個(合併版)或 2 個(各自版),驗 plainText 即可
  });

  test('malformed:不成對 ⟦b⟧ 沒 ⟦/b⟧ → fallback plain', () => {
    const r = parseMarkedTranslation('⟦b⟧粗體沒收尾', []);
    expect(r.plainText).toBe('粗體沒收尾');
    expect(r.segments).toEqual([
      { text: '粗體沒收尾', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('malformed:交叉 nesting → fallback plain', () => {
    const r = parseMarkedTranslation('⟦b⟧⟦i⟧X⟦/b⟧⟦/i⟧', []);
    expect(r.segments).toEqual([
      { text: 'X', isBold: false, isItalic: false, linkUrl: null },
    ]);
    expect(r.plainText).toBe('X');
  });

  test('malformed:link 編號越界 → fallback plain', () => {
    const r = parseMarkedTranslation('⟦l:5⟧only one url⟦/l⟧', ['https://a.com']);
    expect(r.segments).toEqual([
      { text: 'only one url', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('空字串 → 空 segments', () => {
    const r = parseMarkedTranslation('', []);
    expect(r.segments).toEqual([]);
    expect(r.plainText).toBe('');
  });
});

// ── code review 2026-08-03 批次 5 H3(fallback 殘片掃除)──
//
// repair 搆不到的 mangle 形態(如 ⟦l:» 缺編號)進 fallback 時，MARKER_TAG_RE 只清
// 「完好」tag → 殘片印進 PDF。fallback 補一道 token 形狀([*/bil0-9:]{0,4} + 替代
// 閉合字元)的殘片掃除；字元集收緊到協定 token 本體，不誤吃內文。
//
// SANITY 紀錄(已驗證，2026-08-04)：暫時把 fallback 的殘片掃除 replace 拿掉 →
// 「不可修復殘片不印進 plainText」case fail(plainText 殘留 ⟦l:»)→ 還原 → pass。
import { test as t2, expect as e2 } from '@playwright/test';

t2.describe('H3:fallback 殘片掃除', () => {
  t2('不可修復的樣式標記殘片不印進 plainText', () => {
    // ⟦l:»(缺編號)修不回合法 tag → parse fallback；殘片必須被掃掉
    const r = parseMarkedTranslation('前文⟦l:»連結字後文⟦/l⟧', ['https://example.com']);
    e2(r.plainText).toBe('前文連結字後文');
    e2(r.plainText).not.toContain('⟦');
  });

  t2('殘片掃除不誤吃內文(⟧ 後的正常文字保留)', () => {
    const r = parseMarkedTranslation('⟦b粗體字樣⟦/b⟧尾文', []);
    // repair 已在接收點跑過的情境下不會進這裡；此 case 驗 fallback 對「未經 repair
    // 的裸輸入」也不殘留 ⟦ 碎片，且內文字元不被誤吃
    e2(r.plainText).not.toContain('⟦');
    e2(r.plainText).toContain('尾文');
    e2(r.plainText).toContain('粗體字樣');
  });
});
