// Regression: gt-degrade-atomic-media（code review 2026-08-03 批次 4 A4 + A5——
// Google MT 序列化的 atomic media 在 degrade 模式與鏡像計數兩端的 drift）
//
// Fixture: test/regression/fixtures/gt-degrade-atomic-media.html
//
// A4：段落 paired marker >5 觸發 degrade 後，inline emoji IMG 原本被 `!degrade`
//   gate 擋在 atomic 分支外，落到尾端透明展開（IMG 無子節點）→ 從 source 流消失
//   ——v1.9.31 修過的 bug 在 degrade 模式復發。矛盾點：同檔設計理由明寫「atomic
//   標記不受 GT paired 上限影響，degrade 模式也照走」（零文字 BUTTON atomic 不 gate）。
//   修法：IMG / media-like atomic 分支拿掉 `!degrade` gate。
//
// A5：序列化端 v2.0.61 對 media-like 元素整顆 atomic（不產 paired），鏡像計數
//   countPairedInlineForGT 只跳 IMG——media-like fall through 透明展開，內部
//   GT_INLINE 殼被計進 paired 數 → count 虛高 → 真實 paired ≤5 的段落被誤判
//   degrade → 連結保留全部丟失。修法：兩端抽共用 isGtAtomicMedia 判定。
//
// SANITY 紀錄（已驗證，2026-08-04）：
//   (a) 序列化端 atomic media 分支暫加回 `!degrade &&` → case A4 fail
//       （slots 空、text 無【*N】、emoji IMG 消失）→ 還原 → pass。
//   (b) countPairedInlineForGT 暫改回 `if (child.tagName === 'IMG') continue;`
//       （media-like fall through 計數）→ case A5 fail（openMarkers 0 = 被誤判
//       degrade）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'gt-degrade-atomic-media';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

test('A4: degrade 段落（8 anchors）的 emoji IMG 仍走 atomic，不從 source 流消失', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (() => {
      const p = document.querySelector('#degrade-emoji');
      const { text, slots } = window.__SK.serializeForGoogleTranslate(p);
      return {
        text,
        openMarkers: (text.match(/【\\d+】/g) || []).length,
        atomicMarkers: (text.match(/【\\*\\d+】/g) || []).length,
        atomicImgSlots: slots.filter(s => s && s.atomic && s.node && s.node.tagName === 'IMG').length,
      };
    })()
  `);

  expect(r.openMarkers, '前置：8 anchors 應觸發 degrade（無 paired 標記）').toBe(0);
  expect(r.atomicMarkers, 'degrade 模式下 IMG 仍應產 atomic【*N】標記').toBeGreaterThanOrEqual(1);
  expect(r.atomicImgSlots, 'slots 應含 atomic IMG（emoji 不消失）').toBe(1);
  await page.close();
});

test('A5: media-like 內部 inline 殼不計入 paired 數，3 anchors 段落不被誤判 degrade', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  const r = await evaluate(`
    (() => {
      const p = document.querySelector('#media-nocount');
      const isMediaLike = window.__SK.isMediaLikeElement(p.querySelector('x-social-share'));
      const { text, slots } = window.__SK.serializeForGoogleTranslate(p);
      return {
        text,
        isMediaLike,
        openMarkers: (text.match(/【\\d+】/g) || []).length,
        atomicMediaSlots: slots.filter(s => s && s.atomic && s.node
          && s.node.tagName === 'X-SOCIAL-SHARE').length,
        hasFirstLink: text.includes('first link'),
        hasThirdLink: text.includes('third link'),
      };
    })()
  `);

  expect(r.isMediaLike, '前置：x-social-share 應判為 media-like（無文字自訂元素）').toBe(true);
  // 核心：count 只算 3 個真實 anchor（media-like 內部 5 個 B/I 殼不計）→ 不 degrade
  expect(r.openMarkers, '3 anchors 應維持 paired 標記（不被 media-like 內部殼誤觸 degrade）').toBe(3);
  expect(r.atomicMediaSlots, 'media-like 本體應為 atomic slot').toBe(1);
  expect(r.hasFirstLink).toBe(true);
  expect(r.hasThirdLink).toBe(true);
  await page.close();
});
