'use strict';

/**
 * 批次 8 D5/D6/D7/D8/D9/D10/D11(code review 2026-08-03):options / popup /
 * content-touch 的行為測(D6)與 source 鎖(其餘)。
 *
 * D6(行為):getFilteredLogs 原本把「搜尋只在 data 命中」的 UI 暫態直接寫進
 *   log entry 本體(entry._searchHitInData)——「匯出 JSON」stringify 一併帶出內部
 *   欄位。修法:改 WeakSet 存暫態,entry 不 mutate。用 brace-counting 抽函式 +
 *   假 $ / allLogs 驗證 entry 物件保持乾淨。
 *
 * source 鎖(訊號層界定——真實 UI 端到端由既有 options spec 族群 + 人工驗收覆蓋):
 *   D5:loadUsageData 的三發 sendMessage 包 try/catch(SW 未醒不再 unhandled rejection)
 *   D7:語系 refresh 收斂單一 applyUiLanguageRefresh + dedupe(不再雙鏈重複執行)
 *   D8:content-touch PULL_HOST_SETTINGS 掛 .catch
 *   D9:popup translate-btn 的 tabs.query 在 try 內(reject 時按鈕不永久 disabled)
 *   D10:popup init 對 ytSubtitle 只 get 一次
 *   D11:log detailExpand/detailCollapse key 語意對齊(展開態顯示 detailCollapse)
 *
 * SANITY 紀錄(已驗證,2026-08-05):
 *   D6:把 WeakSet 寫法改回 `entry._searchHitInData = ...` mutate → 「entry 不被
 *     mutate」case fail → 還原後 pass。
 *   D7:把 subscribe callback 改回內聯 refresh(不走 applyUiLanguageRefresh)→
 *     「subscribe 走單一函式」case fail → 還原後 pass。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

function readStripped(rel) {
  const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

const optionsSrcRaw = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/options/options.js'), 'utf-8');
const optionsCode = readStripped('../../shinkansen/options/options.js');
const popupCode = readStripped('../../shinkansen/popup/popup.js');
const touchCode = readStripped('../../shinkansen/content-touch.js');
const i18nSrcRaw = fs.readFileSync(path.resolve(__dirname, '../../shinkansen/lib/i18n.js'), 'utf-8');

// brace-counting 抽 getFilteredLogs 全文(同 options-reset-preserve-instapaper 手法)
function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

describe('批次 8 D6:log 搜尋暫態不 mutate entry(行為)', () => {
  test('搜尋只在 data 命中 → entry 本體無新欄位,匯出 stringify 乾淨', () => {
    const fnSrc = extractFunction(optionsSrcRaw, 'function getFilteredLogs()');
    expect(fnSrc).not.toBeNull();
    const weakSetDecl = 'const _searchHitInDataSet = new WeakSet();\n';
    const entry = { category: 'api', level: 'info', message: 'hello', data: { secret: 'needle-in-data' } };
    const ctx = vm.createContext({
      JSON, Object, WeakSet, String,
      allLogs: [entry],
      $: (id) => {
        if (id === 'log-category-filter') return { value: '' };
        if (id === 'log-level-filter') return { value: '' };
        if (id === 'log-search') return { value: 'needle-in-data' };
        return { value: '' };
      },
      __out: null,
    });
    vm.runInNewContext(weakSetDecl + fnSrc + '\n__out = getFilteredLogs();', ctx);
    expect(ctx.__out.length).toBe(1);
    // entry 不得長出任何 UI 暫態欄位
    expect(Object.keys(entry).sort()).toEqual(['category', 'data', 'level', 'message']);
    expect(JSON.stringify(entry)).not.toContain('_searchHitInData');
  });
});

describe('批次 8 D5/D7:options source 鎖', () => {
  test('D5:loadUsageData 三發 sendMessage 包在 try 內且有 catch 錯誤提示', () => {
    const m = optionsCode.match(/async function loadUsageData\(\) \{[\s\S]*?QUERY_USAGE_STATS[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/try \{\s*\[statsRes, chartRes, recordsRes\] = await Promise\.all/);
    expect(m[0]).toMatch(/catch \(err\) \{[\s\S]*?options\.usage\.loadFailed/);
  });

  test('D7:語系 refresh 單一函式 + dedupe;change handler 與 subscribe 都走它', () => {
    expect(optionsCode).toMatch(/function applyUiLanguageRefresh\(dictLang\)/);
    expect(optionsCode).toMatch(/if \(dictLang === _lastAppliedUiDictLang\) return;/);
    // subscribe callback 只轉呼叫
    expect(optionsCode).toMatch(/subscribeUiLanguageChange\(\(newUi[\s\S]{0,120}?applyUiLanguageRefresh\(newUi\);/);
    // change handler 走同一函式
    expect(optionsCode).toMatch(/applyUiLanguageRefresh\(window\.__SK\.i18n\.getUiLanguage\(ul\)\)/);
    // refreshExchangeRateDisplay 只在單一函式內出現一次(語系切換路徑)
    const refreshCount = (optionsCode.match(/refreshSlotDropdownLabels\(\);\s*\n\s*renderShortcutRecorders\(\);/g) || []).length;
    expect(refreshCount).toBe(1);
  });

  test('D11:log detail toggle 語意對齊(open 顯示 detailCollapse)+ dict 值對應', () => {
    expect(optionsCode).toMatch(/isOpen \? _t\('options\.log\.detailCollapse'\) : _t\('options\.log\.detailExpand'\)/);
    expect(i18nSrcRaw).toMatch(/'options\.log\.detailCollapse': '收合'/);
    expect(i18nSrcRaw).toMatch(/'options\.log\.detailExpand': '\{…\}'/);
  });
});

describe('批次 8 D8/D9/D10:popup / content-touch source 鎖', () => {
  test('D8:PULL_HOST_SETTINGS 掛 .catch', () => {
    expect(touchCode).toMatch(/safeSendMessage\(\{ type: 'PULL_HOST_SETTINGS' \}\)\.catch\(\(\) => \{\}\)/);
  });

  test('D9:translate-btn 的 tabs.query 在 try 內、catch 復原 disabled', () => {
    const m = popupCode.match(/\$\('translate-btn'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/try \{\s*const \[tab\] = await browser\.tabs\.query/);
    expect(m[0]).toMatch(/catch \(err\) \{[\s\S]*?btn\.disabled = false;/);
  });

  test('D10:popup init 的影片頁 toggle 區塊對 ytSubtitle 只 sync.get 一次', () => {
    // 只鎖 init 區塊(isYtWatch/isDriveFile 共用一次 get);其餘 change handler 的
    // 事件驅動 get 不在 D10 範疇
    const m = popupCode.match(/const isYtWatch =[\s\S]*?catch \{[^}]*\}/);
    expect(m).not.toBeNull();
    const count = (m[0].match(/storage\.sync\.get\('ytSubtitle'\)/g) || []).length;
    expect(count).toBe(1);
  });
});
