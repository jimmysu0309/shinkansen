// Regression: detect-br-block-kana（對應 v2.0.77 修的「splitBrBlock 純假名段落
// 整段漏翻」bug——CODE-REVIEW-2026-08-03 A1）
//
// Fixture: test/regression/fixtures/br-block-kana.html
// 結構：<br><br> 分段容器,中段為純假名段落(無漢字無英數,如日文小說對白)
// Bug：splitBrBlock 的 flush 過濾用字面 regex /[A-Za-zÀ-ÿЀ-ӿ㐀-鿿0-9]/,缺假名
//      ぀-ヿ 與諺文 가-힣——v2.0.52 已把 extractInlineFragments
//      的同款 regex 換成 SK.hasSubstantiveText,splitBrBlock(v1.10.53)漏改(drift)。
//      純假名段 fragment 被丟棄,且容器已進 fragmentExtracted,無其他路徑補收。
// 修法：改用 SK.hasSubstantiveText(text)(單一資料源,content-ns.js SUBSTANTIVE_CHAR_RE)
//
// 訊號層：驅動 SK._splitBrBlock 測試 seam 驗「切分 + 過濾」邏輯本體(bug 所在層);
//        不驗 caller 的 BR_BLOCK_SPLIT_CHARS 3500 字門檻路徑(該門檻與本 bug 無關)。
//
// SANITY 紀錄（已驗證 2026-08-03）：content-detect.js splitBrBlock 的
// SK.hasSubstantiveText(text) 暫改回舊字面 regex /[A-Za-zÀ-ÿЀ-ӿ㐀-鿿0-9]/.test(text)
// → 「三段都應收進 fragments」斷言 fail(count 收到 2、假名段缺席)→ 還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'br-block-kana';

test('br-block-kana: 純假名段落應被 splitBrBlock 收進 fragments', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const raw = await evaluate(`
    JSON.stringify((() => {
      const el = document.getElementById('target');
      const frags = window.__SK._splitBrBlock(el);
      // fragment 的文字 = startNode..endNode 的 textContent 串接(同 flush 的掃描方式)
      const texts = frags.map((f) => {
        let t = '';
        let n = f.startNode;
        while (n) { t += n.textContent || ''; if (n === f.endNode) break; n = n.nextSibling; }
        return t.trim();
      });
      return { count: frags.length, texts };
    })())
  `);
  const result = JSON.parse(raw);

  expect(result.count, '三段(英/假名/英)都應收進 fragments').toBe(3);
  expect(
    result.texts.some((t) => t.includes('いえ、いいんです')),
    '純假名段落應在 fragments 內(不可被字元集過濾丟棄)',
  ).toBe(true);
  await page.close();
});
