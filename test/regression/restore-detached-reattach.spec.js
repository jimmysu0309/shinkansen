// Regression: restore-detached-reattach（對應「toggle 第三下頁面閃 reload、沒翻譯」bug）
//
// Fixture: test/regression/fixtures/restore-detached-reattach.html
// 結構:single / dual / nodeValue mutate 三軌各一段,還原當下段落(或其容器)已被
//       detach、還原後又被 reattach 回 DOM(SPA framework re-render 重用同一節點的通則)
// Bug:restoreInjectedDom / removeDualWrappers 對 detached 節點跳過還原(v1.8.20 起
//      「寫了對頁面零作用」的假設),marker + 譯文殘留在節點上;framework reattach 後
//      頁面出現殭屍 marker,而還原 Map 已清空 → isPageTranslated() 判 true 但無還原
//      素材 → 下一次 toggle 走 restorePage 殭屍保底 location.reload()(頁面閃一下、
//      沒翻譯,再按一次才翻)
// 修法:還原一律不看 isConnected——detached 節點照樣寫回原文 + 清 marker(真被丟棄
//       的節點多寫無害,被 reattach 的節點回來就是乾淨原文);dual 軌 removeDualWrappers
//       循 STATE.translationCache 清 document query 搆不到的 detached wrapper / attribute
//
// SANITY 紀錄(已驗證,三軌逐一破壞):
// 1. content.js restoreInjectedDom single 軌改回 `if (!el.isConnected) return;` 跳過
//    → 「single 軌:reattach 後 marker 應已清」fail(attr 收到 '1')
// 2. nodeValue 軌改回 `if (node && node.isConnected)` → 「nodeValue 軌:文字應是原文」fail
// 3. content-inject.js removeDualWrappers 的 translationCache 迴圈 `if (false && ...)` 關掉
//    → 「dual 軌:detached wrapper 應已移除」fail(收到 1)
// 4. content.js restoreInjectedDom 尾端 sweepOrphanTranslationMarkers 呼叫註解掉
//    → 「clone 殭屍:marker 應被 sweep 清掉」fail(attr 收到 '1')
// 各自還原後全綠
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('restore-detached-reattach: 還原時 detached 的節點 reattach 後不得殘留譯文 marker', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/restore-detached-reattach.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#p1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 1) 三軌注入(走真實注入路徑 / 真實 STATE 結構)
  const injected = await evaluate(`(() => {
    const p1 = document.querySelector('#p1');
    const p2 = document.querySelector('#p2');
    window.__shinkansen.testInject(p1, '敏捷的棕色狐狸跳過河岸邊懶惰的狗。');
    window.__shinkansen.testInject(p2, '第二段在整個還原週期都保持連接。');

    const d1 = document.querySelector('#d1');
    window.__shinkansen.testInjectDual(d1, '雙語段落,將與 wrapper 一起被 detach。');

    // nodeValue mutate 軌:比照 framework-managed 注入實際存進 STATE 的形態
    const nv = document.querySelector('#nv');
    const tn = nv.firstChild;
    const originalValue = tn.nodeValue;
    tn.nodeValue = 'Framework 管理的文字節點段落。';
    nv.setAttribute('data-shinkansen-nodevalue-mutated', '1');
    window.__SK.STATE.nodeValueMutateBackup.set(nv, [{ node: tn, originalValue }]);

    return {
      p1Original: window.__SK.STATE.originalHTML.has(p1),
      markerCount: document.querySelectorAll('[data-shinkansen-translated]').length,
      wrapperCount: document.querySelectorAll('shinkansen-translation').length,
    };
  })()`);
  expect(injected.p1Original, 'testInject 應記錄 originalHTML').toBe(true);
  expect(injected.markerCount).toBeGreaterThanOrEqual(2);
  expect(injected.wrapperCount).toBe(1);

  // 2a) 無主 clone 殭屍:站點 framework clone 已翻譯節點(cloneNode 連 marker attribute
  //     一起複製),此節點不在任何還原 Map 內——真實站點實測到的殭屍來源
  //     (React 站點留言區小元件,還原簿記永遠追不到)
  await evaluate(`(() => {
    const clone = document.querySelector('#p2').cloneNode(true);
    clone.id = 'p2-clone';
    document.querySelector('main').appendChild(clone);
  })()`);

  // 2b) detach:#p1(single)、#dualwrap 容器(dual 原文+wrapper 一起)、#nv(nodeValue)
  await evaluate(`(() => {
    const SK = window.__SK;
    SK.__testDetached = {
      p1: document.querySelector('#p1'),
      dualwrap: document.querySelector('#dualwrap'),
      nv: document.querySelector('#nv'),
    };
    SK.__testDetached.p1.remove();
    SK.__testDetached.dualwrap.remove();
    SK.__testDetached.nv.remove();
  })()`);

  // 3) 真實 restorePage(不是 test helper 的簡化版)
  await evaluate(`window.__shinkansen.testRestorePage()`);

  // 4) reattach(模擬 framework 把同一批節點放回 DOM)
  await evaluate(`(() => {
    const d = window.__SK.__testDetached;
    const main = document.querySelector('main');
    main.appendChild(d.p1);
    main.appendChild(d.dualwrap);
    main.appendChild(d.nv);
    delete window.__SK.__testDetached;
  })()`);

  const after = await evaluate(`(() => {
    const p1 = document.querySelector('#p1');
    const nv = document.querySelector('#nv');
    return {
      p1Attr: p1.getAttribute('data-shinkansen-translated'),
      p1Text: p1.textContent,
      p2Text: document.querySelector('#p2').textContent,
      dualWrapperCount: document.querySelectorAll('shinkansen-translation').length,
      d1Attr: document.querySelector('#d1').getAttribute('data-shinkansen-dual-source'),
      nvAttr: nv.getAttribute('data-shinkansen-nodevalue-mutated'),
      nvText: nv.textContent,
      cloneAttr: document.querySelector('#p2-clone').getAttribute('data-shinkansen-translated'),
      isPageTranslated: window.__SK.isPageTranslated(),
      originalHTMLSize: window.__SK.STATE.originalHTML.size,
    };
  })()`);

  // single 軌:reattach 後 marker 應已清、內容應是原文
  expect(after.p1Attr, 'single 軌:reattach 後 marker 應已清').toBeNull();
  expect(after.p1Text, 'single 軌:reattach 後內容應是原文').toContain('quick brown fox');
  expect(after.p2Text, 'connected 段落照常還原').toContain('second paragraph');
  // dual 軌:detached wrapper / attribute 也要清
  expect(after.dualWrapperCount, 'dual 軌:detached wrapper 應已移除').toBe(0);
  expect(after.d1Attr, 'dual 軌:dual-source attribute 應已清').toBeNull();
  // nodeValue 軌:detached text node 也要寫回原值
  expect(after.nvAttr, 'nodeValue 軌:marker 應已清').toBeNull();
  expect(after.nvText, 'nodeValue 軌:文字應是原文').toContain('Framework managed text node');
  // 無主 clone 殭屍:不在任何 Map 內,靠 sweepOrphanTranslationMarkers 清 marker
  expect(after.cloneAttr, 'clone 殭屍:marker 應被 sweep 清掉').toBeNull();
  // 殭屍態不得存在:DOM 無任何 marker(下一次 toggle 才會正確走「翻譯」而非殭屍 reload)
  expect(after.isPageTranslated, 'reattach 後 isPageTranslated 應為 false').toBe(false);
  expect(after.originalHTMLSize).toBe(0);

  await page.close();
});
