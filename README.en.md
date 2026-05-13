**English** | [繁體中文](README.md)

# Shinkansen 🚄

A fast, privacy-first translation extension for web pages and YouTube subtitles. Supports 8 target languages and multiple AI engines (Google Gemini, Google Translate, OpenAI-compatible custom models). In-place text replacement keeps the original layout; your browsing never touches a third-party server.

The name *Shinkansen* (新幹線, "bullet train") evokes a fast, smooth, frictionless reading experience.

> [Install from Chrome Web Store](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) · [Install from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/shinkansen/) · [Download latest zip](https://github.com/jimmysu0309/shinkansen/releases/latest) · See the [project page](https://jimmysu0309.github.io/shinkansen/) for install guide and product overview · [Release notes](https://jimmysu0309.github.io/shinkansen/release-notes.en.html)

## Recent major updates

- Added **Multi-language support** — translate into 8 languages (Traditional Chinese / Simplified Chinese / English / Japanese / Korean / Spanish / French / German); the extension UI is also available in all 8 languages.
- Added **Instant Translation** — see the page start turning Chinese within 1 second of pressing translate (Gemini only).
- Added **Bilingual mode** — original text and translation shown side by side.
- Added **Custom AI models** — bring your own OpenRouter / Claude / local Ollama, etc.
- Added **AI subtitle re-segmentation** — YouTube auto-generated captions are re-segmented by AI for more natural Chinese subtitles.
- Added **Blocked-word list** — explicitly tell the AI model to avoid words you don't want appearing in the translation.
- Added **Translate opening only** — preview the first N paragraphs to save tokens.

## Why Shinkansen

Most web translation tools forward every page you read to a third-party server, putting your privacy out of your control. Shinkansen was designed privacy-first from day one: every setting and piece of data lives on your own computer; aside from your own Gemini API key talking directly to Google, nothing is forwarded to anyone else; the source is fully open, anyone can audit it.

## Performance

We stress-tested Shinkansen on the English Wikipedia article for *Taiwan* (over a thousand paragraphs): memory usage *dropped* (Chinese is more compact than English), the page stayed responsive throughout (95%+ of the time is spent waiting for the API; the browser does almost no extra work), and once translation finished the DOM was clean with no leftover artifacts. Translating the entire page with the cheapest model costs under USD $0.08; translated content is automatically cached, so re-opening the same page is free. Full numbers in [PERFORMANCE.md](docs/PERFORMANCE.md).

## Features

- **Multi-language target + multi-language UI**: translate into 8 languages — Traditional Chinese (Taiwan) / Simplified Chinese (China) / English / Japanese / Korean / Spanish / French / German. Pick in the "Target language" panel of options; all translation paths (web / PDF / YouTube subtitles) share this setting. Popup, settings page, web-translation progress toast, and PDF document reader UI are all available in all 8 UI languages — independent picker, defaults to your browser locale.
- **Instant Translation**: see the page start turning into your target language within 1 second of pressing translate — no waiting for the entire batch to come back before any text is updated (Gemini only).
- **Preserves page layout**: text is replaced in place; fonts, sizes, colors, and links are kept; bold and italics survive untouched.
- **Single-language overlay / bilingual side-by-side dual mode**: one-click switch in the popup. *Overlay* replaces text in place; *bilingual* keeps the original and appends the translation as a new paragraph. Bilingual mode offers four visual treatments (subtle background tint / left border / dotted underline / none) for the translated paragraphs.
- **Three translation engines**: Gemini (AI translation, best quality, requires API key) + Google Translate (unofficial free endpoint, no API key, faster) + Custom model — switch freely depending on what you're reading.
- **Custom AI models**: any OpenAI-compatible endpoint — OpenRouter / Together / Groq / local Ollama, hundreds of models.
- **Three customizable shortcuts**: `Alt+A` / `Alt+S` / `Alt+D` each bound to its own translation preset (engine + model + label). Pick the right engine per content type with one keystroke (e.g., Flash for reading material, Google MT for casual browsing). Details in "Translation shortcuts and presets" below.
- **YouTube subtitle translation**: detects YouTube captions and replaces them in real time with Traditional Chinese; styling matches the native YouTube subtitle look. Details in "YouTube subtitle translation" below.
- **Bilingual subtitles**: one-click toggle in the popup makes subtitles show two lines simultaneously — English on top, Chinese below. Useful for listening practice or proofreading. YouTube and Google Drive videos share the same setting. Details in "Bilingual subtitles" below.
- **YouTube AI re-segmentation** (ASR-only): YouTube auto-generated captions arrive as broken word fragments without punctuation. Shinkansen sends the whole batch to AI for semantic re-segmentation, then translates — Chinese subtitles go from "shattered words" to "complete sentences". Details in "AI smart segmentation" below.
- **Custom glossary**: pin specific terms to your preferred translations so proper nouns are always rendered consistently. Two layers (global + domain-specific) where domain rules override global. Details in "Custom glossary" below.
- **Blocked-word list**: an editable list of words you don't want in the translation. Works for any target language — write your own substitution pairs (defaults to empty for most targets; ships with 25 entries for Traditional Chinese targets). Injected as a high-prominence block at the end of the system prompt. Details in "Blocked-word list" below.
- **Translate opening only**: preview the first few paragraphs before deciding whether to translate the whole article. Saves tokens. Details in "Translate opening only" below.
- **Full-text glossary consistency** (off by default): especially useful for long articles with many proper nouns. Automatically ensures the same name or term is translated consistently throughout. Details in "Glossary consistency" below.
- **Translation cache + live cost report**: two-layer caching (local cache + Gemini implicit cache). After translation, the toast shows live cache hit rate and actual cost saved. Details in "Translation cache and cost calculation" below.
- **API quota management**: Shinkansen manages your Gemini API usage in the background, so large pages don't get cut off mid-translation by Google, and you get an early warning before hitting the daily quota — no failure surprises. For most cases, picking the right Tier is all you need.
- **Usage tracking**: every translation's token count and cost is logged, with charts and CSV export.
- **Edit translations**: after a page is translated, you can directly edit the translated text on the page — handy for cleaning up before printing PDFs or letting Readwise Reader pick it up.
- **Cross-tab translation continuity**: after triggering translation in tab A, opening a link from A in a new tab B (with Cmd-click on Mac / Ctrl-click on Windows / `target="_blank"` / `window.open`) automatically translates B with the same preset. Multi-level: B opens C, C inherits too.
- **Auto-translate specific sites**: add domains to a whitelist in settings; pages on those sites auto-translate on load (the toast displays an `[Auto]` prefix to indicate the whitelist trigger).
- **Restore original**: press the same shortcut to switch back to the original — toggle anytime.
- **Google Docs translation**: detects Google Docs and opens a translatable read-only view automatically (details below).

## Installation

**Chrome / Edge / Brave (Chromium browsers)**

Go to the [Chrome Web Store listing](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) and click "Add to Chrome".

**Firefox**

Go to the [Firefox Add-ons listing](https://addons.mozilla.org/firefox/addon/shinkansen/) and click "Add to Firefox".

> ⚠ **Firefox users**: the default shortcuts `Alt+S` / `Alt+A` / `Alt+D` are intercepted by Firefox or other extensions (Firefox uses `Alt+S` for the History menu, `Alt+D` to focus the address bar; `Alt+A` is commonly grabbed by extensions like Save Page WE). Chrome has no such conflict, but on Firefox these defaults likely won't trigger translation. Go to `about:addons` → gear icon → "Manage Extension Shortcuts" and rebind Shinkansen's three shortcuts to non-conflicting combinations (e.g., `Ctrl+Shift+S`). The "Translation shortcuts" section in settings will also display this warning when running on Firefox.

**Developer build (load unpacked)**

1. Open Chrome, go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `shinkansen/` folder in this repo
5. Shinkansen appears in the extensions list — pin it to the toolbar

## First-time setup

1. Get a Gemini API key — see the [API key setup guide](docs/API-KEY-SETUP.en.md) for step-by-step instructions
2. Click the Shinkansen icon in the toolbar → "Settings"
3. Paste your Gemini API key
4. Default model is `gemini-3-flash-preview`, Service Tier `DEFAULT`
5. Other parameters (temperature, paragraphs per batch, character budget, etc.) can be tweaked as needed

## Usage

- **Manual translation**: click the toolbar icon → "Translate this page"
- **Translation shortcuts** (three presets):
    - `Option+A` (macOS) / `Alt+A` — defaults to Gemini Flash Lite (cheapest)
    - `Option+S` / `Alt+S` — defaults to Gemini Flash (best quality / value, recommended for daily use)
    - `Option+D` / `Alt+D` — defaults to Google Translate (free, no API key)
    - All three keybindings, engines, models, and labels are customizable in the "Translation shortcuts" section of settings
    - Press any shortcut while translated → restore original
    - Press any shortcut while translating → cancel translation
- **YouTube subtitle translation**: open a video with English captions, make sure CC is on, click the toolbar icon → toggle "YouTube subtitle translation" on
- **Auto-translate sites**: add domains to the "Auto-translate sites" list in settings; pages on those sites translate on load (toast shows the `[Auto]` prefix)
- **Custom glossary**: add term mappings in the "Glossary" tab; translations are forced to use your preferred renderings
- **Glossary consistency**: enable it from the popup or settings page; long-form translations build a glossary first to keep proper nouns consistent
- **Edit translations**: after translating, click "Edit translations" in the popup to directly edit the translated text on the page

## Translation shortcuts and presets

Shinkansen offers three customizable translation presets, each bound to a shortcut:

| Shortcut | Default engine | Default model | Best for |
|----------|----------------|---------------|----------|
| `Alt+A` / `Option+A` | Gemini | Flash Lite ($0.10 / $0.30) | Casual translation, max savings |
| `Alt+S` / `Option+S` | Gemini | Flash ($0.50 / $3.00) | Daily reading, best quality / value |
| `Alt+D` / `Option+D` | Google Translate | — | No API key needed, fast, free |

**All customizable in the "Translation shortcuts" section of settings**: each preset's engine (Gemini / Google Translate), model (Flash Lite / Flash / Pro / custom), and display label can be changed. The keybindings themselves are configured at `chrome://extensions/shortcuts`.

**Unified cancel / restore behavior**:
- Press any shortcut while translating → cancel immediately
- Press any shortcut while translated → restore original (regardless of which preset did the translation)

**Cross-tab continuity**: after triggering translation in tab A, opening a link from A in a new tab B (Cmd-click on Mac / Ctrl-click on Windows, `target="_blank"`, or `window.open`) auto-translates B with the same preset — read through linked articles without pressing the shortcut on every tab. Tab B opening tab C continues the chain. Tabs opened by typing a URL / from bookmarks / from external apps don't inherit (`openerTabId` is empty). Pressing a shortcut to restore only affects the current tab; siblings in the tree are unaffected.

## Google Translate engine

Google Translate is supported as a second translation engine:

- **No API key required**: uses Google's public unofficial web endpoint (same origin as `translate.google.com`); completely free
- **Faster**: machine translation responses are typically quicker than LLM responses
- **Quality trade-off**: grammar fluency and tone are slightly behind Gemini, but sufficient for purely factual content (news, spec docs)
- **Preserves links and formatting**: `<a>`, `<b>`, `<small>`, and other semantic tags are protected via special markers; structure is fully restored after translation (no whole-page `<span>` shredding)
- **Zero cost, no Gemini quota usage**: but the unofficial endpoint has no SLA — if Google changes things, Shinkansen may need a patch

When to use it: bulk browsing of English forums, news, product pages, etc. — content where "good enough" is good enough — use Google MT to save API budget. Switch to Gemini for precision (literature, academic articles, careful proper-noun handling).

## Google Docs translation

Google Docs renders text via Canvas, so generic web translation extensions can't access the content. Shinkansen detects Google Docs and uses the following flow:

1. On a Google Docs editing page, press `Option+S` (or click "Translate this page" in the popup)
2. Shinkansen opens the same document in a new tab in "mobile reading view" (mobilebasic)
3. Once the new tab loads, translation starts automatically — no second keystroke needed

Notes: you must have view access to the document. Mobile reading view is read-only and does not affect the original document.

## YouTube subtitle translation

Open a YouTube video with English captions, make sure CC is on, click the Shinkansen toolbar icon — the popup will show a "YouTube subtitle translation" toggle. Turn it on. Captions are progressively replaced with Traditional Chinese without affecting playback; styling matches native YouTube captions exactly.

If you watch a lot of English YouTube content, enable auto-translate in the "YouTube subtitles" tab in settings — translation will start automatically whenever you open a video, no manual toggling.

### AI smart segmentation (ASR-only)

YouTube auto-generated captions (videos without human captions; CC labeled "auto-generated") are sliced **by time, not by sentence** — each caption is just 1–3 English words with no punctuation. Translating each one individually loses all semantic context, and the output reads like shredded fragments.

Shinkansen has a dedicated pipeline for ASR captions:

- **AI-driven re-segmentation**: the entire batch of ASR fragments is sent to Gemini, which re-segments by meaning (merges short fragments into full sentences, adds punctuation), then translates. Chinese subtitles go from "shattered words" to "complete sentences".
- **Default "hybrid mode"**: a fast local heuristic shows segmented captions immediately (subsecond, no waiting), while AI segmentation runs in the background and replaces them with the polished version when ready — best of both worlds.
- **Stable subtitle overlay**: Shinkansen's own overlay completely bypasses YouTube's native caption-segment rendering (which causes "word-by-word popup" behavior); whole sentences appear and disappear cleanly. Auto-shifts up to avoid the progress bar when the controls appear.
- **Toggleable**: if you only want minimum latency with YouTube's original segmentation, uncheck "AI segmentation mode" in the "YouTube subtitles" tab.

Human-uploaded captions (professional / community-contributed) are unaffected by this setting; they continue using the original sentence-by-sentence translation pipeline.

### Bilingual subtitles

Click the Shinkansen toolbar icon, toggle "Bilingual subtitles" on in the popup. Subtitles will then show both original and translation simultaneously (English on top, Chinese below). Off shows Chinese only (default).

Best for:
- **Listening practice**: glance at the original when you can't catch a word
- **Proofreading**: when translation quality is in doubt, see the English directly without switching modes
- **Language learning**: use subtitles as bilingual study material

Implementation notes:
- **YouTube and Google Drive videos share the same setting** (toggling once switches both)
- **Live toggle**: switching during playback takes effect immediately, no reload
- **Compatible with AI segmentation**: bilingual subtitles work cleanly on AI-segmented full sentences — full English sentence + full Chinese sentence on two lines

### Cost

Subtitle translation shares the same billing logic and usage tracking as web translation. Translated subtitles are automatically cached — replays or scrubbing back to already-translated regions are free. AI segmentation mode uses slightly more tokens than the off mode (one extra prompt for semantic segmentation), but the readability gain is significant; recommended on.

### Notes

- The video must have English captions (manually uploaded or auto-generated)
- Subtitle translation uses an independent system prompt, customizable in the "YouTube subtitles" tab
- If CC is off, Shinkansen turns it on for you (only once per video session, to respect manual user opt-out afterward)
- After switching videos, you'll need to toggle the switch on again (or enable auto-translate)

## Translation cache and cost calculation

Shinkansen has two layers of caching, each saving you money at a different stage:

**Layer 1: Local translation cache** — translated paragraphs are stored in `chrome.storage.local`, keyed by SHA-1 hash of the original text. Next time the same text is encountered (even on a different page), the translation is served directly — no API call, no cost. Extension version updates auto-clear the cache, ensuring new translation logic isn't polluted by old results. The cache evicts least-recently-used entries when it fills up (LRU).

**Layer 2: Gemini implicit context cache** — done server-side by Google. When consecutive requests share a common prompt prefix (e.g., system prompt + glossary), Gemini caches that prefix; cached input tokens are billed at 25% of the normal rate. No setup needed — Shinkansen automatically reads the cache hit data from API responses.

**After translation, the bottom-right toast shows two lines of metrics:**

- Line 1: `{billed tokens} tokens (XX% hit)` — billed token count, plus the Gemini implicit cache hit rate (cached input tokens as % of all input tokens)
- Line 2: `${cost} (XX% saved)` — actual amount paid, plus how much was saved relative to no-cache pricing

If every paragraph hits the local cache (e.g., re-translating a page you just translated), the toast shows "All cache hits · no charge".

Every translation's token usage, cost, and cache hit rate is logged and viewable in the "Usage" tab in settings.

## Custom glossary

In the "Glossary" tab in settings, you can pin specific source terms to your preferred translations. For example, force "Arrow" to always translate as "艾蘿" instead of "箭頭", or specifically as "乙太翠雀之箭" on DC Comics-related sites.

The glossary has two layers: "Global" applies to all sites; "Domain-specific" only applies to designated domains. When the same term appears in both, domain rules override global.

The custom glossary takes priority over auto glossary consistency. During translation, glossary instructions are placed at the very end of the system prompt — the position the LLM weights most heavily. After editing the glossary, no need to manually clear the cache; Shinkansen invalidates old entries automatically.

## Custom models (OpenAI-compatible endpoints)

In addition to Gemini and Google Translate, you can connect one OpenAI-compatible endpoint to use any model other than Gemini — for example:

- **OpenRouter** (`https://openrouter.ai/api/v1`): one endpoint, hundreds of models — Anthropic / Gemini / Llama / Qwen / Grok / xAI / Mistral, etc.
- **Together / Groq / Fireworks** and other model providers
- **Local Ollama** (`http://localhost:11434/v1`): run open-source models on your own machine — zero cost, zero latency
- **OpenAI directly** (`https://api.openai.com/v1`)

### Setup steps

1. Go to the "Custom models" tab in settings
2. Fill the three required fields:
   - **Base URL**: e.g., `https://openrouter.ai/api/v1` (Shinkansen automatically appends `/chat/completions`)
   - **Model ID**: e.g., `anthropic/claude-sonnet-4-5` (OpenRouter format is `provider/model`)
   - **API Key**: the Bearer token for that provider; click "Test" to verify connectivity instantly (~1 token cost)
3. Optional: translation prompt (leave blank = use the built-in compact default, identical to Gemini's) / temperature / model pricing input & output rates (USD per 1M tokens; 0 = don't display cost)
4. Save
5. In the "General settings" tab → "Translation shortcuts", change any preset's engine to "Custom model"
6. Triggering that preset's shortcut now routes through your custom endpoint

### Design notes

- **Independent translation prompt**: custom models use their own translation prompt, not inherited from the Gemini tab
- **Shared blocked-word list and custom glossary**: settings from those two tabs are auto-injected into the prompt end; custom models inherit them. Edit once, both engines apply.
- **Cache partitioning**: the cache key includes a base URL hash — different endpoints with the same model name don't pollute each other
- **API key not synced**: `customProvider.apiKey` lives only in your local browser — not synced across devices, not included in JSON export
- **No rate limiter**: OpenRouter and friends handle quotas themselves; 429 retry-with-backoff is built in
- **Strong segment markers** (on by default): local quantized models (e.g. gemma-4 quantized) tend to mistranslate the compact `«1» «2»` segment markers as natural language ("N1, N2") and leak them into the output. With this on, multi-segment batches use `<<<SHINKANSEN_SEG-N>>>` instead — weak models don't mistranslate it. Cost: about 7 extra tokens per segment. Commercial APIs (OpenRouter / Groq, etc.) typically don't need this, but leaving it on is harmless

### Limitations

- Only **one** custom model can be configured
- Must be genuinely OpenAI-compatible (`POST /chat/completions` + `Bearer` Authorization + standard `messages` structure + `usage.prompt_tokens` / `completion_tokens` fields). Anthropic's and Gemini's **native** APIs cannot be connected directly, but you can route them through OpenRouter
- Pricing must be entered manually; token counts depend on the provider returning a correct `usage` object in responses

### Firefox: connecting to a local server

Firefox's **HTTPS-Only Mode** (`about:preferences#privacy`, scroll to the bottom) — when enabled — forces all `http://` requests issued by extensions to be **upgraded to `https://`**, so connections to `http://localhost:11434/v1` (Ollama), `http://192.168.x.x:8081/v1` (local llama.cpp server), and similar HTTP endpoints fail outright. Chrome has no equivalent mechanism; this is Firefox-specific.

**Fix**: go to `about:preferences#privacy` → set HTTPS-Only Mode to "Don't enable", or add an exception for the URL. If the Base URL field starts with `http://`, Shinkansen detects Firefox and shows an inline warning.

## Blocked-word list

AI models occasionally produce wording you'd rather avoid in the translation — for example, when translating to British English you may want "colour" instead of "color"; when translating to European Portuguese you may want "telemóvel" instead of "celular"; or your in-house style guide may forbid certain words entirely ("utilize" should always be "use", "leverage" should always be "use", etc.). The blocked-word list lets you give the model an explicit rule per word: never use the left column; always use the right column.

The list works for any target language. Each entry has three columns — blocked word, replacement, and a free-text note (optional, useful for documenting why an entry exists). You can edit, add to, or fully replace the list in the "Blocked-word list" settings tab, or click "Restore defaults" to revert. By default the list is empty; some targets ship with prepopulated defaults curated for that language's typical AI failure modes. Switching between targets only auto-resets the list if your current entries still match the previous target's defaults — your hand-edited entries are preserved.

After every translation response, Shinkansen scans the output and logs a `forbidden-term-leak` warning in the Debug tab (with original and translation snippets) for any blocked words that slipped through — letting you investigate model leakage without **automatically rewriting the translation**, following the design principle "language preferences belong in the prompt, not in post-hoc regex replace", which avoids damaging legitimate quoted uses in the translation.

## Translate opening only

For users sensitive to token usage who want to preview before committing to a full read, the Gemini tab has a "Saving mode" section with a "Translate opening only" toggle. When enabled, only the first N paragraphs (in DOM order, default 25, range 5–50) are translated; the rest are skipped. Significantly reduces token usage.

**Progressive experience**: translate the opening → if you decide to keep reading → a "Translate remaining paragraphs" button appears in the bottom-right toast → click to run the full translation. Already-translated paragraphs hit the local cache fast path (0 tokens / ~9 ms); only the remainder hits the API. The toggle setting itself isn't modified, so the next page you open also runs in saving mode.

Off by default. Especially useful for blogs / news / Substack — most articles can be evaluated within the first 5–10 paragraphs. Less useful for sites like Wikipedia / GitHub where the DOM front-matter is nav / chrome rather than main content (you'd end up translating the navigation instead of the article).

## Glossary consistency

LLMs translating long articles tend to produce inconsistent renderings for the same name or term across paragraphs (e.g., the same person rendered as "強森" early on and "約翰森" later). With "Glossary consistency" enabled, Shinkansen first scans the full article to build a proper-noun mapping, then applies that mapping uniformly to every translation batch.

Off by default. Recommended only for articles where precision matters (e.g., long-form journalism with many names, academic articles). Side effect: the glossary translation step bypasses some system prompt instructions — for example, if you originally configured "keep English names untranslated", enabling glossary consistency forces them to be translated. Building the glossary also costs an extra API call, increasing token usage and translation time slightly.

## Gemini API rate limits reference (snapshotted 2026-04-10)

### Tier 1

| Model | RPM | TPM | RPD |
|-------|-----|-----|-----|
| Gemini 2.5 Flash Lite | 4K | 4M | unlimited |
| Gemini 2.5 Flash | 1K | 1M | 10K |
| Gemini 3.1 Flash Lite | 4K | 4M | 150K |
| Gemini 3 Flash | 1K | 2M | 10K |
| Gemini 2.5 Pro | 150 | 2M | 1K |
| Gemini 3.1 Pro | 225 | 2M | 250 |

### Tier 2

| Model | RPM | TPM | RPD |
|-------|-----|-----|-----|
| Gemini 2.5 Flash Lite | 20K | 10M | unlimited |
| Gemini 2.5 Flash | 2K | 3M | 100K |
| Gemini 3.1 Flash Lite | 10K | 10M | 350K |
| Gemini 3 Flash | 2K | 3M | 100K |
| Gemini 2.5 Pro | 1K | 5M | 50K |
| Gemini 3.1 Pro | 1K | 5M | 50K |

## Current version

v1.9.13 — full feature list and specs in [SPEC.md](SPEC.md) (Traditional Chinese only).

## License

This project is licensed under the [Elastic License 2.0 (ELv2)](LICENSE).

In plain English: you're free to view the source, learn from it, modify it, and use it yourself, but you **cannot** package Shinkansen (or any modified version) as a hosted or managed service to third parties. See the [LICENSE](LICENSE) file for the full text.

## Third-Party Notices

Shinkansen bundles the following open-source libraries and fonts. Full source,
licenses, and license file locations are listed in
[THIRD-PARTY-NOTICES.md](shinkansen/THIRD-PARTY-NOTICES.md):

- **PDF.js** (Mozilla, Apache 2.0) — PDF parsing / page rendering for the document translation feature
- **pdf-lib** (Hopding, MIT) — bilingual PDF reconstruction on download
- **fontkit** (Devon Govett / Hopding fork, MIT) — font parser used by pdf-lib for CJK subsetting
- **Noto Sans CJK TC Regular** (Google Noto, SIL OFL 1.1) — embedded Traditional Chinese font for the translated PDF
