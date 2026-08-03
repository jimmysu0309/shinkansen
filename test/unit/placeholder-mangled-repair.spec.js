// Regression: placeholder-mangled-repair（對應 v2.0.53 修的「EPUB 譯文句尾洩漏
// /0»、/2» 碎片」bug）
//
// Bug：模型（日文書實測 gemini-3.5-flash，1700 段中 57 段）把佔位符閉合標記的
// ⟧ 寫成 »（⟦/2⟧ → ⟦/2»），或段尾整個漏寫。stripPlaceholderTokens 的殘留括號
// 清理只削掉 ⟦ 留下「/2»」碎片洩漏到預覽 / session plain；translationRaw 帶壞
// 標記也讓 epub-writer 反序列化丟失該 slot 的 inline 元素。
// 修法：repairMangledPlaceholders 錨定「⟦ + (*/?)數字 + 非 ⟧」pattern 補回 ⟧
//（⟦ 是協定專用字元，此前綴必然是壞標記），套在 1) 譯文接收點（快取命中也走，
// 舊壞快取自動治癒）2) stripPlaceholderTokens 3) hydrateSessionBlocks（舊 session
// 自癒——plain 是被削過的殘骸救不回，從修好的 raw 重新 strip）。
//
// SANITY 紀錄（已驗證）：
// 1. repairMangledPlaceholders 改 no-op → 7 條 fail（raw 殘留 ⟦/0»、plain 殘留
//    /0» 碎片）→ 還原全綠
// 2. stripTrailingSeparatorGarbage 改 no-op → 2 條 fail → 還原全綠
// 3. collapseCjkPlaceholderSpaces 改 no-op → 2 條 fail → 還原全綠
// 4. collapseCjkAsciiSpaces 改 no-op → 3 條 fail（？後空格殘留 + strip 換行
//    壓縮殘留）→ 還原全綠
// 5. alignTrailingPeriodWithSource 改 no-op → 3 條 fail（實測三例句尾「。」
//    未刪 + 標記殼 + 標題 + hydrate 對齊）→ 還原全綠
// 6. hydrate 的 editedHtml 優先分支 revert 成「一律從 raw 重算」→「editedHtml
//    優先」case fail（translation 被 raw 舊值 京浜急行 蓋回）→ 還原全綠
// 7. collapseDoubledTitleMarks 開頭加 `if (true) return s` → 3 條 fail（《《雷霆谷》》
//    未收斂 ×2 + 全鏈「《 《」case）→ 還原全綠（2026-07-12 Jimmy 回報術語表
//    含《》譯名被模型外包一層書名號）
import { test, expect } from '@playwright/test';

// ── Mock chrome（同 doc-batch-lang-mismatch-retry.spec.js 形狀）──
let storedKeys = {};
globalThis.window = globalThis.window || {};
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({ targetLanguage: 'zh-TW' }), set: async () => {}, remove: async () => {} },
    local: {
      get: async () => ({ ...storedKeys }),
      set: async (obj) => { Object.assign(storedKeys, obj); },
      remove: async (keys) => { [].concat(keys).forEach((k) => delete storedKeys[k]); },
    },
  },
  runtime: {},
};

const {
  translateDocument,
  repairMangledPlaceholders,
  stripTrailingSeparatorGarbage,
  collapseCjkPlaceholderSpaces,
  collapseCjkAsciiSpaces,
  collapseDoubledTitleMarks,
  alignTrailingPeriodWithSource,
  repairDocLlmArtifacts,
  stripPlaceholderTokens,
} = await import('../../shinkansen/translate-doc/translate.js');
const { hydrateSessionBlocks } = await import('../../shinkansen/translate-doc/epub-session-db.js');

// ── repairMangledPlaceholders 純函式 ─────────────────────────
test.describe('repairMangledPlaceholders', () => {
  test('閉合 ⟧ 被寫成 » → 修復並吃掉 »（實測樣本）', () => {
    expect(repairMangledPlaceholders('「才剛回來呢。」⟦2⟧⟦/2»'))
      .toBe('「才剛回來呢。」⟦2⟧⟦/2⟧');
    expect(repairMangledPlaceholders('盯著桌上那杯水看了一會兒。⟦/0»'))
      .toBe('盯著桌上那杯水看了一會兒。⟦/0⟧');
  });

  test('段尾閉合括號整個漏寫 → 補回 ⟧', () => {
    expect(repairMangledPlaceholders('⟦0⟧內文⟦/0')).toBe('⟦0⟧內文⟦/0⟧');
  });

  test('標記後接一般文字（閉合被吃進內文）→ 補 ⟧ 不消耗內文字元', () => {
    expect(repairMangledPlaceholders('⟦1伯⟦/1⟧')).toBe('⟦1⟧伯⟦/1⟧');
  });

  test('完好標記（含 ⟦*N⟧ 自閉合與多位數）不動', () => {
    const ok = '⟦*0⟧⟦1⟧伯⟦/1⟧⟦2⟧父⟦/2⟧老了好多⟦12⟧x⟦/12⟧';
    expect(repairMangledPlaceholders(ok)).toBe(ok);
  });

  test('內文合法 «» 引號（無 ⟦N 前綴）不受影響', () => {
    const s = '他說：«早安»，然後離開了。';
    expect(repairMangledPlaceholders(s)).toBe(s);
  });
});

// ── stripTrailingSeparatorGarbage：段尾分隔符殘片 ─────────────
test.describe('stripTrailingSeparatorGarbage', () => {
  test('段尾殘缺分隔符幻覺（實測樣本 c12-b37）→ 清除', () => {
    expect(stripTrailingSeparatorGarbage('⟦0⟧ 牛島一邊掏出香菸，一邊走了過來。⟦/0⟧\n<<<//22»'))
      .toBe('⟦0⟧ 牛島一邊掏出香菸，一邊走了過來。⟦/0⟧');
  });

  test('內文中段的 <<< 不受影響', () => {
    const mid = 'a <<< b 之後還有正文。';
    expect(stripTrailingSeparatorGarbage(mid)).toBe(mid);
  });

  // v2.0.75:SHINKANSEN_SEP 為協定保留字,任何包裹形態(角括號 1-6 個 / 大小寫
  // 變體 / 段中位置)都不可能合法出現在單段譯文——正常分隔符在 gemini split
  // 階段就被消耗,殘留者必為模型幻覺(2L ink 亂碼 PDF 實測:整批 cell 殘留
  // 「<<SHINKANSEN_SEP>>」兩角括號變體)。舊斷言「完整閉合不動」隨政策作廢。
  // SANITY(已驗證):暫時註解掉 stripTrailingSeparatorGarbage 的 SHINKANSEN_SEP
  // replace 行 → 本組三條 fail → 還原 pass
  test('SHINKANSEN_SEP 保留字任何變體一律清(v2.0.75)', () => {
    expect(stripTrailingSeparatorGarbage('未發現 <<SHINKANSEN_SEP>> PP'))
      .toBe('未發現 PP');
    expect(stripTrailingSeparatorGarbage('正文<<<SHINKANSEN_SEP>>>'))
      .toBe('正文');
    expect(stripTrailingSeparatorGarbage('通過 <<shinkansen_sep>> 之後還有正文'))
      .toBe('通過 之後還有正文');
  });

  test('repairDocLlmArtifacts 總管：畸形標記 + 分隔符殘片一次修', () => {
    expect(repairDocLlmArtifacts('內文。⟦/0»\n<<<//22»'))
      .toBe('內文。⟦/0⟧');
  });
});

// ── collapseCjkPlaceholderSpaces：標記周邊 CJK 空格收斂 ────────
test.describe('collapseCjkPlaceholderSpaces', () => {
  test('每個標記前後塞空格（實測樣本 c25-b30）→ 全部收斂', () => {
    expect(collapseCjkPlaceholderSpaces(
      '⟦0⟧ 兩個男人同時抬起頭來。右邊的男人稍微 ⟦/0⟧ ⟦1⟧ 歪 ⟦/1⟧ ⟦2⟧ 著頭，說道。 ⟦/2⟧',
    )).toBe('⟦0⟧兩個男人同時抬起頭來。右邊的男人稍微⟦/0⟧⟦1⟧歪⟦/1⟧⟦2⟧著頭，說道。⟦/2⟧');
  });

  test('\\n（<br> 語意）不動、CJK/拉丁邊界空格不動', () => {
    const withBr = '中文⟦/0⟧\n⟦1⟧下一行';
    expect(collapseCjkPlaceholderSpaces(withBr)).toBe(withBr);
    const latin = 'The ⟦1⟧word⟦/1⟧ and 之後還有 text 混排。';
    expect(collapseCjkPlaceholderSpaces(latin)).toBe(latin);
  });

  test('stripPlaceholderTokens 後不殘留 CJK 間空格', () => {
    expect(stripPlaceholderTokens('男人稍微 ⟦/0⟧ ⟦1⟧ 歪 ⟦/1⟧ ⟦2⟧ 著頭，說道。 ⟦/2⟧'))
      .toBe('男人稍微歪著頭，說道。');
  });
});

// ── collapseDoubledTitleMarks：雙重書名號收斂 ─────────────────
test.describe('collapseDoubledTitleMarks', () => {
  test('術語表譯名已含《》又被模型外包一層（2026-07-12 實測「《《雷霆谷》》」）→ 收斂', () => {
    expect(collapseDoubledTitleMarks('電視上的《《雷霆谷》》；那一幕是'))
      .toBe('電視上的《雷霆谷》；那一幕是');
    expect(collapseDoubledTitleMarks('《《變換房間》》和《《大地之力》》'))
      .toBe('《變換房間》和《大地之力》');
  });

  test('單層書名號與合法巢狀（開雙閉不雙）不動', () => {
    const single = '看了《雷霆谷》三次。';
    expect(collapseDoubledTitleMarks(single)).toBe(single);
    const nested = '他寫了《《紅樓夢》研究》一書。';
    expect(collapseDoubledTitleMarks(nested)).toBe(nested);
  });

  test('repairDocLlmArtifacts 全鏈：「《 《」間空格先收斂再收雙包', () => {
    expect(repairDocLlmArtifacts('電視上的《 《雷霆谷》 》。'))
      .toBe('電視上的《雷霆谷》。');
  });
});

// ── collapseCjkAsciiSpaces：CJK 內文 ASCII 空格收斂 ────────────
test.describe('collapseCjkAsciiSpaces', () => {
  test('日文「？後接空格」慣例殘留（實測樣本）→ 移除', () => {
    expect(collapseCjkAsciiSpaces('「妳懂嗎？ 那本來應該是軍人幹的活。」'))
      .toBe('「妳懂嗎？那本來應該是軍人幹的活。」');
    expect(collapseCjkAsciiSpaces('「一次？ 只有這樣嗎？」'))
      .toBe('「一次？只有這樣嗎？」');
  });

  test('中英空格、全形空格 U+3000、換行不動', () => {
    const mixed = '這是 test 混排，還有 123 個。';
    expect(collapseCjkAsciiSpaces(mixed)).toBe(mixed);
    const fullwidth = '第一章　春';
    expect(collapseCjkAsciiSpaces(fullwidth)).toBe(fullwidth);
    const nl = '第一行\n第二行';
    expect(collapseCjkAsciiSpaces(nl)).toBe(nl);
  });

  test('repairDocLlmArtifacts 全鏈：標記空格 + 內文空格一次收斂', () => {
    expect(repairDocLlmArtifacts('⟦0⟧ 妳懂嗎？ 那本來 ⟦/0⟧'))
      .toBe('⟦0⟧妳懂嗎？那本來⟦/0⟧');
  });

  test('strip 的換行壓縮不留 CJK 間空格（實測樣本 c42-b7），中英空格保留', () => {
    expect(stripPlaceholderTokens('精選譯文如下：\n\n⟦0⟧⟦*1⟧⟦2⟧清水達雄 1985 年⟦/2⟧⟦/0⟧'))
      .toBe('精選譯文如下：清水達雄 1985 年');
  });
});

// ── alignTrailingPeriodWithSource：句尾句號對齊原文 ────────────
test.describe('alignTrailingPeriodWithSource', () => {
  test('原文「」內無句尾句號 → 刪掉譯文自補的「。」（實測三例）', () => {
    expect(alignTrailingPeriodWithSource('「大学二年のとき」', '「大學二年級的時候。」'))
      .toBe('「大學二年級的時候」');
    expect(alignTrailingPeriodWithSource('「ううん。何となく」', '「沒有啦，只是直覺。」'))
      .toBe('「沒有啦，只是直覺」');
    expect(alignTrailingPeriodWithSource('「車の中で待っていればよかったのに」', '「你在車裡等我就好了。」'))
      .toBe('「你在車裡等我就好了」');
  });

  test('原文句尾有終止標點（。／…／？）→ 譯文不動', () => {
    expect(alignTrailingPeriodWithSource('雪が降った。', '下雪了。')).toBe('下雪了。');
    expect(alignTrailingPeriodWithSource('「そうか…」', '「這樣啊……。」')).toBe('「這樣啊……。」');
    expect(alignTrailingPeriodWithSource('本当か？', '真的嗎？')).toBe('真的嗎？');
  });

  test('譯文句尾非句號（？！）→ 不動；標記殼（⟦/0⟧）不擋對齊', () => {
    expect(alignTrailingPeriodWithSource('「まさか」', '「不會吧！」')).toBe('「不會吧！」');
    expect(alignTrailingPeriodWithSource('車の中で待っていればよかったのに',
      '⟦0⟧「你在車裡等我就好了。」⟦/0⟧'))
      .toBe('⟦0⟧「你在車裡等我就好了」⟦/0⟧');
  });

  test('標題無標點 → 譯文句號移除；空原文 no-op', () => {
    expect(alignTrailingPeriodWithSource('第一章 春', '第一章 春。')).toBe('第一章 春');
    expect(alignTrailingPeriodWithSource('', '譯文。')).toBe('譯文。');
  });
});

// ── stripPlaceholderTokens 對畸形標記不留碎片 ─────────────────
test.describe('stripPlaceholderTokens（畸形標記）', () => {
  test('⟦/0» 不留「/0»」碎片', () => {
    expect(stripPlaceholderTokens('「大家，都還好嗎？」她語帶幾分客套地問。⟦0⟧⟦/0»'))
      .toBe('「大家，都還好嗎？」她語帶幾分客套地問。');
  });

  test('段尾漏閉合 ⟦/3 也清乾淨', () => {
    expect(stripPlaceholderTokens('伯父老了好多。我嚇了一跳。」⟦3⟧⟦/3'))
      .toBe('伯父老了好多。我嚇了一跳。」');
  });
});

// ── translateDocument 接收點：mangled 譯文 → raw 修復 + plain 乾淨 ──
const ZH_SRC = [
  '車から下りて雪のちらついているのに気づいた。',
  '道路縁に立って空を見上げた。',
];
const ZH_OUT_MANGLED = [
  '⟦0⟧下車時，我注意到雪花正在飄落，天色沉得像要壓下來一樣。⟦/0»',
  '⟦0⟧我站在路肩仰望天空，庄內平原籠罩在低垂的厚雲之下。⟦/0',
];

function makeDoc() {
  const blocks = ZH_SRC.map((t, i) => ({
    blockId: `b${i}`, type: 'paragraph', plainText: t, epubSerializedText: `⟦0⟧${t}⟦/0⟧`,
  }));
  return { kind: 'epub', meta: { filename: 'x.epub' }, pages: [{ pageIndex: 0, blocks }] };
}

test.describe('translateDocument 接收點修復', () => {
  test.beforeEach(() => { storedKeys = {}; });

  test('模型回畸形標記 → translationRaw 已修復、translation 無碎片', async () => {
    const doc = makeDoc();
    globalThis.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === 'LOG_USAGE') return { ok: true };
      return { result: ZH_OUT_MANGLED, usage: { inputTokens: 100, outputTokens: 60 } };
    };
    const summary = await translateDocument(doc, { engine: 'gemini' });
    const blocks = doc.pages[0].blocks;
    expect(summary.failedBlocks).toBe(0);
    // raw 修復：閉合完好、無 » 壞標記（epub-writer 反序列化才救得回 inline 元素）
    expect(blocks[0].translationRaw).toBe('⟦0⟧下車時，我注意到雪花正在飄落，天色沉得像要壓下來一樣。⟦/0⟧');
    expect(blocks[1].translationRaw).toBe('⟦0⟧我站在路肩仰望天空，庄內平原籠罩在低垂的厚雲之下。⟦/0⟧');
    // plain 乾淨：無「/0»」碎片、無括號殘留
    for (const b of blocks) {
      expect(b.translation).not.toMatch(/\/?\d+»/);
      expect(b.translation).not.toMatch(/[⟦⟧]/);
    }
  });
});

// ── hydrateSessionBlocks：舊 session（壞 raw + 削壞的 plain）自癒 ──
// hydrate 走 epubDoc.chapters（不是 translateDocument 的 pages 形狀）
function makeChapterDoc() {
  const blocks = ZH_SRC.map((t, i) => ({
    blockId: `b${i}`, type: 'paragraph', plainText: t, epubSerializedText: `⟦0⟧${t}⟦/0⟧`,
  }));
  return { kind: 'epub', chapters: [{ index: 0, title: 'c1', blocks }] };
}

test.describe('hydrateSessionBlocks 自癒', () => {
  test('session raw 帶 ⟦/0»、plain 帶 /0» 殘骸 → 還原後兩者皆乾淨', () => {
    const doc = makeChapterDoc();
    const restored = hydrateSessionBlocks(doc, {
      b0: {
        raw: '⟦0⟧優子只是微微點頭回應。接著她垂下眼眸。⟦/0»',
        plain: '優子只是微微點頭回應。接著她垂下眼眸。/0»', // 舊版 strip 削過的殘骸
        edited: null,
      },
    });
    expect(restored).toBe(1);
    const b = doc.chapters[0].blocks[0];
    expect(b.translationRaw).toBe('⟦0⟧優子只是微微點頭回應。接著她垂下眼眸。⟦/0⟧');
    expect(b.translation).toBe('優子只是微微點頭回應。接著她垂下眼眸。');
    expect(b.translationStatus).toBe('done');
  });

  test('editedHtml 優先：translation 從 edited 導出,不被 raw 舊值蓋回（2026-07-11 京浜急行回歸）', () => {
    // 情境:使用者已用搜尋替換把 浜→濱(存進 editedHtml),重開書 hydrate。
    // 第一版自癒從 raw 重算 translation → 舊值 浜 蓋回 → 掃描再列違規、
    // 搜尋替換搜 edited DOM(濱)找不到 浜。修法:edited 存在時從 edited 導出
    const doc = {
      kind: 'epub',
      chapters: [{
        index: 0, title: 'c1',
        blocks: [{ blockId: 'b0', type: 'paragraph', plainText: '国電と京浜急行を乗り継ぎ、金沢八景駅で降りた。', epubSerializedText: '⟦0⟧国電と京浜急行を乗り継ぎ⟦/0⟧' }],
      }],
    };
    hydrateSessionBlocks(doc, {
      b0: {
        raw: '⟦0⟧轉乘國電和京浜急行，在金澤八景車站下車。⟦/0⟧',
        plain: '轉乘國電和京浜急行，在金澤八景車站下車。', // 被前版蓋壞的 stale plain
        edited: '<span class="kobospan">轉乘國電和京濱急行，在金澤八景車站下車。</span>',
      },
    });
    const b = doc.chapters[0].blocks[0];
    expect(b.translation).toContain('京濱急行');
    expect(b.translation).not.toContain('京浜急行');
    expect(b.editedHtml).toContain('京濱急行');
    // raw 維持原譯不動（重翻對照 / 非編輯用途）
    expect(b.translationRaw).toContain('京浜急行');
  });

  test('hydrate 也做句尾句號對齊（block.plainText = 原文）', () => {
    const doc = {
      kind: 'epub',
      chapters: [{
        index: 0, title: 'c1',
        blocks: [{ blockId: 'b0', type: 'paragraph', plainText: '「大学二年のとき」', epubSerializedText: '⟦0⟧「大学二年のとき」⟦/0⟧' }],
      }],
    };
    hydrateSessionBlocks(doc, {
      b0: { raw: '⟦0⟧「大學二年級的時候。」⟦/0⟧', plain: '「大學二年級的時候。」', edited: null },
    });
    const b = doc.chapters[0].blocks[0];
    expect(b.translationRaw).toBe('⟦0⟧「大學二年級的時候」⟦/0⟧');
    expect(b.translation).toBe('「大學二年級的時候」');
  });

  test('正常 session（完好 raw / plain）→ no-op 等價', () => {
    const doc = makeChapterDoc();
    hydrateSessionBlocks(doc, {
      b0: { raw: '⟦0⟧下車時，我注意到雪花正在飄落。⟦/0⟧', plain: '下車時，我注意到雪花正在飄落。', edited: null },
    });
    const b = doc.chapters[0].blocks[0];
    expect(b.translationRaw).toBe('⟦0⟧下車時，我注意到雪花正在飄落。⟦/0⟧');
    expect(b.translation).toBe('下車時，我注意到雪花正在飄落。');
  });
});
