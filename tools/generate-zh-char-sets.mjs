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

// ─── 準特徵字 tier(邊緣歧義字收復)──────────────────────
// 「本周看什么」的字全是共用字 → 字級零命中誤判 zh-Hant 跳過。其中「么」被
// 排除的證據只有 2 筆(TWVariants 幺→么 異體、港店名 么鳳士多)——在繁體語料
// 是極邊緣字,但在簡體是高頻字(什么/怎么/这么)。判準:ST 來源鍵若在繁體側
// 語料「出現次數 ≤ QUASI_MAX」(極邊緣)仍視為簡體特徵字;台/周/后/里 這類
// 真正常用的共用字出現數十到數百次,不受影響。繁側對稱處理。
const QUASI_MAX = 3;
const tradCharCount = new Map();
for (const arr of [ST, STP, TWP, TWV]) for (const p of arr) for (const v of p.slice(1)) for (const ch of v) tradCharCount.set(ch, (tradCharCount.get(ch) || 0) + 1);
for (const p of TS) for (const ch of p[0]) tradCharCount.set(ch, (tradCharCount.get(ch) || 0) + 1);
const simpCharCount = new Map();
for (const p of TS) for (const v of p.slice(1)) for (const ch of v) simpCharCount.set(ch, (simpCharCount.get(ch) || 0) + 1);
for (const arr of [ST, STP]) for (const p of arr) for (const ch of p[0]) simpCharCount.set(ch, (simpCharCount.get(ch) || 0) + 1);

// 簡側準特徵 = 資料條件 ∩ 人工安全白名單。
// 為何必須人工把關:語料是「轉換字典的值」不是自然繁體文——吃/秘/峰/床這些
// 現代繁體日常字因少有轉換條目而語料計數低,純頻率判準會把它們誤收,
// 導致「吃飯了嗎」被誤判簡體並轉成古字形「喫飯」(繁體誤判是硬紅線)。
// 白名單收錄標準(兩條全滿足):
//   1. 該字在簡體是高頻用字(么/种/别 級),現代繁體實務幾乎不用該字形
//   2. 轉換輸出對繁體讀者無爭議(万→萬 / 广→廣;反例 吃→喫 / 秘→祕 / 唇→脣
//      是古字形正規化,不可收)
const QUASI_SIMP_ALLOW = new Set(['么', '万', '广', '厂', '种', '别', '虫', '腊', '腌']);
const quasiSimpCandidates = [...new Set(ST.map((p) => p[0]))]
  .filter((c) => c.length === 1 && !simpOnly.includes(c) && tradChars.has(c) && (tradCharCount.get(c) || 0) <= QUASI_MAX);
const quasiSimp = quasiSimpCandidates.filter((c) => QUASI_SIMP_ALLOW.has(c));
// 繁側準特徵可全推導:誤命中的方向是「多算 tradCount → 更保守不轉」,不會誤轉繁體
const quasiTrad = [...new Set(TS.map((p) => p[0]))]
  .filter((c) => c.length === 1 && !tradOnly.includes(c) && simpChars.has(c) && (simpCharCount.get(c) || 0) <= QUASI_MAX);
const simpOnlyFull = [...simpOnly, ...quasiSimp].sort().join('');
const tradOnlyFull = [...tradOnly, ...quasiTrad].sort().join('');
console.log(`quasiSimp 候選 ${quasiSimpCandidates.length} 字,白名單放行 ${quasiSimp.length} 字: ${quasiSimp.join('')}`);
console.log(`quasiSimp 候選但未放行(人工檢視後可考慮增補): ${quasiSimpCandidates.filter((c) => !QUASI_SIMP_ALLOW.has(c)).join('')}`);
console.log(`quasiTrad(+${quasiTrad.length}): ${quasiTrad.join('')}`);

// 生成前自我檢查:回報案例的 么 必須收復;繁體日常字絕不可混入;兩側集合不可相交
if (!simpOnlyFull.includes('么')) throw new Error('準特徵字 tier 漏 么,判準退化,中止生成');
for (const c of '台周后里干面斗谷吃秘峰床唇恒灶痴粽霉') {
  if (simpOnlyFull.includes(c)) throw new Error(`繁體日常/常用共用字 ${c} 誤入簡體特徵集,中止生成`);
}
for (const c of simpOnlyFull) {
  if (tradOnlyFull.includes(c)) throw new Error(`${c} 同時出現在簡繁兩側特徵集,矛盾,中止生成`);
}

const BEGIN = '// ── GENERATED:ZH-CHAR-SETS BEGIN(tools/generate-zh-char-sets.mjs,勿手改)──';
const END = '// ── GENERATED:ZH-CHAR-SETS END ──';
const block = `${BEGIN}
  // 簡體特徵字 ${simpOnly.length}+${quasiSimp.length} 字 / 繁體特徵字 ${tradOnly.length}+${quasiTrad.length} 字
  //(+N 為準特徵 tier:繁/簡對側語料出現 ≤ ${QUASI_MAX} 次的極邊緣共用字,例 么),
  // 判準見生成腳本檔頭
  const SIMPLIFIED_ONLY_CHARS = new Set(${JSON.stringify(simpOnlyFull)});
  const TRADITIONAL_ONLY_CHARS = new Set(${JSON.stringify(tradOnlyFull)});
  ${END}`;

const src = readFileSync(TARGET, 'utf8');
const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
if (!re.test(src)) {
  console.error('content-detect.js 找不到生成區塊 marker,請先手動放置 BEGIN/END 標記');
  process.exit(1);
}
writeFileSync(TARGET, src.replace(re, block), 'utf8');
console.log(`OK:simpOnly ${simpOnly.length} 字(${Buffer.byteLength(simpOnly)} bytes)/ tradOnly ${tradOnly.length} 字(${Buffer.byteLength(tradOnly)} bytes)`);
