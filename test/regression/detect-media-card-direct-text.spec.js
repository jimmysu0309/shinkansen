// Regression: detect-media-card-direct-text(對應 v2.0.79 修的「媒體卡片結構的直屬文字整條漏偵測」bug)
//
// Fixture: test/regression/fixtures/media-card-direct-text.html
//
// 真實症狀:簡中新聞站頂部導覽列同一排三個項目,只有中間那個轉成繁中,
//   左右兩個(帶下拉面板的)維持簡體。載體差異是「有沒有下拉面板 + icon」:
//     <li>导览标签<img arrow><div panel>…<div 圖卡>…</div></div></li>
//
// Bug:上述 LI 命中 mediaCardSkip 四條件(非 heading + 含 img + 直屬 CONTAINER 子 +
//   directTextLength < 20)→ 整顆 FILTER_SKIP。walker 往內只會抓到 panel 裡的段落,
//   LI 直屬的 text node 沒有任何路徑會撿走(leaf 補抓要求元素本身是葉節點,
//   Case A-E 都不匹配媒體卡片結構)→ 該標籤永遠不進候選,連免費簡繁轉換也吃不到。
//
// 修法(結構性通則 §8):mediaCardSkip 分支 FILTER_SKIP 之前補做 extractInlineFragments(el),
//   把 el 直屬 inline run 抽成 fragment unit,與下方 containsBlockDescendant 分支同一
//   處理模式。卡片本體仍不當 element unit → img / 子容器原地保留,clean-slate 不觸發。
//
// 斷言:
//   1. 帶直屬文字的媒體卡片 LI:直屬文字被抽成 fragment unit
//   2. 該 LI 本身不成 element unit(mediaCardSkip 本意不變,img 保住)
//   3. 對照組(直屬無文字的附件卡片 LI):不產生 fragment,行為與修法前相同
//
// SANITY 紀錄(已驗證):把 content-detect.js mediaCardSkip 分支內新增的
//   extractInlineFragments 區塊條件改成 `if (false && …)` → 斷言 1 FAIL
//   (hasDirectTextFragment=false,fragmentCount=2 全是 panel 內部的 inlineMixedFragment、
//   沒有 mediaCardDirectTextFragment;stats.mediaCardSkip 仍為 1,證明確實走這條路徑);
//   還原後兩支測試全 PASS。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'media-card-direct-text';

test('media-card-direct-text: 媒體卡片 LI 的直屬文字應被抽成 fragment,LI 本身仍不成 element', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-a', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-a');
      const li = root.querySelector('li.nav-item');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      const hasDirectTextFragment = fragments.some(f => {
        let n = f.startNode, text = '';
        while (n) { text += n.textContent || ''; if (n === f.endNode) break; n = n.nextSibling; }
        return text.includes('产品分类');
      });
      return {
        hasDirectTextFragment,
        fragmentCount: fragments.length,
        liIsElementUnit: units.some(u => u.kind === 'element' && u.el === li),
        imgCount: li.querySelectorAll('img').length,
        stats,
      };
    })()
  `);

  // 斷言 1:直屬文字被抽成 fragment(修法本體)
  expect(
    result.hasDirectTextFragment,
    `導覽標籤直屬文字應被抽成 fragment,fragmentCount=${result.fragmentCount}\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2:LI 本身仍不成 element unit(mediaCardSkip 原意:不整顆送翻,img 保住)
  expect(
    result.liIsElementUnit,
    `媒體卡片 LI 不該成為 element unit(否則 clean-slate 會清掉 img)\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(false);
  expect(result.stats.mediaCardSkip, 'mediaCardSkip 應命中(確認走的是這條路徑)').toBeGreaterThanOrEqual(1);
  expect(result.imgCount, 'LI 內 img 應完整保留').toBe(2);

  await page.close();
});

test('media-card-direct-text: 直屬無文字的附件卡片不產生 fragment(既有行為不破壞)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-b', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-b');
      const li = root.querySelector('li.attach-item');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      return {
        // LI 直屬只有空白 text node → 不該抽出任何以 LI 為 el 的 fragment
        liFragmentCount: fragments.filter(f => f.el === li).length,
        liIsElementUnit: units.some(u => u.kind === 'element' && u.el === li),
        // 內部葉節點照樣被補抓(檔名 / meta)
        innerUnitCount: units.filter(u => u.el && li.contains(u.el) && u.el !== li).length,
        fragDump: fragments.map(f => {
          let n = f.startNode, text = '';
          while (n) { text += n.textContent || ''; if (n === f.endNode) break; n = n.nextSibling; }
          return { el: f.el && (f.el.tagName + '.' + (f.el.className || '')), text: text.trim().slice(0, 30) };
        }),
        stats,
      };
    })()
  `);

  expect(
    result.liFragmentCount,
    `附件卡片 LI 直屬無文字,不該產生 fragment\nfrags: ${JSON.stringify(result.fragDump)}\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(0);
  expect(result.liIsElementUnit, '附件卡片 LI 仍不該成為 element unit').toBe(false);
  expect(
    result.innerUnitCount,
    `附件卡片內部文字仍應被補抓,實際 ${result.innerUnitCount}\nstats: ${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
