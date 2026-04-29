// Version drift forcing function (從 edo-detection.spec.js 搬過來,v0.59 起)
//
// 對應 CLAUDE.md 硬規則 1 第 4 點:每次 manifest version bump 都必須同步
// 更新本檔的 EXPECTED_VERSION 常數。這條測試的「fail」就是 forcing function——
// 刻意設計成 bump 後不改就 fail,用來提醒測試期望值需要跟著更新。
//
// 為什麼不直接動態讀 manifest:那樣 forcing function 就失效了。我們要的
// 就是「測試 expectations 必須有人手動點頭」的這個摩擦。
//
// v1.5.7 起擴大涵蓋:除了 manifest / window.__shinkansen.version 外,還驗
//   - SPEC.md 標頭與「已實作」段
//   - CHANGELOG.md 頂部 v 條目
//   - README.md「目前版本」段
//   - docs/index.html GitHub 下載按鈕（URL path / filename / 副標 v 三處）
// CLAUDE.md §1「版本 bump 同步清單」7 項中,有 forcing 機制保護的從 1 項擴到 6 項
// （剩下「測試流程說明.md」是純文件、不易自動驗;Chrome Web Store 副標由 cron 自動同步,
// 不在本檔範圍）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/extension.js';
import { getShinkansenEvaluator } from './regression/helpers/run-inject.js';

const EXPECTED_VERSION = '1.8.20';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function readRepoFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ── 1. window.__shinkansen.version (透過 extension SW + content script) ──
test('manifest version drift check (runtime API)', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const apiVersion = await evaluate('window.__shinkansen.version');
  expect(
    apiVersion,
    `[DRIFT] window.__shinkansen.version (${apiVersion}) ≠ EXPECTED_VERSION (${EXPECTED_VERSION})\n` +
    `提醒:每次 bump manifest version 時必須同步更新 test/version-check.spec.js 的 EXPECTED_VERSION 常數。`,
  ).toBe(EXPECTED_VERSION);

  await page.close();
});

// ── 2. SPEC.md 兩處版本標記 ──
test('SPEC.md 同步檢查 (標頭 + 已實作標題)', async () => {
  const spec = readRepoFile('SPEC.md');
  expect(
    spec,
    `[DRIFT] SPEC.md 缺「目前 Extension 版本：${EXPECTED_VERSION}」標頭。\n` +
    `提醒:bump 時必須更新 SPEC.md 標頭。`,
  ).toContain(`目前 Extension 版本：${EXPECTED_VERSION}`);
  expect(
    spec,
    `[DRIFT] SPEC.md 缺「已實作（v${EXPECTED_VERSION} 為止）」標題。\n` +
    `提醒:bump 時必須更新 SPEC.md §2.1 章節標題。`,
  ).toContain(`已實作（v${EXPECTED_VERSION} 為止）`);
});

// ── 3. CHANGELOG.md 頂部 vX.Y.Z 條目 ──
test('CHANGELOG.md 同步檢查 (頂部新版本條目)', async () => {
  const changelog = readRepoFile('CHANGELOG.md');
  // 必須有 **vX.Y.Z** — 條目（行首為 `**v`，後接版本號）
  const pattern = new RegExp(`^\\*\\*v${EXPECTED_VERSION.replace(/\./g, '\\.')}\\*\\*`, 'm');
  expect(
    pattern.test(changelog),
    `[DRIFT] CHANGELOG.md 缺 **v${EXPECTED_VERSION}** — 條目。\n` +
    `提醒:bump 時必須在 CHANGELOG.md 頂部新增 **v${EXPECTED_VERSION}** — <說明> 條目。`,
  ).toBe(true);
});

// ── 4. README.md「目前版本」段 ──
test('README.md 同步檢查 (目前版本段)', async () => {
  const readme = readRepoFile('README.md');
  expect(
    readme,
    `[DRIFT] README.md 缺「v${EXPECTED_VERSION} — 完整功能清單」段。\n` +
    `提醒:bump 時必須更新 README.md「目前版本」段落版本號。`,
  ).toContain(`v${EXPECTED_VERSION} — 完整功能清單`);
});

// ── 5. docs/index.html GitHub 下載按鈕（URL path + filename + 副標 v）──
test('docs/index.html 同步檢查 (GitHub 下載按鈕三處版本號)', async () => {
  const html = readRepoFile('docs/index.html');
  // GitHub releases URL path 與 zip filename 都帶版本號
  const urlFragment = `releases/download/v${EXPECTED_VERSION}/shinkansen-v${EXPECTED_VERSION}.zip`;
  expect(
    html,
    `[DRIFT] docs/index.html 缺 GitHub 下載 URL「${urlFragment}」。\n` +
    `提醒:bump 時必須同步更新 docs/index.html hero btn-row 內 GitHub 下載按鈕的 path 與 filename 兩處版本號。`,
  ).toContain(urlFragment);
  // 按鈕副標
  const subtitleFragment = `>v${EXPECTED_VERSION} · beta<`;
  expect(
    html,
    `[DRIFT] docs/index.html 缺「v${EXPECTED_VERSION} · beta」副標。\n` +
    `提醒:bump 時必須更新 docs/index.html GitHub 下載按鈕內 <span class="btn-version"> 的版本號。`,
  ).toContain(subtitleFragment);
});
