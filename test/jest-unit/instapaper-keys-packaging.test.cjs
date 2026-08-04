'use strict';

/**
 * issue #61（2026-08-04）：GitHub Releases 下載版連不上 Instapaper。
 *
 * 症狀：使用者連結 Instapaper 帳號時跳「Instapaper 整合尚未設定 consumer 金鑰」。
 * 商店版（CWS / AMO / MAS / iOS）正常，只有從 GitHub Releases（landing page 下載
 * 按鈕指向處）安裝的版本會壞。
 *
 * Root cause：`shinkansen/lib/instapaper-keys.js` 是 gitignored（consumer 金鑰不進
 * repo / git 歷史）。商店版由本機腳本從磁碟打包，帶得到那支檔；但 release workflow
 * 是在 CI 上從 git checkout 打包，檔案根本不存在 → background.js 的
 * `fetch(getURL('lib/instapaper-keys.js'))` 404 → 金鑰留空 → 功能停用。
 * 已對已發布的 v2.0.79 兩個 ZIP 驗屍：`lib/instapaper-keys.js` 命中 0 筆。
 *
 * 修法：`.github/workflows/release.yml` 打包前用 repo secret ＋
 * `tools/instapaper-keys.template.js` 產生該檔，並在打包後驗證三個 ZIP 都真的含它。
 *
 * 測試手法（source 斷言 forcing function）：CI 那層的驗證在 release 當下才會跑，
 * 這裡在 `npm test` 就先鎖住「模板格式 ↔ background.js 抽取 regex ↔ 三個載入點路徑
 * ↔ workflow 步驟」四者一致，避免有人改了其中一邊而另一邊沒跟上。
 *
 * 訊號層界定：驗 source 與 workflow 文字的一致性；不驗真實 CI 跑起來的結果（那層由
 * workflow 自身的 verify step 硬擋，且已在本機用 workflow 真實 run 腳本 ＋ CI 式
 * checkout 模擬過：無注入 → verify fail，有注入 → 三個 ZIP 全數命中）。
 *
 * SANITY 紀錄（已驗證，2026-08-04）：
 *   1）把 release.yml 的 Inject 步驟整段刪掉 → 「release.yml 打包前會注入」fail。
 *   2）把模板的 consumerKey 欄位改名成 consumerKeyX → 「模板產物能被 background.js
 *      的 regex 抽到」fail。
 *   3）把 background.js 的 getURL 路徑改成 'instapaper-keys.js'（去掉 lib/）→
 *      「三個載入點路徑一致」fail。
 *   還原 → 全數 pass。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const KEYS_PATH = 'lib/instapaper-keys.js';
const TEMPLATE_PATH = 'tools/instapaper-keys.template.js';

describe('Instapaper consumer 金鑰的打包路徑（issue #61）', () => {
  const template = read(TEMPLATE_PATH);
  const workflow = read('.github/workflows/release.yml');
  const bgSrc = read('shinkansen/background.js');

  test('模板只有 placeholder，不含真金鑰字面值', () => {
    expect(template).toContain('__INSTAPAPER_CONSUMER_KEY__');
    expect(template).toContain('__INSTAPAPER_CONSUMER_SECRET__');
    // 32 碼 hex = Instapaper consumer 金鑰的形狀，模板裡不該出現
    expect(template).not.toMatch(/\b[0-9a-f]{32}\b/);
  });

  test('模板產物能被 background.js 自己的 regex 抽到兩把金鑰', () => {
    // 直接把 background.js 裡的 regex 字面值抽出來用，兩邊不可能各自漂移
    const literals = [...bgSrc.matchAll(/text\.match\(\/(.+?)\/\)/g)].map((m) => new RegExp(m[1]));
    expect(literals).toHaveLength(2);

    const rendered = template
      .replace('__INSTAPAPER_CONSUMER_KEY__', 'a'.repeat(32))
      .replace('__INSTAPAPER_CONSUMER_SECRET__', 'b'.repeat(32));

    const [ck, cs] = literals.map((re) => rendered.match(re));
    expect(ck && ck[1]).toBe('a'.repeat(32));
    expect(cs && cs[1]).toBe('b'.repeat(32));
  });

  test('三個載入點都指向同一條路徑', () => {
    expect(bgSrc).toContain(`getURL('${KEYS_PATH}')`);
    expect(read('shinkansen/options/options.html')).toContain(`src="../${KEYS_PATH}"`);
    expect(read('shinkansen/popup/popup.html')).toContain(`src="../${KEYS_PATH}"`);
  });

  test('release.yml 打包前會從 secret + 模板注入金鑰檔', () => {
    expect(workflow).toMatch(/name:\s*Inject Instapaper consumer keys/);
    expect(workflow).toContain('secrets.INSTAPAPER_CONSUMER_KEY');
    expect(workflow).toContain('secrets.INSTAPAPER_CONSUMER_SECRET');
    expect(workflow).toContain(TEMPLATE_PATH);
    expect(workflow).toContain(`shinkansen/${KEYS_PATH}`);

    // 順序：注入必須排在三個打包步驟之前，否則等於沒注入
    const injectAt = workflow.indexOf('Inject Instapaper consumer keys');
    for (const step of ['Zip shinkansen folder (Chrome)', 'Build Firefox ZIP', 'Build Firefox source ZIP']) {
      expect(injectAt).toBeLessThan(workflow.indexOf(step));
    }
  });

  test('release.yml 打包後會驗證三個 ZIP 都含金鑰檔', () => {
    expect(workflow).toMatch(/name:\s*Verify packaged artifacts contain Instapaper keys/);
    const verifyAt = workflow.indexOf('Verify packaged artifacts contain Instapaper keys');
    expect(verifyAt).toBeGreaterThan(workflow.indexOf('Build Firefox source ZIP'));
    expect(verifyAt).toBeLessThan(workflow.indexOf('Create GitHub Release'));
  });

  test('金鑰檔本身仍被 .gitignore 排除（不可誤 commit 真金鑰）', () => {
    expect(read('.gitignore')).toContain(`shinkansen/${KEYS_PATH}`);
  });
});
