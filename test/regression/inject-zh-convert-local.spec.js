// Regression: zh-convert-local(簡繁本地互轉功能的完整路徑 spec)
//
// Fixture: test/regression/fixtures/zh-convert-local.html
// 結構:簡體段(#p-simp)+ 英文段(#p-en)+ 繁體段(#p-trad)的混合頁。
// 功能:target 為 zh-TW / zh-CN 時,偵測為相反中文變體的段落走 CONVERT_ZH_LOCAL
//   (background OpenCC 字典 Trie 本地轉換,免費、不打 API、不需 API Key),
//   其餘段落照走 LLM batch;convertOnly(簡繁自動互轉 toggle 路徑)只跑本地
//   轉換組,絕不送 LLM。
//
// 本 spec 鎖的訊號層:驗「content translatePage → translateUnits 分流 →
//   CONVERT_ZH_LOCAL 訊息 → 真實 background lazy load 字典 → OpenCC 轉換 →
//   譯文注入回原 element」整條真實路徑(LLM 側 mock 訊息層,轉換側不 mock)。
//   不驗:popup toggle UI 接線(cage / 人工驗)、SPA 導航觸發點(程式同形鏡像)、
//   字典逐條對映正確性(上游 OpenCC 資料,僅錨點抽驗)。
//
// SANITY 紀錄(已驗證,2026-08-03):
//   ① 把 content.js translateUnits 分流的
//     `const wantLang = convertDirection === 'cn2twp' ? 'zh-Hans' : 'zh-Hant'`
//     暫改為 `'zh-XX'`(分流永不命中)→ case 1「#p-simp 應含 軟體」fail(收到
//     原簡體文)、case 2「LLM 不應收到簡體段」fail(mock 收到 软件 文本)。還原後全部 pass。
//   ② 把 content.js 訊息 listener 的 `SET_AUTO_CONVERT_ZH` type 比對暫改為
//     `SET_AUTO_CONVERT_ZH_SANITYBREAK`(handler 永不觸發)→ case 4「勾選 toggle 後
//     本頁應立即完成本地轉換」fail。還原後 4 case 全 pass。
//   ③ 從 content-detect.js 生成字集移除 赛/绝/击 三字(模擬人工 curated 清單時代
//     的覆蓋缺口)→ case 1「短簡體標題應被偵測並轉換(賽道)」fail(標題殘留簡體)。
//     跑 tools/generate-zh-char-sets.mjs 再生 → 全 pass。
//   ④ Case F wrapper fragment 補抓迴圈的 directTextLength 門檻暫改 9999(等同停用)
//     → case 1「meta row 巢狀 author 正文(裸 text node)應轉換」fail。還原 → pass。
//   ⑤ Case D 的 CJK-dominant 門檻減半暫改回固定 20 → case 1「獨立巢狀短 author
//     span 應轉換」fail;負向對照 detect-inline-mixed-span「Home · About」不受
//     影響照擋。還原 → 101 detect 相關 spec 全 pass。
//   ⑥ 把 'banner' 加回 content-ns.js EXCLUDE_ROLES → case 1「DIV role=banner
//     hero 卡片標題應轉換」fail(hero 整棵被硬排除)。還原 → pass。
//   ⑦ isConvertibleVariant 放寬臂門檻暫改 9999(等同只剩 detectTextLang 強訊號)
//     → case 1「中英混排標題應轉換(影片)」fail。還原 → 101 條全 pass。
//   ⑧ isConvertibleVariant CJK 下限暫改回 4 → case 1「2 字 CJK + 英文縮寫分類
//     標籤應轉換(感測)」fail(「传感/MEMS」cjk=2 被下限擋)。還原 → pass。
//   ⑨ _foreignPage 無 lang 頁的 title 推導暫改回一律 false → case 5「tag anchor
//     應轉換」fail(短 anchor 過不了 leaf-anchor 20 字門檻)。還原 → 102 條全 pass。
//   ⑩ footer / contentinfo 的相反變體放行條件暫改 if(false) → case 1「簡中 footer
//     欄目標題應轉換(欄目)」fail(footer 維持硬排除)。還原 → 102 條全 pass。
//   ⑪ _foreignPage 暫改回讀當前 document lang(不看 docLangBackup.orig)→ case 6
//     「晚載 12 字簡中卡片標題應可收集」fail(轉換後 lang 已被蓋 zh-TW,rescan
//     失去外語頁放寬)。還原 → 103 條全 pass。
//   ⑫ 從生成字集移除準特徵字 么 → case 1「全共用字標題應轉換(本週看什麼)」fail
//     (「本周看什么」simpCount 歸零誤判 zh-Hant)。跑 generate-zh-char-sets.mjs
//     再生 → 104 條全 pass。繁體安全對照(吃飯/恒生)在破壞前後都 pass。
//   ⑬ translatePage collect=0 分支的 convertOnly 靜默 gate 暫改 if(true)(一律跳
//     noContent toast)→ case 8「不得跳任何 toast」fail。還原 → pass。
//   ⑭ (2026-08-04 review A6)殭屍 marker reconcile 的 open shadow root 迴圈暫改
//     `if (false && …)`(回到只掃主 root 的舊 code)→ case 7b「shadow 內殭屍 marker
//     元素的新簡體內容應被重轉」fail(停在簡體原文)。還原 → 9 case 全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'zh-convert-local';

// mock 訊息層:只攔 LLM 批次(TRANSLATE_BATCH* 記錄呼叫 + 回 canned 譯文),
// CONVERT_ZH_LOCAL 與其他訊息直通真實 background——本地轉換走真字典真轉換
const MOCK_LLM_ONLY = `
  window.__llmCalls = [];
  const __origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = async function(msg) {
    if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
      return { ok: false, started: false, error: 'no streaming (test)' };
    }
    if (msg && msg.type === 'TRANSLATE_BATCH') {
      const texts = (msg.payload && msg.payload.texts) || [];
      window.__llmCalls.push(...texts);
      return { ok: true, result: texts.map((t) => '中文譯文' + t), usage: {} };
    }
    return __origSendMessage(msg);
  };
`;

async function waitRunDone(page, evaluate) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await evaluate(`window.__runDone === true`)) break;
    await page.waitForTimeout(100);
  }
}

async function openFixture(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

test('zh-convert case 1: convertOnly 只轉簡體段,英文段不動,零 LLM 呼叫,無 API Key', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);
  await evaluate(MOCK_LLM_ONLY);

  // 鎖「無 Key 可用」宣稱:確認測試環境確實沒有 apiKey
  const hasKey = await evaluate(`chrome.storage.local.get('apiKey').then(r => !!r.apiKey)`);
  expect(hasKey, '測試環境不應有 apiKey(無 Key 可用的前置條件)').toBe(false);

  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);

  const r = await evaluate(`({
    runDone: window.__runDone,
    translated: window.__SK.STATE.translated,
    translatedBy: window.__SK.STATE.translatedBy,
    ctxProvider: window.__SK.STATE.translationContext?.provider || null,
    sticky: window.__SK.STATE.stickyTranslate,
    simp: document.querySelector('#p-simp').innerText,
    en: document.querySelector('#p-en').innerText,
    trad: document.querySelector('#p-trad').innerText,
    llmCalls: window.__llmCalls.length,
  })`);

  expect(r.runDone, 'convertOnly run 應完成').toBe(true);
  expect(r.translated, '應標為已翻譯').toBe(true);
  expect(r.translatedBy, 'provider 應記為 opencc-local').toBe('opencc-local');
  expect(r.ctxProvider, 'translationContext 應記 opencc-local(rescan 分流依據)').toBe('opencc-local');
  expect(r.sticky, 'convertOnly 不設 sticky(免費路徑不得經 sticky replay 觸發 LLM)').toBe(false);
  // 詞組級轉換錨點:字級(头发→頭髮)+ 詞級台灣慣用(软件→軟體 / 视频→影片 / 内存→記憶體)
  expect(r.simp, '簡體段應轉為繁體(軟體)').toContain('軟體');
  expect(r.simp, '簡體段應轉為繁體(影片)').toContain('影片');
  expect(r.simp, '簡體段應轉為繁體(記憶體)').toContain('記憶體');
  expect(r.simp, '簡體段不應殘留簡體字(软件)').not.toContain('软件');
  // 短標題覆蓋(生成字集 regression):10 字標題只含舊 curated 集沒收的簡體字
  // (赛/绝/击),人工清單時代會誤判 zh-Hant 整段跳過
  const heading = await evaluate(`document.querySelector('#p-heading').innerText`);
  expect(heading, '短簡體標題應被偵測並轉換(賽道)').toContain('賽道');
  expect(heading, '短簡體標題應被偵測並轉換(絕地反擊)').toContain('絕地反擊');
  // meta row(Case F 容器)覆蓋:wrapper span 內裸 text node 的 author 正文、
  // leaf span 的分享鈕都要轉換;日期純數字不動
  const metaRow = await evaluate(`({
    author: document.querySelector('#p-author-row').innerText,
    authorAlone: document.querySelector('#p-author-alone').innerText,
    share: document.querySelector('#p-share').innerText,
    date: document.querySelector('.meta-date').innerText,
  })`);
  expect(metaRow.author, 'meta row 巢狀 author 正文(裸 text node)應轉換').toContain('環球科技網綜合報道');
  expect(metaRow.authorAlone, '獨立巢狀短 author span(Case D CJK 門檻減半)應轉換').toContain('環球科技網綜合報道');
  expect(metaRow.share, 'meta row leaf span 應轉換(海報)').toContain('海報分享');
  expect(metaRow.date, '純數字日期不得改動').toBe('2026-07-31 10:01:15');
  // ARIA banner 語意修正覆蓋:DIV 誤標 role="banner" 的 hero 內容區要轉換;
  // HEADER + role="banner" 雙訊號的正規 masthead 維持排除不轉換
  const banner = await evaluate(`({
    heroTitle: document.querySelector('#p-hero-title').innerText,
    masthead: document.querySelector('#p-masthead-label').innerText,
  })`);
  expect(banner.heroTitle, 'DIV role=banner hero 卡片標題應轉換(為什麼)').toContain('為什麼');
  expect(banner.heroTitle, 'DIV role=banner hero 卡片標題應轉換(影片)').toContain('影片');
  expect(banner.masthead, 'HEADER+role=banner 正規 masthead 維持排除(簡體不動)').toContain('网络头部选单');
  // 中英混排判定覆蓋:品牌型號壓低 cjkRatio 的標題要轉;拉丁為主夾帶中文的英文句不轉
  const mixed = await evaluate(`({
    brand: document.querySelector('#p-mixed-brand').innerText,
    latin: document.querySelector('#p-latin-incidental').innerText,
  })`);
  expect(mixed.brand, '中英混排標題應轉換(影片)').toContain('影片');
  expect(mixed.brand, '中英混排標題應轉換(運動相機)').toContain('運動相機');
  expect(mixed.latin, '拉丁為主英文句 convertOnly 不得只轉中文字(維持原文)').toContain('视频 recording');
  const shortTag = await evaluate(`document.querySelector('#p-short-tag').innerText`);
  // TWPhrases 詞組級把 传感 對映台灣術語「感測」(非字級「傳感」)
  expect(shortTag, '2 字 CJK + 英文縮寫分類標籤應轉換(感測)').toContain('感測/MEMS');
  // 準特徵字 tier 覆蓋:全共用字標題唯一訊號是 么(白名單收復),應轉換
  const quasiTitle = await evaluate(`document.querySelector('#p-quasi-title').innerText`);
  expect(quasiTitle, '全共用字標題應轉換(本週看什麼)').toContain('本週看什麼');
  // 繁體日常字安全對照:吃/秘/恒 不得被準特徵 tier 誤收(繁體段必須原樣)
  const tradDaily = await evaluate(`document.querySelector('#p-trad-daily').innerText`);
  expect(tradDaily, '繁體日常句必須原樣不動(吃飯)').toContain('吃飯了嗎');
  expect(tradDaily, '繁體日常句不得被轉成古字形(恒生)').toContain('恒生銀行');
  // 簡中 site footer 放行覆蓋:footer 內容為相反變體時不再硬排除,欄目與連結轉換
  const footer = await evaluate(`({
    col: document.querySelector('#p-footer-col').innerText,
    link1: document.querySelector('#p-footer-link1').innerText,
    link3: document.querySelector('#p-footer-link3').innerText,
  })`);
  expect(footer.col, '簡中 footer 欄目標題應轉換(欄目)').toContain('欄目');
  expect(footer.link1, '簡中 footer 連結應轉換(線索提供)').toContain('線索提供');
  expect(footer.link3, '簡中 footer 連結應轉換(關於我們)').toContain('關於我們');
  expect(r.en, 'convertOnly 模式英文段必須原文不動').toContain('must remain untouched');
  expect(r.en, '英文段不得被 LLM 譯文覆蓋').not.toContain('中文譯文');
  expect(r.trad, '繁體段不得改動').toContain('段落偵測應該直接跳過');
  expect(r.llmCalls, 'convertOnly 絕不呼叫 LLM batch').toBe(0);

  await page.close();
});

test('zh-convert case 2: 混合頁完整翻譯 → 簡體段本地轉換,英文段走 LLM,分流互不越界', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);
  await evaluate(MOCK_LLM_ONLY);

  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage()
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);

  const r = await evaluate(`({
    runDone: window.__runDone,
    translated: window.__SK.STATE.translated,
    ctxDirection: window.__SK.STATE.translationContext?.convertDirection || null,
    simp: document.querySelector('#p-simp').innerText,
    en: document.querySelector('#p-en').innerText,
    llmCalls: window.__llmCalls.slice(),
  })`);

  expect(r.runDone, '完整翻譯 run 應完成').toBe(true);
  expect(r.translated, '應標為已翻譯').toBe(true);
  expect(r.ctxDirection, 'LLM run 的 translationContext 應帶 convertDirection(rescan 延續分流)').toBe('cn2twp');
  // 簡體段:本地轉換(繁體 + 無 canned 前綴 = 沒走 LLM)
  expect(r.simp, '簡體段應本地轉換為繁體').toContain('軟體');
  expect(r.simp, '簡體段不得走 LLM(不應有 canned 前綴)').not.toContain('中文譯文');
  // 英文段:LLM 路徑(canned 前綴)
  expect(r.en, '英文段應走 LLM(canned 譯文)').toContain('中文譯文');
  // 分流純度:LLM 收到的批次不得混入簡體段
  expect(r.llmCalls.length, '英文段應送 LLM(至少 1 段)').toBeGreaterThanOrEqual(1);
  for (const t of r.llmCalls) {
    expect(t, 'LLM 不應收到簡體段(分流不可越界)').not.toContain('软件');
  }

  await page.close();
});

// popup toggle 即時生效路徑:popup change handler 對 active tab 發 SET_AUTO_CONVERT_ZH,
// 本 spec 從真實 background SW 發同一訊息(與 popup 同為擴充頁 → tabs.sendMessage,
// content 端走同一條 listener,等價路徑)
test('zh-convert case 4: SET_AUTO_CONVERT_ZH 勾選立即轉換本頁,取消還原;不動 LLM 翻譯', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });

  const sendToggle = (enabled) => worker.evaluate(async ({ urlPart, enabled }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => (t.url || '').includes(urlPart));
    if (!tab) throw new Error('fixture tab not found');
    await chrome.tabs.sendMessage(tab.id, { type: 'SET_AUTO_CONVERT_ZH', payload: { enabled } });
  }, { urlPart: `/${FIXTURE}.html`, enabled });

  const waitSimpContains = async (needle) => {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const txt = await evaluate(`document.querySelector('#p-simp').innerText`);
      if (txt.includes(needle)) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };

  // 勾選 → 本頁立即本地轉換
  await sendToggle(true);
  expect(await waitSimpContains('軟體'), '勾選 toggle 後本頁應立即完成本地轉換').toBe(true);
  const afterOn = await evaluate(`({ by: window.__SK.STATE.translatedBy, en: document.querySelector('#p-en').innerText })`);
  expect(afterOn.by, 'toggle 觸發的轉換應走 opencc-local').toBe('opencc-local');
  expect(afterOn.en, '英文段不動(免費承諾)').toContain('must remain untouched');

  // 取消 → 還原原文(僅因本頁是本地轉換結果)
  await sendToggle(false);
  expect(await waitSimpContains('软件'), '取消 toggle 後本頁應還原為簡體原文').toBe(true);
  const afterOff = await evaluate(`window.__SK.STATE.translated`);
  expect(afterOff, '還原後 translated 應為 false').toBe(false);

  // LLM 翻譯成果保護:完整翻譯(mock LLM)後取消 toggle 不得還原
  await evaluate(MOCK_LLM_ONLY);
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage()
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);
  const llmState = await evaluate(`({ translated: window.__SK.STATE.translated, by: window.__SK.STATE.translatedBy })`);
  expect(llmState.translated, '完整翻譯應成功(前置條件)').toBe(true);
  expect(llmState.by, '完整翻譯 provider 應為 gemini(前置條件)').toBe('gemini');
  await sendToggle(false);
  await page.waitForTimeout(800);
  const afterOffLlm = await evaluate(`({ translated: window.__SK.STATE.translated, en: document.querySelector('#p-en').innerText })`);
  expect(afterOffLlm.translated, '取消 toggle 不得還原 LLM 翻譯成果').toBe(true);
  expect(afterOffLlm.en, 'LLM 譯文應保留').toContain('中文譯文');

  await page.close();
});

test('zh-convert case 5: 無 html lang 宣告的簡中頁 → title 推導 foreign,短 tag anchor 可轉換', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/zh-convert-nolang.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tag-cloud', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);

  const r = await evaluate(`({
    body: document.querySelector('#p-body').innerText,
    mems: document.querySelector('#t-mems').innerText,
    consumer: document.querySelector('#t-consumer').innerText,
    iot: document.querySelector('#t-iot').innerText,
  })`);
  expect(r.body, '主體段落應轉換').toContain('這是一段');
  expect(r.mems, '2 字 CJK + 縮寫 tag anchor 應轉換(無 lang 頁 title 推導)').toContain('感測/MEMS');
  expect(r.consumer, '純 CJK 短 tag anchor 應轉換(消費電子)').toContain('消費電子');
  expect(r.iot, '純 CJK 短 tag anchor 應轉換(物聯網)').toContain('物聯網');

  await page.close();
});

test('zh-convert case 6: 轉換後 lang 被蓋 zh-TW,SPA 晚載短標題仍以原始 lang 判 foreign 可收集', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  // 先跑 convertOnly:成功後 applyDocTargetLang 把 <html lang> zh-CN → zh-TW
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);

  const r = await evaluate(`
    (() => {
      const langNow = document.documentElement.getAttribute('lang');
      const backupOrig = window.__SK.STATE.docLangBackup ? window.__SK.STATE.docLangBackup.orig : '(no-backup)';
      // 模擬 SPA 晚載內容:12 字簡中 block anchor 卡片標題(< 20 字,需 foreign 放寬)
      const host = document.createElement('div');
      host.innerHTML = '<div class="late-card"><a href="#late" style="display:block">中国智驾进欧洲考的是下限</a></div>';
      document.body.appendChild(host);
      const units = window.__SK.collectParagraphs();
      const caught = units.some(u => u.el && host.contains(u.el));
      host.remove();
      return { langNow, backupOrig, caught };
    })()
  `);

  expect(r.langNow, '轉換後 <html lang> 應已被蓋成 zh-TW(前置條件)').toBe('zh-TW');
  expect(r.backupOrig, 'docLangBackup 應記住原始 zh-CN(前置條件)').toBe('zh-CN');
  expect(r.caught, '晚載 12 字簡中卡片標題應可收集(foreign 判定看原始 lang 非當前 lang)').toBe(true);

  await page.close();
});

test('zh-convert case 7: SPA 元素重用殭屍 marker → 收集時 reconcile 重轉', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await openFixture(context, localServer);

  // 第一輪 convertOnly:p-simp 轉換完成、帶 marker
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);
  const converted = await evaluate(`document.querySelector('#p-simp').innerText`);
  expect(converted, '第一輪轉換完成(前置條件)').toContain('軟體');

  // 模擬 SPA 站內導航的 framework 元素重用:同顆元素文字換成「新文章」的簡體
  // 內容(marker 留存),STATE 被 reset 清空(resetForSpaNavigation 的效果)
  await evaluate(`
    (() => {
      const el = document.querySelector('#p-simp');
      el.textContent = '这是导航后新文章的简体内容，元素被框架重用而标记残留在上面。';
      window.__SK.STATE.translated = false;
      window.__SK.STATE.originalHTML?.clear?.();
      window.__SK.STATE.originalText?.clear?.();
      window.__SK.STATE.translatedHTML?.clear?.();
      window.__SK.STATE.nodeValueMutateBackup?.clear?.();
      return el.hasAttribute('data-shinkansen-translated') || el.hasAttribute('data-shinkansen-nodevalue-mutated');
    })()
  `).then(hasMarker => expect(hasMarker, '重用元素應仍帶殭屍 marker(前置條件)').toBe(true));

  // 第二輪 convertOnly(SPA nav 後 autoConvertZh 重新觸發的效果):
  // 殭屍 marker 應被 reconcile,新簡體內容照常轉換
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);

  const after = await evaluate(`document.querySelector('#p-simp').innerText`);
  expect(after, '殭屍 marker 元素的新簡體內容應被重轉(導航後)').toContain('導航後');
  expect(after, '不得殘留簡體(标记)').not.toContain('标记');

  await page.close();
});

test('zh-convert case 7b: open shadow root 內的殭屍 marker 也要 reconcile 重轉', async ({
  context,
  localServer,
}) => {
  // Regression(2026-08-03 code review A6):reconcile 的 root.querySelectorAll 不穿
  // shadow boundary,open shadow root 內被 framework 重用的元素殭屍 marker 永不清
  // → 內容永遠停在原文(收集本身 processScope 有進 shadow,只有 reconcile 漏掉)。
  // case 7 是主 root 版本,本 case 鎖 shadow 內同一條路徑。
  const { page, evaluate } = await openFixture(context, localServer);

  // 建 open shadow host,塞一段簡體內容
  await evaluate(`
    (() => {
      const host = document.createElement('div');
      host.id = 'sr-host';
      document.body.appendChild(host);
      const sr = host.attachShadow({ mode: 'open' });
      const p = document.createElement('p');
      p.id = 'sr-p';
      p.textContent = '这是阴影内的简体软件内容，需要被转换成繁体。';
      sr.appendChild(p);
    })()
  `);

  // 第一輪 convertOnly:shadow 內段落轉換完成、帶 marker(v1.9.13 shadow descent)
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);
  const converted = await evaluate(`document.querySelector('#sr-host').shadowRoot.querySelector('#sr-p').innerText`);
  expect(converted, '第一輪 shadow 內轉換完成(前置條件)').toContain('軟體');

  // 模擬 framework 重用 shadow 內元素:同顆元素文字換成新文章簡體,STATE 清空
  const hasMarker = await evaluate(`
    (() => {
      const el = document.querySelector('#sr-host').shadowRoot.querySelector('#sr-p');
      el.textContent = '这是导航后新文章的简体内容，阴影内元素被框架重用而标记残留。';
      window.__SK.STATE.translated = false;
      window.__SK.STATE.originalHTML?.clear?.();
      window.__SK.STATE.originalText?.clear?.();
      window.__SK.STATE.translatedHTML?.clear?.();
      window.__SK.STATE.nodeValueMutateBackup?.clear?.();
      return el.hasAttribute('data-shinkansen-translated') || el.hasAttribute('data-shinkansen-nodevalue-mutated');
    })()
  `);
  expect(hasMarker, 'shadow 內重用元素應仍帶殭屍 marker(前置條件)').toBe(true);

  // 第二輪 convertOnly:shadow 內殭屍 marker 應被 reconcile,新簡體內容照常轉換
  await evaluate(`
    window.__runDone = false;
    window.__SK.translatePage({ convertOnly: true })
      .then(() => { window.__runDone = true; })
      .catch(() => { window.__runDone = true; });
    null
  `);
  await waitRunDone(page, evaluate);

  const after = await evaluate(`document.querySelector('#sr-host').shadowRoot.querySelector('#sr-p').innerText`);
  expect(after, 'shadow 內殭屍 marker 元素的新簡體內容應被重轉(導航後)').toContain('導航後');
  expect(after, 'shadow 內不得殘留簡體(标记)').not.toContain('标记');

  await page.close();
});

test('zh-convert case 8: convertOnly 對收不到段落的頁面靜默結束(不跳 noContent toast)', async ({
  context,
  localServer,
}) => {
  // 模擬 SPA 未渲染 / 純英文空頁:開一個沒有可收集段落的頁面
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/zh-convert-local.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);

  const r = await evaluate(`
    (async () => {
      // 清空 body(模擬 React app document_idle 時還沒渲染)
      document.body.innerHTML = '<div id="root"></div>';
      let toastShown = null;
      const origShowToast = window.__SK.showToast;
      window.__SK.showToast = (kind, msg, opts) => { toastShown = { kind, msg }; return origShowToast.call(window.__SK, kind, msg, opts); };
      await window.__SK.translatePage({ convertOnly: true }).catch(() => {});
      window.__SK.showToast = origShowToast;
      return { toastShown, translated: window.__SK.STATE.translated, translating: window.__SK.STATE.translating };
    })()
  `);

  expect(r.toastShown, 'convertOnly 收不到段落不得跳任何 toast(背景行為靜默)').toBe(null);
  expect(r.translated, '不得標為已翻譯').toBe(false);
  expect(r.translating, 'run state 應正確釋放').toBe(false);

  await page.close();
});

test('zh-convert case 3: autoConvertZh 開啟 → 頁面載入自動本地轉換(免手動觸發)', async ({
  context,
  localServer,
}) => {
  // 先在一個前置頁寫入 sync 設定,再開 fixture 讓 content script 初始化路徑自己觸發
  const setup = await context.newPage();
  await setup.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate: setupEval } = await getShinkansenEvaluator(setup);
  await setupEval(`chrome.storage.sync.set({ autoConvertZh: true }); null`);
  await setup.close();

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  try {
    // 輪詢等自動轉換完成(初始化路徑 async:STICKY_QUERY → autoConvertZh 檢查 → convertOnly run)
    const start = Date.now();
    let converted = false;
    while (Date.now() - start < 15000) {
      const txt = await evaluate(`document.querySelector('#p-simp').innerText`);
      if (txt.includes('軟體')) { converted = true; break; }
      await page.waitForTimeout(100);
    }

    const r = await evaluate(`({
      translatedBy: window.__SK.STATE.translatedBy,
      en: document.querySelector('#p-en').innerText,
      trad: document.querySelector('#p-trad').innerText,
    })`);

    expect(converted, '開 autoConvertZh 後載入頁面應自動完成簡繁轉換').toBe(true);
    expect(r.translatedBy, '自動路徑 provider 應為 opencc-local(保證未走 LLM)').toBe('opencc-local');
    expect(r.en, '自動路徑英文段必須原文不動(絕不悄悄打 API)').toContain('must remain untouched');
    expect(r.trad, '繁體段不得改動').toContain('段落偵測應該直接跳過');
  } finally {
    // 清設定,不污染同 context 其他 spec
    await evaluate(`chrome.storage.sync.remove('autoConvertZh'); null`);
  }

  await page.close();
});
