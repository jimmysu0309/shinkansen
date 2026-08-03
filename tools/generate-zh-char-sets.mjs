#!/usr/bin/env node
// generate-zh-char-sets.mjs — 從 OpenCC 字典生成 content-detect.js 的簡繁特徵字集
//
// 背景:SIMPLIFIED_ONLY_CHARS / TRADITIONAL_ONLY_CHARS 原為人工 curated 清單,
// 覆蓋有限——短文(標題等)只含清單外簡體字時 simpCount=0,ratio fallback 誤判
// zh-Hant → 被「已是目標語言」跳過(實際案例:10 字新聞標題含 赛/绝/击 全漏)。
// vendor OpenCC 字典後改為完備生成,本腳本是唯一資料源,勿手改生成區塊。
//
// 判準(資料驅動,防簡繁共用字誤判):
//   簡體特徵字 = STCharacters 來源鍵 − 繁體語料字集
//   繁體特徵字 = TSCharacters 來源鍵 − 簡體語料字集
//   繁體語料字集 = ST/STPhrases/TWPhrases/TWVariants 所有轉換值字元 ∪ TS 來源鍵
//   簡體語料字集 = TS 所有轉換值字元 ∪ ST/STPhrases 來源鍵
// 「出現在繁體輸出語料的字」代表繁體文本會用(干擾的干、茶几的几、拮据的据、
// 范仲淹的范…),一律排除,避免繁體短文被誤判 zh-Hans 送去轉換造成字形損毀。
//
// 用法:node tools/generate-zh-char-sets.mjs(dict 已 vendor 在 repo,直接可跑)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DICT_DIR = join(ROOT, 'shinkansen', 'lib', 'vendor', 'opencc', 'dict');
const TARGET = join(ROOT, 'shinkansen', 'content-detect.js');

const parse = (f) => readFileSync(join(DICT_DIR, `${f}.txt`), 'utf8').split('|').map((l) => l.split(' '));
const ST = parse('STCharacters');
const TS = parse('TSCharacters');
const STP = parse('STPhrases');
const TWP = parse('TWPhrases');
const TWV = parse('TWVariants');

const tradChars = new Set();
const simpChars = new Set();
for (const arr of [ST, STP, TWP, TWV]) for (const p of arr) for (const v of p.slice(1)) for (const ch of v) tradChars.add(ch);
for (const p of TS) for (const ch of p[0]) tradChars.add(ch);
for (const p of TS) for (const v of p.slice(1)) for (const ch of v) simpChars.add(ch);
for (const arr of [ST, STP]) for (const p of arr) for (const ch of p[0]) simpChars.add(ch);

const simpOnly = [...new Set(ST.map((p) => p[0]))].filter((c) => c.length === 1 && !tradChars.has(c)).sort().join('');
const tradOnly = [...new Set(TS.map((p) => p[0]))].filter((c) => c.length === 1 && !simpChars.has(c)).sort().join('');

// 生成前自我檢查:已知簡繁共用字絕不可入集(入集 = 繁體短文會被誤判 zh-Hans 送轉換)
const AMBIGUOUS_PROBES = '干后里台丑斗面谷划据范几叶松准征余向回';
for (const c of AMBIGUOUS_PROBES) {
  if (simpOnly.includes(c) || tradOnly.includes(c)) {
    throw new Error(`歧義字 ${c} 誤入特徵字集,判準退化,中止生成`);
  }
}
// 已知純簡體高頻字必須在集內(不在 = 覆蓋倒退)
for (const c of '发们这对没说冲个国网赛绝击') {
  if (!simpOnly.includes(c)) throw new Error(`純簡體字 ${c} 未入集,覆蓋倒退,中止生成`);
}

const BEGIN = '// ── GENERATED:ZH-CHAR-SETS BEGIN(tools/generate-zh-char-sets.mjs,勿手改)──';
const END = '// ── GENERATED:ZH-CHAR-SETS END ──';
const block = `${BEGIN}
  // 簡體特徵字 ${simpOnly.length} 字 / 繁體特徵字 ${tradOnly.length} 字,判準見生成腳本檔頭
  const SIMPLIFIED_ONLY_CHARS = new Set(${JSON.stringify(simpOnly)});
  const TRADITIONAL_ONLY_CHARS = new Set(${JSON.stringify(tradOnly)});
  ${END}`;

const src = readFileSync(TARGET, 'utf8');
const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
if (!re.test(src)) {
  console.error('content-detect.js 找不到生成區塊 marker,請先手動放置 BEGIN/END 標記');
  process.exit(1);
}
writeFileSync(TARGET, src.replace(re, block), 'utf8');
console.log(`OK:simpOnly ${simpOnly.length} 字(${Buffer.byteLength(simpOnly)} bytes)/ tradOnly ${tradOnly.length} 字(${Buffer.byteLength(tradOnly)} bytes)`);
