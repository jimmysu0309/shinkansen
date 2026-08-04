#!/usr/bin/env node
// tools/translate-i18n-dict.js — P2 i18n build script
//
// 從 shinkansen/lib/i18n.js 的 ZH_TW_DICT_START / ZH_TW_DICT_END marker 抓出
// zh-TW source-of-truth dict,呼叫 Gemini API 翻成 zh-CN 跟 en 兩種,寫回
// ZH_CN_DICT 與 EN_DICT 對應 marker 之間。
//
// 用法:
//   node tools/translate-i18n-dict.js              # 翻譯兩個 target
//   node tools/translate-i18n-dict.js --only zh-CN # 只翻 zh-CN
//   node tools/translate-i18n-dict.js --only en
//   node tools/translate-i18n-dict.js --dry-run    # 不寫回,只印譯文
//
// API key 來源:~/.shinkansen-test-key(40 chars,chmod 600,不進 repo)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const I18N_PATH = path.join(__dirname, '..', 'shinkansen', 'lib', 'i18n.js');
const KEY_PATH = path.join(os.homedir(), '.shinkansen-test-key');
const MODEL = 'gemini-3-flash-preview';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = (() => {
  const idx = args.indexOf('--only');
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return null;
})();

function readApiKey() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`API key 檔不存在:${KEY_PATH}`);
    console.error('請建立檔案並貼入 Gemini API key(40 chars,chmod 600)');
    process.exit(1);
  }
  return fs.readFileSync(KEY_PATH, 'utf-8').trim();
}

function readI18nFile() {
  return fs.readFileSync(I18N_PATH, 'utf-8');
}
function writeI18nFile(content) {
  fs.writeFileSync(I18N_PATH, content, 'utf-8');
}

function extractDictBlock(content, startMarker, endMarker) {
  const si = content.indexOf(startMarker);
  const ei = content.indexOf(endMarker);
  if (si < 0 || ei < 0) {
    throw new Error(`Markers not found: ${startMarker} / ${endMarker}`);
  }
  return { si, ei, block: content.slice(si, ei) };
}

function parseDictEntries(block) {
  // 抓 'key': 'value', 行(支援 escaped quote \')
  // line 形式:    'key': 'value',
  const entries = [];
  const re = /'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    entries.push({ key: m[1], value: m[2] });
  }
  return entries;
}

const TW_TO_CN_MAP = `\
台灣 → 中國軟體用語對映(務必依此對映,避免送出台灣詞):
資料夾→文件夾, 軟體→軟件, 影片→視頻, 滑鼠→鼠標, 網路→網絡, 介面→界面,
快速鍵→快捷鍵, 程式→程序, 預設→默認, 解析度→分辨率, 列印→打印,
位元組→字節, 首選→默認, 設定→设置(只在 settings/options UI 段;但保留繁體不用
那麼瑣碎,主要詞才換),記憶體→内存, 硬碟→硬盤, 傳輸→传输,
檔案→文件(若繁中原文是「文件 = 物件 document」就保留;但「檔案 = file」要換成「文件」),
連結→链接, 螢幕→屏幕, 印表機→打印机, 電腦→电脑, 影像→图像,
網誌→博客`;

function buildSystemPrompt(target) {
  if (target === 'zh-CN') {
    return `你是專業的軟件 UI 翻譯員。將下列 Chrome 擴展 UI 字符串從**台灣繁體中文**翻譯成**中國大陸地區的简体中文**。

嚴格規則:
1. 輸出簡體字符,使用中國大陸軟件慣用語。${TW_TO_CN_MAP}
2. 保留所有 {placeholder} 佔位符不變(如 {count}、{version}、{cost} 等),包括佔位符內的字母順序。
3. 保留所有 HTML tag 不變(<strong>、<a>、<code>、<br>、<em> 等)、URL、和 HTML attribute(href、target、rel、class、id)。
4. 保留所有英文技術術語(API Key、Gemini、OpenRouter、Manifest V3、cache、token、tier、prompt、placeholder、Service Tier、Temperature、Top P、Top K、Tokens、CSV、JSON、Ollama、llama.cpp、Anthropic、Llama、Qwen、Grok、OpenAI、Claude、Chrome、Firefox 等)
5. 中文上下文中的標點符號**全部使用中文全角標點**(,。!?:;—、《》「」『』()),不使用半角符號。但純英文上下文(如 "Service Tier"、"Top P")保留半角空格與符號。
6. 譯文長度應接近原文(避免明顯加詞)。
7. 完整保留 emoji(🎉 📦 ⚠ ✓ ✗ 等)。
8. 只輸出 JSON 物件,key 為原 key 字串,value 為譯文。**不要輸出任何說明或 markdown 格式**。

範例輸入:
{
  "popup.action.translate": "翻譯本頁",
  "popup.cache.value": "快取:{count} 段 / {bytes}",
  "options.preset.engineGoogle": "Google Translate(免費機器翻譯)"
}
範例輸出:
{
  "popup.action.translate": "翻译本页",
  "popup.cache.value": "缓存:{count} 段 / {bytes}",
  "options.preset.engineGoogle": "Google Translate(免费机器翻译)"
}`;
  }
  if (target === 'en') {
    return `You are a professional UI translator for a Chrome extension. Translate the following UI strings from **Traditional Chinese (Taiwan conventions)** into **English**.

Strict rules:
1. Output natural, concise English suitable for software UI.
2. Preserve every {placeholder} unchanged (e.g. {count}, {version}, {cost}). Do not translate or reorder them.
3. Preserve every HTML tag (<strong>, <a>, <code>, <br>, <em>, etc.), URL, and HTML attribute (href, target, rel, class, id).
4. Preserve technical terms exactly: API Key, Gemini, OpenRouter, Manifest V3, cache, token, tier, prompt, placeholder, Service Tier, Temperature, Top P, Top K, Tokens, CSV, JSON, Ollama, llama.cpp, Anthropic, Llama, Qwen, Grok, OpenAI, Claude, Chrome, Firefox.
5. Use standard English half-width punctuation (, . ! ? : ; - " ').
6. Keep emoji unchanged (🎉 📦 ⚠ ✓ ✗ etc).
7. Keep length close to source (avoid extra words).
8. Output **only** a JSON object: key = original key, value = English translation. **Do not output any explanation or markdown.**

Example input:
{
  "popup.action.translate": "翻譯本頁",
  "popup.cache.value": "快取:{count} 段 / {bytes}"
}
Example output:
{
  "popup.action.translate": "Translate page",
  "popup.cache.value": "Cache: {count} segments / {bytes}"
}`;
  }
  throw new Error('unknown target: ' + target);
}

async function callGemini(apiKey, target, entries) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const sys = buildSystemPrompt(target);
  const inputJson = {};
  entries.forEach((e) => { inputJson[e.key] = e.value; });

  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [
      { role: 'user', parts: [{ text: JSON.stringify(inputJson, null, 2) }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 32768,
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${txt.slice(0, 500)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response: ' + JSON.stringify(data).slice(0, 500));

  // 直接 parse JSON
  let out;
  try { out = JSON.parse(text); }
  catch (e) {
    // 抽取首個 { ... }
    const mm = text.match(/\{[\s\S]*\}/);
    if (!mm) throw new Error('Non-JSON response: ' + text.slice(0, 500));
    out = JSON.parse(mm[0]);
  }
  return out;
}

function escapeForJsString(s) {
  // 將字串轉成 JS single-quoted literal 安全內容
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function buildDictBlock(varName, mapping, header) {
  const lines = [header];
  lines.push(`  const ${varName} = {`);
  for (const k of Object.keys(mapping)) {
    const v = mapping[k];
    lines.push(`    '${escapeForJsString(k)}': '${escapeForJsString(v)}',`);
  }
  lines.push('  };');
  return lines.join('\n');
}

async function buildOne(apiKey, content, target) {
  const startMarker = target === 'zh-CN' ? '// === ZH_CN_DICT_START ===' : '// === EN_DICT_START ===';
  const endMarker = target === 'zh-CN' ? '// === ZH_CN_DICT_END ===' : '// === EN_DICT_END ===';
  const varName = target === 'zh-CN' ? 'messages_zhCN' : 'messages_en';
  const headerComment = target === 'zh-CN'
    ? '  // zh-CN dict — 由 tools/translate-i18n-dict.js 從 zh-TW dict 翻譯產出。\n  // 改 zh-TW 後重跑 build script;或人工 review 後直接編輯本段'
    : '  // en dict — 由 tools/translate-i18n-dict.js 從 zh-TW dict 翻譯產出';

  const tw = extractDictBlock(content, '// === ZH_TW_DICT_START ===', '// === ZH_TW_DICT_END ===');
  const entries = parseDictEntries(tw.block);
  console.log(`[${target}] ${entries.length} entries to translate`);

  // 分批送(避免 maxOutputTokens 截斷)
  const BATCH = 15;
  const merged = {};
  const failedBatches = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const idx = Math.floor(i / BATCH) + 1;
    const total = Math.ceil(entries.length / BATCH);
    process.stdout.write(`[${target}] batch ${idx}/${total} (${batch.length} entries)... `);
    let out;
    let attempt = 0;
    const maxAttempt = 3;
    let lastErr;
    while (attempt < maxAttempt) {
      try {
        out = await callGemini(apiKey, target, batch);
        break;
      } catch (err) {
        lastErr = err;
        attempt += 1;
        if (attempt >= maxAttempt) {
          out = null;
          break;
        }
        process.stdout.write(`retry ${attempt}... `);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (out) {
      Object.assign(merged, out);
      console.log('ok');
    } else {
      failedBatches.push(idx);
      console.log(`FAIL after ${maxAttempt} retries: ${(lastErr && lastErr.message ? lastErr.message : lastErr).slice(0, 100)}`);
    }
  }
  if (failedBatches.length) {
    console.warn(`[${target}] ${failedBatches.length} batches failed:`, failedBatches);
  }

  // verify 完整覆蓋
  const missing = entries.filter(e => !(e.key in merged));
  if (missing.length) {
    console.warn(`[${target}] WARN ${missing.length} keys missing in LLM output:`, missing.map(m => m.key).slice(0, 5));
  }

  const newBlock = `${startMarker}\n${headerComment}\n${buildDictBlock(varName, merged, '').trim()}`;
  // newBlock 結尾不含 endMarker;由呼叫端 splice
  return { startMarker, endMarker, newBlock, entries: merged };
}

async function main() {
  const apiKey = readApiKey();
  let content = readI18nFile();

  const targets = only ? [only] : ['zh-CN', 'en'];
  for (const target of targets) {
    if (target !== 'zh-CN' && target !== 'en') {
      console.error('--only only accepts zh-CN or en');
      process.exit(1);
    }
    const { startMarker, endMarker, newBlock } = await buildOne(apiKey, content, target);
    if (dryRun) {
      console.log(`[${target}] DRY RUN — first 500 chars:`);
      console.log(newBlock.slice(0, 500));
      continue;
    }
    // 替換 startMarker..endMarker(不含 endMarker)
    const si = content.indexOf(startMarker);
    const ei = content.indexOf(endMarker);
    if (si < 0 || ei < 0) {
      console.error(`Markers not found in i18n.js for ${target}`);
      process.exit(1);
    }
    content = content.slice(0, si) + newBlock + '\n  ' + content.slice(ei);
  }

  if (!dryRun) {
    writeI18nFile(content);
    console.log('\n✓ i18n.js updated');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
