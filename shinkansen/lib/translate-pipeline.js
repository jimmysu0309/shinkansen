// translate-pipeline.js — background 三條翻譯 handler 共用的 pipeline（2026-09-12 code review 批次 6 §5.1）
//
// 原本 background.js 的 handleTranslate（Gemini 非串流）/ handleTranslateCustom（自訂 Provider）/
// handleTranslateStream（Gemini 串流）各自抄一份「settings → 固定術語表 → 禁用詞 → cache key →
// getBatch → API → 禁用詞漏網掃描 → echo 過濾 → setBatch → 計費 → 網頁路徑落地 usage-db → 合併結果」，
// P1-2（自訂 Provider 字幕 prompt 無視 targetLanguage）就是三份各改各的 drift。這裡收斂成一份：
//
//   prepareBatch        settings / payload → 術語表與禁用詞清單 → cache key suffix → 快取查詢 → 缺段清單
//   logDiscardedUsage   結果不可用但已付費的 usage（分批中途 throw / 串流取消 / mismatch 丟棄）落 usage-db
//   writeBatchCache     echo 過濾後寫快取
//   runTranslatePipeline 非串流完整流程（prepare → API → 掃描 → 快取 → 計費 → 落地 → 合併）
//
// 串流 handler 的 API 段（SSE 增量 emit、missing-only reuse、abort tombstone）與非串流不同，
// 只共用 prepareBatch / logDiscardedUsage / writeBatchCache / computeBilling 四段，API 段留在 background。
//
// 引擎差異全部走 ctx 參數（translate 函式、pricing / cachedRate、modelLabel、keyParts、cacheTag），
// pipeline 本身不知道 Gemini 與 OpenAI-compat 的差別。依賴（cache / usageDB / debugLog / 各 helper）
// 由 background 以 createTranslatePipeline(deps) 注入——本檔不 import 任何有副作用的模組，
// Playwright unit spec 可用 stub deps 直接驅動。
//
// 等價鎖：test/regression/bg-translate-pipeline-golden.spec.js（收斂前產生的 golden，15 個情境
// 逐欄比對回傳 / request / 快取 key / usage-db 紀錄）；test/unit/translate-pipeline.spec.js（stub deps 單元）。

import { computeBilling } from './billing.js';

export function createTranslatePipeline(deps) {
  const {
    cache, usageDB, debugLog, detectForbiddenTermLeaks, filterEchoPairsForCache,
    buildFixedGlossaryEntries, preferArticleGlossaryEntries, mergeExtraForbiddenTerms,
    buildCacheKeySuffix, logWebBatchUsage,
  } = deps;

  /**
   * 前置：術語表 / 禁用詞 / cache key / 快取查詢。
   * @param {object} p
   * @param {object} p.payload  { texts, glossary?, preferArticleGlossary?, extraForbiddenTerms? }
   * @param {object} p.sender   runtime message sender（固定術語表 byDomain 比對用 tab.url）
   * @param {object} p.settings getSettings() 結果
   * @param {string} p.cacheTag '' / '_yt' / '_doc' / '_oc' …（呼叫端明確指定）
   * @param {boolean} p.applyFixedGlossary 字幕路徑預設 false（省 prompt token）
   * @param {boolean} p.applyForbiddenTerms 同上
   * @param {object} p.keyParts buildCacheKeySuffix 的引擎 / 路徑專屬欄位：
   *   { modelKeyPart, targetLanguage, temperature, temperatureDefault, docExtraPrompt, customPrompt }
   * @param {string} p.logLabel debugLog 訊息前綴（'gemini' / 'openai-compat' / 'streaming'）
   * @param {object} [p.logExtra] 併進 cache lookup log 的額外欄位（串流帶 streamId）
   */
  async function prepareBatch({ payload, sender, settings, cacheTag, applyFixedGlossary, applyForbiddenTerms, keyParts, logLabel, logExtra = {} }) {
    const texts = payload?.texts || [];
    const glossary = payload?.glossary || null;
    // 固定術語表（全域 + 當前網域）；字幕路徑（applyFixedGlossary=false）跳過讀取，省 prompt token
    let fixedGlossaryEntries = buildFixedGlossaryEntries(
      applyFixedGlossary ? settings.fixedGlossary : null,
      sender,
    );
    // preferArticleGlossary（文件翻譯路徑帶來）：跟文章術語表同 source 的 fixed entry 從 prompt 拿掉，
    // 讓 article 完全 override fixed（不靠 LLM 判斷優先級）
    fixedGlossaryEntries = preferArticleGlossaryEntries(
      fixedGlossaryEntries,
      payload?.glossary,
      payload?.preferArticleGlossary,
    );
    // 中國用語黑名單：一路傳到 adapter 注入 systemInstruction，同時進 cache key（改清單既有快取自動失效）
    const forbiddenTermsList = mergeExtraForbiddenTerms(
      (applyForbiddenTerms && Array.isArray(settings.forbiddenTerms)) ? settings.forbiddenTerms : [],
      payload?.extraForbiddenTerms,
    );
    const cacheKeySuffix = await buildCacheKeySuffix({
      cacheTag, glossary, fixedGlossaryEntries, forbiddenTermsList, ...keyParts,
    });
    const cached = await cache.getBatch(texts, cacheKeySuffix);
    // 網頁路徑術語表 key 補查：網頁翻譯的自動術語表是 fire-and-forget（翻譯前最多等 2 秒），
    // 首翻時術語表常趕不上 → 譯文存在「無術語表」key；重翻時術語表走快取瞬間就緒 → 改查
    // 「有術語表」key → 整頁 miss 重新計費（2026-11-22 Jimmy 回報，3.8 flash 實測重翻 0 命中）。
    // 有術語表但查不到的段，補查「拿掉文章術語表（固定術語表保留）」的 key，命中就沿用並回寫主 key。
    // 只限網頁路徑（'' / '_oc'）：文件路徑的術語表可由使用者編輯，不可退回無術語表的舊譯文。
    const articleGlossaryActive = Array.isArray(glossary) && glossary.length > 0;
    if (articleGlossaryActive && (cacheTag === '' || cacheTag === '_oc') && cached.some(tr => tr == null)) {
      const altSuffix = await buildCacheKeySuffix({
        cacheTag, glossary: null, fixedGlossaryEntries, forbiddenTermsList, ...keyParts,
      });
      const altIdxs = [];
      cached.forEach((tr, i) => { if (tr == null) altIdxs.push(i); });
      const altCached = await cache.getBatch(altIdxs.map(i => texts[i]), altSuffix);
      const promoteTexts = [];
      const promoteTrs = [];
      altCached.forEach((tr, k) => {
        if (tr != null) {
          cached[altIdxs[k]] = tr;
          promoteTexts.push(texts[altIdxs[k]]);
          promoteTrs.push(tr);
        }
      });
      if (promoteTexts.length) {
        await cache.setBatch(promoteTexts, promoteTrs, cacheKeySuffix);
        debugLog('info', 'cache', `${logLabel} batch cache hit via no-glossary key`, { ...logExtra, hits: promoteTexts.length });
      }
    }
    const missingIdxs = [];
    const missingTexts = [];
    cached.forEach((tr, i) => {
      if (tr == null) {
        missingIdxs.push(i);
        missingTexts.push(texts[i]);
      }
    });
    const cacheHits = texts.length - missingTexts.length;
    debugLog('info', 'cache', `${logLabel} batch cache lookup`, {
      ...logExtra, total: texts.length, hits: cacheHits, misses: missingTexts.length,
    });
    return { texts, glossary, fixedGlossaryEntries, forbiddenTermsList, cacheKeySuffix, cached, missingIdxs, missingTexts, cacheHits };
  }

  /**
   * 「結果不可用但已付費」的 usage 落 usage-db（partialFailure: true）。
   * 三種來源：分批中途 throw（adapter 把已完成 chunk 的 usage 掛在 err.usage）、串流取消 / 中途失敗、
   * 串流 hadMismatch 丟棄。content 端這些路徑都不會發 LOG_USAGE，不在這裡記就永遠漏帳（v1.10.46 批次 2-5）。
   * 記帳失敗不影響原流程（吞掉）。
   * @returns {Promise<boolean>} 是否有寫入
   */
  async function logDiscardedUsage({ sender, engine, model, usage, pricing, cachedRate, segments, cacheHits, why, logLabel, logExtra = {} }) {
    if (!usage || !(usage.inputTokens > 0 || usage.outputTokens > 0)) return false;
    try {
      const billing = computeBilling(usage, pricing, cachedRate);
      await usageDB.logTranslation({
        url: sender?.tab?.url || '',
        title: sender?.tab?.title || '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens || 0,
        billedInputTokens: billing.billedInputTokens,
        billedCostUSD: billing.billedCostUSD,
        segments: segments || 0,
        cacheHits: cacheHits || 0,
        timestamp: Date.now(),
        engine,
        model: model || 'unknown',
        // 結果丟棄、錢有花
        partialFailure: true,
      });
      debugLog('warn', 'api', `${logLabel} usage logged on discard path`, {
        ...logExtra, why, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      });
      return true;
    } catch (_) {
      return false; // 記帳失敗不影響原錯誤回報 / 原流程
    }
  }

  /**
   * echo 過濾後寫快取（v2.0.52：譯文＝原文且原文非 target 字系的段不寫，下次重試而非永遠命中壞快取）。
   * @returns {Promise<number>} 實際寫入段數
   */
  async function writeBatchCache({ missingTexts, fresh, cacheKeySuffix, targetLanguage, logLabel }) {
    const cacheable = filterEchoPairsForCache(missingTexts, fresh, targetLanguage);
    if (cacheable.skipped > 0) {
      debugLog('warn', 'cache', `${logLabel} echo translations not cached`, { skipped: cacheable.skipped });
    }
    await cache.setBatch(cacheable.texts, cacheable.translations, cacheKeySuffix);
    return cacheable.texts.length;
  }

  /**
   * 非串流完整流程。
   * @param {object} ctx prepareBatch 的參數 + 以下引擎欄位：
   * @param {string} ctx.engine usage-db engine 欄位（'gemini' / 'openai-compat'）
   * @param {string} ctx.modelLabel usage-db model 欄位
   * @param {object|null} ctx.pricing
   * @param {number} ctx.cachedRate
   * @param {(missingTexts:string[], glossary, fixedGlossaryEntries, forbiddenTermsList) => Promise<{translations:string[], usage:object, hadMismatch?:boolean}>} ctx.translate
   * @param {boolean} ctx.isWebPath 網頁路徑（cacheTag '' / '_oc'）成功批次由 background 逐批落地 usage-db（§3.6-1）；
   *   字幕 / 文件路徑維持 content 端發 LOG_USAGE
   * @param {object} [ctx.logExtra] 併進 translateBatch start / done log 的額外欄位
   */
  async function runTranslatePipeline(ctx) {
    const { sender, settings, engine, modelLabel, pricing, cachedRate, translate, isWebPath, logLabel, logExtra = {} } = ctx;
    const prep = await prepareBatch(ctx);
    const { missingTexts, missingIdxs, cached, cacheHits, cacheKeySuffix, glossary, fixedGlossaryEntries, forbiddenTermsList } = prep;

    let fresh = [];
    let batchUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let hadMismatch = false;
    if (missingTexts.length) {
      const t0 = Date.now();
      const totalChars = missingTexts.reduce((s, t) => s + (t?.length || 0), 0);
      debugLog('info', 'api', `${logLabel} translateBatch start`, { ...logExtra, texts: missingTexts.length, chars: totalChars });
      let res;
      try {
        res = await translate(missingTexts, glossary, fixedGlossaryEntries, forbiddenTermsList);
      } catch (err) {
        // 多 chunk 中途失敗：前面 chunk 已付費（adapter 把累積 usage 掛在 err.usage），記完原樣 rethrow
        await logDiscardedUsage({
          sender, engine, model: modelLabel, usage: err?.usage, pricing, cachedRate,
          segments: missingTexts.length, cacheHits, why: 'translateBatch failed mid-way', logLabel,
          logExtra: { error: err?.message },
        });
        throw err;
      }
      fresh = res.translations;
      batchUsage = res.usage;
      hadMismatch = res.hadMismatch || false;

      // 翻譯成功後掃描黑名單詞，命中時寫一條 forbidden-term-leak warn。純記錄、不修改譯文（修改交給 prompt，硬規則 §7）
      detectForbiddenTermLeaks(fresh, missingTexts, forbiddenTermsList, {
        warn: (category, message, data) => debugLog('warn', category, message, data),
      });
      const billing = computeBilling(batchUsage, pricing, cachedRate);
      debugLog('info', 'api', `${logLabel} translateBatch done`, {
        ...logExtra,
        count: missingTexts.length,
        chars: totalChars,
        elapsed: Date.now() - t0,
        inputTokens: batchUsage.inputTokens,
        outputTokens: batchUsage.outputTokens,
        cachedTokens: batchUsage.cachedTokens || 0,
        costUSD: billing.costUSD,
        tabUrl: sender?.tab?.url,
      });
      await writeBatchCache({ missingTexts, fresh, cacheKeySuffix, targetLanguage: settings.targetLanguage, logLabel });
    }

    const billing = computeBilling(batchUsage, pricing, cachedRate);
    // §3.6-1：網頁路徑成功批次逐批落地 usage-db（快取已寫、計費已算）
    const logged = isWebPath
      ? await logWebBatchUsage({
        sender, engine, model: modelLabel,
        usage: batchUsage, billedInputTokens: billing.billedInputTokens, billedCostUSD: billing.billedCostUSD,
        segments: missingTexts.length, cacheHits,
      })
      : false;

    // 合併結果（快取 + 新翻譯）按原順序回傳
    const result = cached.slice();
    missingIdxs.forEach((idx, k) => { result[idx] = fresh[k]; });
    return {
      result,
      usage: {
        // 原始（未套 implicit cache 折扣）數字，保留給 content 端算 hit% / saved%
        inputTokens: batchUsage.inputTokens,
        outputTokens: batchUsage.outputTokens,
        // provider context cache 命中的輸入 token 數；跟下面的 cacheHits（本地 tc_ 快取命中段數）是兩回事
        cachedTokens: batchUsage.cachedTokens || 0,
        costUSD: billing.costUSD,
        // 套 cache 折扣後的「實付」數字。toast 與 popup 都顯示這組
        billedInputTokens: billing.billedInputTokens,
        billedCostUSD: billing.billedCostUSD,
        cacheHits,
        // §3.6-1：本批用量已由 background 落地，content 端整頁 LOG_USAGE 不再重複計
        logged,
      },
      hadMismatch,
    };
  }

  return { prepareBatch, logDiscardedUsage, writeBatchCache, runTranslatePipeline, computeBilling };
}
