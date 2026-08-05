// Regression: spa-translated-container-late-content(批次 8 A7,code review 2026-08-03;
// 2026-08-05 重現後由 Jimmy 核可「added-subtree scoped rescan」方向施工)
//
// Bug(已實證重現):容器經翻譯注入後帶 data-shinkansen-translated,SPA 之後 append
// 進同容器的新段落被四層吃掉——
//   1. hasNewContent 過濾把 translated 容器內 mutation 整批排除 → rescan 不 arm
//   2. collectParagraphs walker 在容器層 REJECT 整棵 → 就算 rescan 也收不到
//   3. 容器在 STATE.translatedHTML 內時,guard 直接把 append 沖回 savedHTML
//   4. 注入時 applyTargetLocaleStyling 對容器蓋的 lang=target 被新內容繼承,
//      getElementLangHint 把自家標記當站點語言訊號 → isCandidateText 誤判
//      「已是 target」skip(施工中發現的第四層,spec 開發時 scoped collect 收 0 抓到)
// → 論壇型站點(bbWrapper 等)lazy-load 的新內容永不翻譯(甚至消失)。
//
// 修法(結構性通則,§8——以「純 append(無 removedNodes)進標記容器」的 mutation
// 形狀判定,不綁站點):
//   a. mutation callback 同步 refreshAncestorSavedHTML(added node) → guard baseline
//      吸收 append(rAF deferred restore 讀到的已是新 baseline,不沖掉)
//   b. added node 進 scoped 佇列 + arm rescan;rescan 以它為 root +
//      collectParagraphs(root, null, { includeRoot: true }) 補收(TreeWalker 依
//      spec 不對 root 跑 filter,includeRoot 讓「added node 本身就是段落」也進候選)
//   c. 注入自身的 innerHTML 替換 mutation 帶 removedNodes → 不進佇列;framework
//      覆寫譯文同樣帶 removal / characterData → guard 保護不受影響(零 echo 迴圈)
//   d. getElementLangHint 爬 lang 時跳過帶 data-shinkansen-translated 的祖先
//      (自家蓋的 lang 不是站點訊號;帶標記元素自身在 walker 早被 REJECT,不受影響)
//
// 訊號層界定:驗「append → 佇列 → scoped 收集 → 翻譯注入」整條真實路徑(observer /
// debounce / idle gate 全真);LLM 側 mock 訊息層。不驗真實論壇站點的 lazy-load
// 時序(結構等價)。
//
// SANITY 紀錄(已驗證,2026-08-05,三處破壞各自獨立 fail):
//   ① content-spa.js scoped enqueue 迴圈暫改 `if (true) continue`(不進佇列)→
//     「晚載段落應被補翻」fail(停在英文原文)→ 還原後 pass。
//   ② content-detect.js includeRoot 的 `_pendingRootNode` 前置暫改恆 null →
//     同斷言 fail(scoped collect 收 0)→ 還原後 pass。
//   ③ getElementLangHint 的 `_skStamped` 暫改恆 false(自家 lang 照採)→
//     同斷言 fail(isCandidateText 誤 skip)→ 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const MOCK = `
  window.__llmBatches = [];
  window.__logs = [];
  const __origLog = window.__SK.sendLog;
  window.__SK.sendLog = (lv, cat, msg, data) => { window.__logs.push(cat + '|' + msg); };
  window.__SK.safeSendMessage = async (msg) => {
    if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') return { ok: false, started: false, error: 'no streaming (test)' };
    if (msg && msg.type === 'TRANSLATE_BATCH') {
      const texts = (msg.payload && msg.payload.texts) || [];
      window.__llmBatches.push(texts.slice());
      return { ok: true, result: texts.map((t) => '譯文' + t), usage: {} };
    }
    return { ok: true };
  };
`;

test('A7: 已翻譯容器內 append 的晚載段落 → 不被 guard 沖掉 + scoped rescan 補翻', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/zh-convert-local.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content-main', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  // 先翻整頁(容器成為 translated 單元),mock 保持安裝供之後 rescan 使用
  const setup = await evaluate(`
    (async () => {
      document.body.innerHTML = '<div id="wrap"><div id="bb">First paragraph of the forum post with enough text to collect properly here.</div></div>';
      ${MOCK}
      await window.__SK.translatePage({}).catch((e) => { window.__setupErr = String(e); });
      const bb = document.getElementById('bb');
      return {
        translated: window.__SK.STATE.translated,
        bbMarked: bb.hasAttribute('data-shinkansen-translated'),
        bbText: bb.innerText.slice(0, 10),
        err: window.__setupErr || null,
      };
    })()
  `);
  expect(setup.err, 'translatePage 應成功').toBe(null);
  expect(setup.translated, '前置:頁面應標 translated').toBe(true);
  expect(setup.bbMarked, '前置:容器應帶 translated 標記(A7 場景成立)').toBe(true);
  expect(setup.bbText, '前置:容器應已注入譯文').toContain('譯文');

  // 模擬 SPA lazy-load:純 append 新段落進已翻譯容器(真實 MutationObserver 觸發)
  await evaluate(`
    (() => {
      const p = document.createElement('p');
      p.id = 'late';
      p.textContent = 'Newly appended lazy loaded forum reply that should also get translated.';
      document.getElementById('bb').appendChild(p);
    })()
  `);

  // 輪詢:guard 不得移除 #late;scoped rescan(debounce ~1s + idle gate)補翻完成
  const start = Date.now();
  let state = null;
  while (Date.now() - start < 15000) {
    state = await evaluate(`
      (() => {
        const late = document.getElementById('late');
        return {
          connected: !!(late && late.isConnected),
          text: late ? late.innerText.slice(0, 20) : null,
          containerText: document.getElementById('bb').innerText.slice(0, 10),
        };
      })()
    `);
    if (state.connected && state.text && state.text.includes('譯文')) break;
    await page.waitForTimeout(200);
  }

  expect(state.connected, '晚載段落不得被 Content Guard 沖掉(baseline 吸收 append)').toBe(true);
  expect(state.text, '晚載段落應被 scoped rescan 補翻').toContain('譯文');
  expect(state.containerText, '容器原譯文不受影響(scoped root 子樹外零重翻)').toContain('譯文');

  // 零重翻斷言:rescan 送 LLM 的批次只含晚載段落文字,不含容器已譯內容
  const batches = await evaluate(`window.__llmBatches`);
  const rescanTexts = batches.slice(1).flat().join('\\n');
  expect(rescanTexts, 'rescan 批次應含晚載段落').toContain('Newly appended lazy loaded');
  expect(rescanTexts, 'rescan 批次不得重送容器已譯內容(echo 迴圈守門)').not.toContain('譯文First paragraph');

  await page.close();
});
