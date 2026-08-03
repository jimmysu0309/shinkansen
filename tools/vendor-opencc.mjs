#!/usr/bin/env node
// vendor-opencc.mjs — 從 opencc-js npm 套件抽出 Shinkansen 簡繁互轉所需的最小字典集
//
// 用途:更新 lib/vendor/opencc/ 的字典資料時重跑本腳本(平常不需要跑,產物已入 repo)。
// 來源:opencc-js(MIT)dist/esm-lib/dict/*.js,字典資料上游為 OpenCC(Apache-2.0)。
//
// 產物:
//   shinkansen/lib/vendor/opencc/dict/<name>.txt — 原始 "來源 替換|來源 替換" 格式,
//     由 background 於首次轉換時 fetch lazy load(不做成 JS module 是刻意的:
//     SW 啟動不揹 1MB 字串 parse,沒用到簡繁轉換的頁面零成本)
//
// 用法:
//   node tools/vendor-opencc.mjs <path-to-extracted-opencc-js-package>
//   (先 npm pack opencc-js && tar xzf opencc-js-*.tgz)

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'shinkansen', 'lib', 'vendor', 'opencc', 'dict');

// cn↔twp 兩方向 conversion chain 需要的字典(對映 opencc-js from/cn + to/twp、
// from/twp + to/cn 的組合,見 lib/vendor/opencc/zh-convert.js 的 chain 定義)
const DICTS = [
  'STPhrases', 'STCharacters',                              // cn →(繁化)
  'TWPhrases', 'TWVariantsPhrases', 'TWVariants',           // → 台灣慣用詞 + 異體字
  'TWPhrasesRev', 'TWVariantsRevPhrases', 'TWVariantsRev',  // 台灣繁 →(還原)
  'TSPhrases', 'TSCharacters',                              // →(簡化)
];

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('用法:node tools/vendor-opencc.mjs <path-to-extracted-opencc-js-package>');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
for (const name of DICTS) {
  const modPath = pathToFileURL(resolve(pkgDir, 'dist', 'esm-lib', 'dict', `${name}.js`)).href;
  const { default: data } = await import(modPath);
  if (typeof data !== 'string' || !data.includes('|')) {
    throw new Error(`${name}: 非預期的字典格式`);
  }
  await writeFile(join(OUT_DIR, `${name}.txt`), data, 'utf8');
  console.log(`${name}.txt  ${(data.length / 1024).toFixed(1)}K`);
}
console.log(`完成 → ${OUT_DIR}`);
