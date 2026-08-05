// Regression: edit-link-boundary——編輯譯文模式「刪掉連結內的字後打字,新字掉到
// 連結外」bug(例:<a>貴公司</a> 刪「貴」補打字,新字沒有連結,連結被拆散)。
//
// Fixture: test/regression/fixtures/edit-link-boundary.html(+ .response.txt)
// 結構:段落內含 <a>,譯文注入後連結保留。
// Bug:Chromium contenteditable 刻意設計——游標在 <a> 邊界打字一律插在連結外;
//     使用者「刪連結內的字 → 緊接著打替換字」的替換意圖被拆散。
// 修法:lib/edit-link-repair.js(content.js 編輯模式與 translate-doc EPUB 預覽
//     共用)——beforeinput 刪除事件記下動到內文的 <a>,之後 insertText /
//     compositionend 落地的插入段若貼在該 anchor 外緊鄰邊界 → 搬回 anchor 內。
//
// 訊號層:#t1/#t2 驗「真實鍵盤 Backspace + 真實打字(key event 走 Chromium 編輯
// pipeline,含連結邊界排斥邏輯)→ 插入段被補回連結內」整條;#t3 驗負向(沒刪字
// 的邊界打字維持原生行為);#t4 走 _repair test hook 驗 IME compositionend 資料
// 路徑(Playwright 無法產生真實 composition 事件,此層不驗真實 IME 事件序)。
//
// SANITY 紀錄(已驗證 2026-08-05):把 content.js toggleEditMode 內
//   `document.addEventListener('input', editLinkRepair.onInput, true)` 註解掉 →
//   t1「打的字應補回連結內」toBe('ab公司') fail(Received: '公司',新字掉在連結
//   外——順帶證實測試環境 Chromium 的邊界排斥行為真實存在)。還原 → 全綠。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'edit-link-boundary';

// 主世界設定 caret:collapse 在指定 text node 的 offset(DOM / Selection 跨
// world 共享,照 edit-mode-paste-plain.spec.js 慣例走 page.evaluate)
async function setCaret(page, exprNode, offset) {
  await page.evaluate(({ exprNode, offset }) => {
    /* eslint-disable no-eval */
    const node = eval(exprNode);
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    el.closest('[contenteditable="true"]')?.focus();
    window.getSelection().collapse(node, offset);
  }, { exprNode, offset });
}

test('edit-link-boundary: 刪連結內的字後打字,新字補回連結內(start / end 邊界 + 負向 + IME 路徑)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#t1', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  for (const sel of ['#t1', '#t2', '#t3']) {
    await runTestInject(evaluate, sel, translation);
  }
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);
  const enter = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testToggleEditMode(true))`));
  expect(enter.editing).toBe(true);

  // ── #t1 start 邊界:刪連結第一個字「貴」→ 打 ab → 應變 <a>ab公司</a> ──
  await setCaret(page, `document.querySelector('#t1 a').firstChild`, 1);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('ab');
  const t1 = await page.evaluate(() => {
    const a = document.querySelector('#t1 a');
    return { linkText: a.textContent, href: a.getAttribute('href'), pText: document.querySelector('#t1').textContent };
  });
  expect(t1.linkText, 't1: 打的字應補回連結內').toBe('ab公司');
  expect(t1.href, 't1: href 不變').toBe('https://example.com/acme');
  expect(t1.pText, 't1: 段落整體文字正確').toBe('請聯絡ab公司洽詢');

  // ── #t2 end 邊界:刪連結最後一個字「司」→ 打 z → 應變 <a>貴公z</a> ──
  await setCaret(page, `document.querySelector('#t2 a').firstChild`, 3);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('z');
  const t2 = await page.evaluate(() => {
    const a = document.querySelector('#t2 a');
    return { linkText: a.textContent, pText: document.querySelector('#t2').textContent };
  });
  expect(t2.linkText, 't2: 打的字應補回連結尾端').toBe('貴公z');
  expect(t2.pText, 't2: 段落整體文字正確').toBe('請聯絡貴公z洽詢');

  // ── #t3 負向:沒刪字直接把 caret 放在連結 start 邊界打字 → 維持原生行為
  //(新字不進連結——單純在連結旁打字通常不想要連結,Chromium 預設是對的)──
  await setCaret(page, `document.querySelector('#t3 a').firstChild`, 0);
  await page.keyboard.type('x');
  const t3 = await page.evaluate(() => {
    const a = document.querySelector('#t3 a');
    return { linkText: a.textContent, pText: document.querySelector('#t3').textContent };
  });
  expect(t3.linkText, 't3: 沒刪字的邊界打字不應收進連結').toBe('貴公司');
  expect(t3.pText, 't3: 新字落在連結外').toBe('請聯絡x貴公司洽詢');

  // ── 復原 stack 照常運作:t1 的 Backspace(beforeinput)已快照,undo 整段還原 ──
  const bar = JSON.parse(await evaluate(`JSON.stringify(window.__shinkansen.testEditBarState())`));
  expect(bar.undoStackSize, 't1/t2/t3 各一筆快照').toBe(3);

  // ── #t4 IME 路徑:composition 提交落在連結外的資料形態,走 _repair 直驗
  //(未注入譯文的原始 DOM 即可,repair 邏輯與翻譯狀態無關)──
  const t4 = JSON.parse(await evaluate(`
    (() => {
      const repair = window.__shinkansen.testEditLinkRepair();
      const a = document.querySelector('#t4 a');
      repair._setPending(a);
      // 模擬 Chromium 把 IME 提交字串放在 anchor 前的緊鄰位置、游標停在其尾
      const t = document.createTextNode('你們');
      a.parentNode.insertBefore(t, a);
      getSelection().collapse(t, 2);
      const moved = repair._repair('你們');
      repair.reset();
      return JSON.stringify({ moved, linkText: a.textContent, outside: t.isConnected });
    })()
  `));
  expect(t4.moved, 't4: repair 應回報搬移成功').toBe(true);
  expect(t4.linkText, 't4: IME 提交字串補回連結開頭').toBe('你們Acme Corp');
  expect(t4.outside, 't4: 連結外的殘留節點應移除').toBe(false);

  await evaluate(`window.__shinkansen.testToggleEditMode(false)`);
  await page.close();
});
