**English** | [繁體中文](README.md)

# Shinkansen 🚄

A fast, privacy-first translation extension for web pages, documents and video subtitles. Supports 8 target languages and multiple AI engines (Google Gemini, Google Translate, OpenAI-compatible custom models). In-place text replacement keeps the original layout; your browsing never touches a third-party server.

The name *Shinkansen* (新幹線, "bullet train") evokes a fast, smooth, frictionless reading experience.

> [Install from Chrome Web Store](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) · [Install from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/shinkansen/) · [Install from Mac App Store](https://apps.apple.com/tw/app/shinkansen-translator/id6768586680) · [Install from App Store (iOS / iPadOS)](https://apps.apple.com/tw/app/shinkansen-web-translator/id6776958298) · [Download latest zip](https://github.com/jimmysu0309/shinkansen/releases/latest) · See the [project page](https://jimmysu0309.github.io/shinkansen/) for install guide and product overview · [Release notes](https://jimmysu0309.github.io/shinkansen/release-notes.en.html)

## Recent major updates

- **Cheaper re-translation** — translating again after restoring, content a page loads later, and author-name lists are no longer billed twice; slow models now get up to 45 seconds per batch instead of being cut off and billed for nothing.
- **Math formulas kept intact** — formulas typeset with MathML, MathJax or KaTeX on web pages (chemical formulas included) are not sent for translation; inline formulas stay in place inside the translated paragraph.
- **X (Twitter) video subtitles** — videos with auto-generated captions are translated into your target language when played with sound, styled and positioned like X's native captions; muted autoplay videos in the timeline are skipped and cost nothing.
- **PDF translation: better layout and stability** — major layout fixes for tables, tables of contents and pages that mix figures with text; files up to 50 MB / 300 pages, with an optional page range.
- **Hover translation** — hold a modifier key and rest the cursor on a paragraph to translate just that one, in place; pick the modifier and bilingual / monolingual display under "Translation shortcuts" in Settings (off by default).
- **iOS / iPadOS version** is now on the [App Store](https://apps.apple.com/tw/app/shinkansen-web-translator/id6776958298) — Safari extension with multi-finger touch translate and the floating button, ready out of the box. iPad and iPhone (in landscape) can also translate documents.

## Why Shinkansen

Most web translation tools forward every page you read to a third-party server, putting your privacy out of your control. Shinkansen was designed privacy-first from day one: settings and the translation cache stay in your browser (settings may sync with your browser account); translation requests go straight from your browser to the translation service you chose (by default Google Gemini, with your own API key), with no third-party server in between; the source is fully open, anyone can audit it.

## Performance

We stress-tested Shinkansen on the English Wikipedia article for *Taiwan* (nearly a thousand paragraphs): the DOM node count actually *dropped* (Chinese is more compact than English) while memory grew by only about 8 MB, the page stayed responsive throughout (95%+ of the time is spent waiting for the API; the browser does almost no extra work), and once translation finished the DOM was clean with no leftover artifacts. Translating the entire page with the cheapest model costs under USD $0.08; translated content is automatically cached, so re-opening the same page is free. Full numbers in [PERFORMANCE.md](docs/PERFORMANCE.md).

## Features

- **Multi-language target + multi-language UI**: translate into 8 languages — Traditional Chinese (Taiwan) / Simplified Chinese (China) / English / Japanese / Korean / Spanish / French / German. Pick in the "Translate to" dropdown inside the toolbar icon menu; all translation paths (web / documents / video subtitles) share this setting. The toolbar icon menu, settings page, web-translation progress toast, and document translation page are all available in all 8 UI languages — independent picker, defaults to your browser locale.
- **Instant Translation**: see the page start turning into your target language within 1 second of pressing translate — no waiting for the entire batch to come back before any text is updated (Gemini only).
- **Preserves page layout**: text is replaced in place; fonts, sizes, colors, and links are kept; bold and italics survive untouched.
- **Respects the page's "do not translate" markup**: names, codes, and snippets that site authors mark with the standard HTML `translate="no"` or `notranslate` are preserved as-is and never sent to the API; icons drawn with icon fonts (words like `star` or `menu` in the HTML) are not translated into text, so they don't disappear.
- **Single-language overlay / bilingual side-by-side dual mode**: one-click switch in the toolbar icon menu. *Overlay* replaces text in place; *bilingual* keeps the original and appends the translation as a new paragraph. Bilingual mode offers four visual treatments (subtle background tint / left border / wavy underline / no mark) for the translated paragraphs.
- **Three translation engines**: Gemini (AI translation, best quality, requires API key) + Google Translate (unofficial free endpoint, no API key, faster) + Custom model — switch freely depending on what you're reading.
- **Free Chinese variant conversion**: when your target language is Traditional or Simplified Chinese, content in the opposite variant is converted locally with built-in OpenCC dictionaries — no API key, no API calls, works offline, with phrase-level Taiwan-convention mapping (软件→軟體, 视频→影片, 内存→記憶體). "Auto-convert Chinese variants" is on by default — pages in the opposite variant convert automatically on load, no manual trigger needed; you can turn it off in the toolbar icon menu (unchecking reverts the current page immediately); on mixed-language pages only the Chinese paragraphs use the free conversion while the rest go through your chosen engine. Variant conversion always replaces the original text in place — even in bilingual mode you never get the Simplified and Traditional versions stacked; bilingual display applies only to paragraphs that are actually translated.
- **Custom AI models**: any OpenAI-compatible endpoint, Chat Completions or Responses format — OpenRouter / Together / Groq / local Ollama, hundreds of models.
- **Three customizable shortcuts**: `Alt+A` / `Alt+S` / `Alt+D` each bound to its own translation preset (engine + model + label). Pick the right engine per content type with one keystroke (e.g., Flash for reading material, Google MT for casual browsing). Details in "Translation shortcuts and presets" below.
- **Hover translate**: pick a modifier key (Shift / Option / Control) in settings, then hold it and rest the pointer on a paragraph to translate just that paragraph in place — handy when you want to read the original first or only need part of a page. Pressing a shortcut afterwards translates the rest of the page; press again to restore. Hover translations are bilingual by default (original stays, translation appended below) and can be switched to replace-original in the same place, independently of the full-page display mode.
- **Floating button**: a floating button pinned to the left/right edge of the page — tap to translate the page, long-press to switch translation engine or open the menu; on by default on all platforms, with adjustable button size and opacity.
- **Document translation (PDF / EPUB / Word / TXT / Markdown / HTML / subtitles)**: upload a file and translate the whole thing — PDFs keep the original layout in the translated output; EPUB supports a book-wide glossary (consistent name translations across chapters), per-chapter translation, preview editing, and bilingual output; Word (.docx) files get the translation written back into the original file with layout, styles, and tables fully preserved, with optional bilingual output; TXT / Markdown / HTML files reuse the same chapter pipeline, and the translated file keeps the same format as the original; SRT / WebVTT / ASS subtitle files are translated cue by cue with timing preserved, with optional bilingual output. Details in "Document translation" below.
- **YouTube subtitle translation**: detects YouTube captions and replaces them in real time with your target language (Traditional Chinese by default); styling matches the native YouTube subtitle look. Details in "YouTube subtitle translation" below.
- **Bilingual subtitles**: when the display mode is set to "Bilingual", subtitles show two lines simultaneously — original on top, translation below. Useful for listening practice or proofreading. Applies to YouTube, Google Drive and X videos. Details in "Bilingual subtitles" below.
- **X (Twitter) video subtitle translation**: X videos with auto-generated captions are translated into your target language when played with sound, shown in X's native caption style. Details in "X video subtitle translation" below.
- **YouTube AI re-segmentation** (ASR-only): YouTube auto-generated captions arrive as broken word fragments without punctuation. Shinkansen sends the whole batch to AI for semantic re-segmentation, then translates — translated subtitles go from "shattered words" to "complete sentences". Details in "AI smart segmentation" below.
- **Custom glossary**: pin specific terms to your preferred translations so proper nouns are always rendered consistently. Two layers (global + domain-specific) where domain rules override global. Details in "Custom glossary" below.
- **Blocked-word list**: an editable list of words you don't want in the translation. Works for any target language — write your own substitution pairs (defaults to empty for most targets; ships with 26 entries for Traditional Chinese targets). Injected as a high-prominence block at the end of the system prompt. Details in "Blocked-word list" below.
- **Translate opening only**: preview the first few paragraphs before deciding whether to translate the whole article. Saves tokens. Details in "Translate opening only" below.
- **Full-text glossary consistency** (off by default): especially useful for long articles with many proper nouns. Automatically ensures the same name or term is translated consistently throughout. Details in "Glossary consistency" below.
- **Translation cache + live cost report**: two-layer caching (local cache + Gemini implicit cache). After translation, the toast shows live cache hit rate and actual cost saved. Details in "Translation cache and cost calculation" below.
- **Usage tracking**: every translation's token count and cost is logged, with charts and CSV export.
- **Edit translations**: after a page is translated, you can directly edit the translated text on the page — handy for cleaning up before printing PDFs or letting Readwise Reader pick it up.
- **Send to Instapaper**: save the whole translated article to your own Instapaper account via the Instapaper API — what gets saved is the translation you see, not the original. Unlike Instapaper's standard save (which stores the URL and lets the server re-fetch the original article), Shinkansen uploads the translated content directly, so you can re-read the translated version later.
- **Cross-tab translation continuity**: after triggering translation in tab A, opening a link from A in a new tab B (with Cmd-click on Mac / Ctrl-click on Windows / `target="_blank"` / `window.open`) automatically translates B with the same preset. Multi-level: B opens C, C inherits too.
- **Auto-translate specific sites**: add domains to a whitelist in settings; pages on those sites auto-translate on load (the toast displays an `[Auto-translate]` prefix to indicate the whitelist trigger).
- **Restore original**: press the same shortcut to switch back to the original — toggle anytime.
- **Google Docs translation**: detects Google Docs and opens a translatable read-only view automatically (details below).

## Installation

**Chrome / Edge / Brave (Chromium browsers)**

Go to the [Chrome Web Store listing](https://chromewebstore.google.com/detail/shinkansen/pnhmlecoofeoofajcjenndnimhbodhlg) and click "Add to Chrome".

**Firefox**

Go to the [Firefox Add-ons listing](https://addons.mozilla.org/firefox/addon/shinkansen/) and click "Add to Firefox".

> ⚠ **Firefox users**: the default shortcuts `Alt+S` / `Alt+A` / `Alt+D` are intercepted by Firefox or other extensions (Firefox uses `Alt+S` for the History menu, `Alt+D` to focus the address bar; `Alt+A` is commonly grabbed by extensions like Save Page WE). Chrome has no such conflict, but on Firefox these defaults likely won't trigger translation. Go to `about:addons` → gear icon → "Manage Extension Shortcuts" and rebind Shinkansen's three shortcuts to non-conflicting combinations (e.g., `Ctrl+Shift+S`). The "Translation shortcuts" section in settings will also display this warning when running on Firefox.

**Safari (macOS)**

Install from the [Mac App Store listing](https://apps.apple.com/tw/app/shinkansen-translator/id6768586680), open the Shinkansen app and follow the on-screen steps to enable Shinkansen under Safari's "Settings → Extensions" and allow it on websites.

**Safari (iOS / iPadOS)**

Install from the [App Store listing](https://apps.apple.com/tw/app/shinkansen-web-translator/id6776958298), open the app and follow the first-launch guide to enable the extension in Safari and enter your API key.

**Developer build (load unpacked)**

1. Open Chrome, go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `shinkansen/` folder in this repo
5. Shinkansen appears in the extensions list — pin it to the toolbar

## First-time setup

1. Get a Gemini API key — open [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys), sign in and click "Create API key"; see the [API key setup guide](docs/API-KEY-SETUP.en.md) for step-by-step instructions
2. Click the Shinkansen icon in the toolbar → "Settings"
3. Paste your Gemini API key
4. Default model is `gemini-3.1-flash-lite`, Service Tier `DEFAULT`
5. Other parameters (temperature, paragraphs per batch, character budget, etc.) can be tweaked as needed

## Usage

- **Manual translation**: click the toolbar icon → "Translate page"
- **Translation shortcuts** (three presets):
    - `Option+S` / `Alt+S` — defaults to Gemini Flash Lite (cheapest, recommended for daily use)
    - `Option+A` (macOS) / `Alt+A` — defaults to Gemini 3.8 Flash (best quality)
    - `Option+D` / `Alt+D` — defaults to Google Translate (free, no API key)
    - All three keybindings, engines, models, and labels are customizable in the "Translation shortcuts" section of settings
    - Press any shortcut while translated → restore original
    - Press any shortcut while translating → cancel translation
- **iOS / iPadOS touch gesture**: on iPhone / iPad Safari, tap the page with several fingers to translate (same as the primary preset shortcut — tap again to restore or cancel); a multi-finger long-press uses the secondary preset. Four fingers by default; switch to three for one-handed use on iPhone under "Touch gesture translate" in settings, or turn it off there if it triggers accidentally — the floating button and external-keyboard shortcuts are unaffected.
- **YouTube subtitle translation**: open a video with captions (manual or auto-generated) and make sure CC is on — subtitle translation starts automatically by default; to pause or restart it, click the toolbar icon → toggle "YouTube subtitle translation"
- **Auto-translate sites**: add domains to the "Auto-translate sites" list in settings; pages on those sites translate on load (toast shows the `[Auto-translate]` prefix)
- **Custom glossary**: add term mappings in the "Glossary" tab; translations are forced to use your preferred renderings
- **Glossary consistency**: enable it from the toolbar icon menu or settings page; long-form translations build a glossary first to keep proper nouns consistent
- **Edit translations**: after translating, click "Edit translation" in the toolbar icon menu to directly edit the translated text on the page. While editing, a floating toolbar at the bottom of the page lets you undo changes paragraph by paragraph or finish editing

## Translation shortcuts and presets

Shinkansen offers three customizable translation presets, each bound to a shortcut:

| Shortcut | Default engine | Default model | Best for |
|----------|----------------|---------------|----------|
| `Alt+S` / `Option+S` | Gemini | Flash Lite | Daily reading, max savings |
| `Alt+A` / `Option+A` | Gemini | 3.8 Flash | Important articles, quality first |
| `Alt+D` / `Option+D` | Google Translate | — | No API key needed, fast, free |

**All customizable in the "Translation shortcuts" section of settings**: each preset's engine (Gemini / Google Translate / Custom model), Gemini model (Flash Lite / Flash family), and display label can be changed. The keybindings themselves can also be customized right there — click a preset's key field and press the combination you want (on Chrome use `⌥ Option` or `⌃ Control`; on Safari — Mac / iPad / iPhone — use `⌃ Control`, since iOS Safari doesn't pass `⌥` / `⌘` to web pages; the settings page shows the available keys per browser automatically; press `ESC` to cancel). Works with iPad external keyboards too. You can also adjust the built-in default keys at `chrome://extensions/shortcuts` (Chrome) or `about:addons` (Firefox).

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

1. On a Google Docs editing page, press `Option+S` (or click "Translate page" in the toolbar icon menu)
2. Shinkansen opens the same document in a new tab in "mobile reading view" (mobilebasic)
3. Once the new tab loads, translation starts automatically — no second keystroke needed

Notes: you must have view access to the document. Mobile reading view is read-only and does not affect the original document.

## Document translation (PDF / EPUB / Word / TXT / Markdown / HTML / subtitles)

Click the Shinkansen toolbar icon → "Translate document" to open a dedicated tab, then drop a PDF, EPUB, Word (.docx), TXT, Markdown, HTML, or subtitle file (SRT / WebVTT / ASS) onto the page to translate the whole file. Files are parsed entirely in your browser — nothing is uploaded anywhere except the text sent to the translation engine. The one exception is PDF translation into Simplified Chinese / Japanese / Korean: the first time, the matching font (about 10–20 MB) is downloaded from the project website, once only and cached for offline use; that request carries no document content.

Document translation works in desktop browsers, on iPhone and iPad, and in the iOS version installed on a Mac; on iPhone, rotate to landscape (the side-by-side reader and editor need a wider screen). On iPhone and iPad, downloading a translation opens the system share sheet — choose "Save to Files" to keep it.

**PDF translation**:

- **Layout preserved**: the PDF layout is analyzed to rebuild paragraphs (columns, tables, lists, captions), and the translation is rendered at the original positions
- **Online reader**: side-by-side original / translation view with synchronized scrolling
- **Download translated PDF**: the translation is written directly onto the original page layout (with an embedded CJK font); downloads as `<filename>-shinkansen.pdf` for offline reading or archiving
- **Choose which pages to translate**: after parsing, enter a first / last page to translate just part of a long report or manual; the reader and the downloaded PDF still contain the whole document, with pages outside the range left in the original language
- **Limits**: 300 pages / 50 MB; scanned-image PDFs (OCR required) and encrypted PDFs are not supported

**EPUB book translation** (beta):

- **Book-wide glossary**: before translating, the whole book is scanned to extract a glossary of names / places / terms (including nicknames, short forms, and standalone-surname variants); review and edit it, then it stays frozen for the entire book so translated names remain consistent across chapters. A plain translated name is output as-is (any "(original)" the model adds on its own is stripped) — to show the original alongside, write the target as "translation (original)" and tick "annotate once". Export / import as JSON, or import an externally curated CSV (two columns: source,translation; header rows and quoted fields are tolerated) — reuse a previous book's glossary for sequels
- **Per-chapter translation**: after parsing, a chapter list shows word counts and estimated cost per chapter; translate a chapter or two to check quality before continuing — finished chapters hit the cache and are never billed again
- **Post-translation consistency scan**: after each round, drift ("same source term, multiple translations") is detected automatically; unify with one click and feed the fix back into the glossary
- **Preview and editing**: per-chapter and whole-book preview, click-to-edit paragraphs, search & replace, original-text comparison view
- **Automatic session saving**: translation progress, glossary, and accumulated cost are saved locally as a bundle; closing and reopening the page restores everything, and sessions can be exported to a file and imported on another computer
- **Translated book download**: the translation is written back into the original book structure (CSS / images / fonts and untranslated chapters preserved as-is), in monolingual or bilingual format; 100 MB limit, DRM-protected books are rejected

**Word (.docx) file translation**:

- **Translation written back into the original file**: layout, styles, fonts, images, and tables are all maintained by Word itself — bold / italic, underline, colored text, highlights, hyperlinks, list numbering, and bookmarks are preserved as-is; download `<filename>-shinkansen.docx` and open it straight in Word for further editing
- **Per-chapter translation**: chapters are split by heading styles (Heading 1 / Heading 2) with the same chapter checklist as EPUB; headers & footers, footnotes, and document comments each appear as their own selectable chapter, and comment text is translated too
- **TOC and page-number fields stay intact**: PAGE / TOC and other Word fields are preserved untouched — update fields in Word after translating and the TOC recalculates with the translated headings
- **Monolingual or bilingual output**: the bilingual version keeps each original paragraph and inserts the translation right after it (`-shinkansen-dual.docx`); switching modes just re-downloads with no re-translation cost
- **Same pipeline as EPUB**: book-wide glossary, post-translation consistency scan, preview editing, automatic session saving, and cost estimates all carry over
- **Limits**: 100 MB max; password-protected files and files with unaccepted tracked changes are rejected with a clear message; legacy `.doc` is not supported

**TXT / Markdown / HTML file translation**:

- **Same pipeline as EPUB**: book-wide glossary, post-translation consistency scan, preview editing, automatic session saving, and cost estimates all carry over
- **TXT**: translated paragraph by paragraph (split on blank lines); blank lines and separators are preserved as-is
- **Markdown**: split into chapters by headings (`#` / `##`) with the same chapter checklist as EPUB; headings, lists, quotes, and other markup are preserved, and code blocks are passed through untranslated
- **HTML**: saved web pages (`.htm` / `.html`) reuse the EPUB chapter serialization engine — inline bold / italic / link markup is preserved, and `<script>` / styles pass through untouched
- **Output format matches the input**: txt in, txt out; Markdown in, Markdown out; HTML in, HTML out — downloads as `<filename>-shinkansen.<ext>`

**Subtitle file translation** (SRT / WebVTT / ASS):

- **Cue by cue**: each cue is one translation unit; neighbouring cues provide context, but cues are never merged or split, and translations stay concise and conversational
- **Timing and structure preserved**: cue numbers, timestamps, the WEBVTT header, NOTE / STYLE blocks, and ASS style sections and `Comment:` lines are left untouched — the translated file has the same cues and timing as the original
- **Inline tags preserved**: `<i>` / `<b>` / `<c>` tags, speaker tags, and ASS `{\an8}` positioning and `\N` line breaks are restored as-is
- **No trailing period**: each translated cue ends without a "。" (question and exclamation marks are kept), matching YouTube subtitle translation; it can be turned off in the translation settings, applies to both preview and download, and turning it off restores the AI's original output (only when the target language is Chinese)
- **Monolingual or bilingual subtitles**: "Subtitle content" lets you choose translation-only cues, or bilingual cues with the translation on top and the original below (great for side-by-side viewing or language learning); switching re-downloads without re-translating
- **Same pipeline**: book-wide glossary (consistent name translations across the whole film), post-translation consistency scan, preview editing, and automatic session saving all carry over
- **Player-friendly file names**: downloads as `<filename>.<lang>.<ext>` (e.g. `Show S01E01.srt` → `Show S01E01.zh.srt`), so VLC / Plex / Jellyfin pick it up next to the video and label the language automatically; the bilingual version is `<filename>.dual.<lang>.<ext>`
- **Encoding auto-detected, always saved as UTF-8**: subtitle files in legacy encodings (Big5 / GBK / Shift_JIS / EUC-KR …) load without mojibake, and the translated file is always written as UTF-8 (also applies to TXT / Markdown / HTML files)

Document translation shares the same translation cache and usage tracking as web translation. The "Translation settings" dialog also lets you set the batch size and a per-document extra prompt (e.g., "this is a 19th-century novel — keep the tone classical").

## YouTube subtitle translation

Open a YouTube video with captions (manual or auto-generated), make sure CC is on, click the Shinkansen toolbar icon — the menu will show a "YouTube subtitle translation" toggle. Turn it on. Captions are progressively replaced with your target language (Traditional Chinese by default) without affecting playback; styling matches native YouTube captions exactly. Captions already in the target language are not sent for translation.

Subtitle auto-translate is on by default — translation starts automatically whenever you open a video, no manual toggling; if you prefer to start it yourself, turn it off in the "YouTube subtitles" tab in settings.

On YouTube video pages, the toolbar icon menu shows a "Caption size" dropdown to enlarge the translated captions (100%–200%). It works on both desktop and mobile; on iPhone / iPad it also scales the captions shown by the iOS system player in fullscreen

### AI smart segmentation (ASR-only)

YouTube auto-generated captions (videos without human captions; CC labeled "auto-generated") are sliced **by time, not by sentence** — each caption is just 1–3 English words with no punctuation. Translating each one individually loses all semantic context, and the output reads like shredded fragments.

Shinkansen has a dedicated pipeline for ASR captions:

- **AI-driven re-segmentation**: the entire batch of ASR fragments is sent to Gemini, which re-segments by meaning (merges short fragments into full sentences, adds punctuation), then translates. Translated subtitles go from "shattered words" to "complete sentences".
- **Default "hybrid mode"**: a fast local heuristic shows segmented captions immediately (subsecond, no waiting), while AI segmentation runs in the background and replaces them with the polished version when ready — best of both worlds.
- **Stable subtitle overlay**: Shinkansen's own overlay completely bypasses YouTube's native caption-segment rendering (which causes "word-by-word popup" behavior); whole sentences appear and disappear cleanly. Auto-shifts up to avoid the progress bar when the controls appear.
- **Toggleable**: if you only want minimum latency with YouTube's original segmentation, uncheck "AI segmentation mode" in the "YouTube subtitles" tab.
- **Automatically disabled with the Google Translate engine**: AI segmentation needs an LLM, which would call Gemini and incur cost. When the free engine is selected, YouTube's original segmentation is always used — your API key is never touched behind your back.

Human-uploaded captions (professional / community-contributed) are unaffected by this setting; they continue using the original sentence-by-sentence translation pipeline.

### X video subtitle translation

For X (Twitter) videos that have auto-generated captions, Shinkansen translates the captions into your target language **when the video plays with sound (unmuted)**. Fragments are re-segmented into full sentences by AI, and the translation is shown as a caption track at the bottom of the video, styled like X's own captions (also in fullscreen). Videos auto-playing muted in the timeline are not translated, so scrolling past them costs nothing. Long videos are not sent in one go: only the captions for roughly the next three minutes from the playback position are translated, more are added as playback continues, translation stops when you pause, mute or scroll away, and seeking resumes it from the new position.

- **X's CC button doubles as the translated-caption toggle**: "Hide captions" hides the translation, "Show captions" brings it back (showing the translation, not the English original). Right after the translation first appears, the first CC press may do nothing — press it again
- **Toggle**: on an X post page, the Shinkansen toolbar icon menu shows an "X video subtitle translation" toggle that affects only the current tab; whether subtitles are translated automatically by default is set on the settings page (shared with YouTube subtitle translation)
- **Engine and model** follow the YouTube subtitle settings; bilingual display follows the display mode
- Captions already in the target language are not sent for translation; videos for which X provides no captions cannot be translated

### Google Drive video subtitles

Captions on Google Drive video pages are translated into your target language too. Click the Shinkansen toolbar icon on that page to find the "Drive video subtitle translation" toggle; bilingual display follows the display mode, and captions already in the target language are not sent for translation.

### Bilingual subtitles

Subtitle bilingual display follows the display mode setting: click the Shinkansen toolbar icon and pick the "Bilingual" display mode — subtitles will then show both original and translation simultaneously (original on top, translation below). The "Replace" mode (default) shows the translation only. Page translation and subtitles share the same display mode, no separate setting needed.

Best for:
- **Listening practice**: glance at the original when you can't catch a word
- **Proofreading**: when translation quality is in doubt, see the original directly without switching modes
- **Language learning**: use subtitles as bilingual study material

Implementation notes:
- **YouTube, Google Drive and X videos share the same display mode** (switching to Bilingual affects all of them)
- **Live switch**: changing the mode during playback takes effect immediately, no reload
- **Compatible with AI segmentation**: bilingual subtitles work cleanly on AI-segmented full sentences — full original sentence + full translated sentence on two lines

### Cost

Subtitle translation shares the same billing logic and usage tracking as web translation. Translated subtitles are automatically cached — replays or scrubbing back to already-translated regions are free. AI segmentation mode uses slightly more tokens than the off mode (one extra prompt for semantic segmentation), but the readability gain is significant; recommended on.

### Notes

- The video must have captions (manually uploaded or auto-generated)
- Subtitle translation uses an independent system prompt, customizable in the "YouTube subtitles" tab
- If CC is off, Shinkansen turns it on for you (only once per video session, to respect manual user opt-out afterward)
- If auto-translate is turned off, you'll need to toggle the switch on again after switching videos

## Translation cache and cost calculation

Shinkansen has two layers of caching, each saving you money at a different stage:

**Layer 1: Local translation cache** — translated paragraphs are stored in `chrome.storage.local`, keyed by SHA-1 hash of the original text. Next time the same text is encountered (even on a different page), the translation is served directly — no API call, no cost. The key also includes the target language, model, glossary and blocked-word lists, and custom prompt, so changed settings never hit stale translations. Ordinary extension updates do **not** clear the cache. The few updates that change translation output either clear the web page and video subtitle caches once automatically after upgrading (the document translation cache is left alone), or say so in the release notes and recommend clearing manually. To clear it yourself, use "Clear cache" in the toolbar icon menu. The cache evicts least-recently-used entries when it fills up (LRU).

**Layer 2: Gemini implicit context cache** — done server-side by Google. When consecutive requests share a common prompt prefix (e.g., system prompt + glossary), Gemini caches that prefix; cached input tokens are billed at a discount (90% off for the Gemini 3 series, i.e. 10% of the normal rate; per-model discounts are shown in the settings pricing table). In practice Gemini 3 only caches complete prefix blocks of roughly 4,096 tokens or more; a web-translation batch carries a fixed prefix of about 2,400 tokens, so the hit rate shown for ordinary web pages is usually 0% — large glossaries or document translation are more likely to hit. No setup needed — Shinkansen automatically reads the cache hit data from API responses.

**After translation, the bottom-right toast shows two lines of metrics:**

- Line 1: `{billed tokens} tokens (XX% hit)` — billed token count, plus the Gemini implicit cache hit rate (cached input tokens as % of all input tokens)
- Line 2: `${cost} (XX% saved)` — actual amount paid, plus how much was saved relative to no-cache pricing

If every paragraph hits the local cache (e.g., re-translating a page you just translated), the toast shows "All cache hits · nothing billed this run".

Every translation's token usage, cost, and cache hit rate is logged and viewable in the "Usage history" tab in settings. Records are stored locally and cover that device only; if the same API key is used on several devices, the amount shown on any one of them will be lower than your actual bill — check Gemini API Spend for the total.

## Custom glossary

In the "Glossary" tab in settings, you can pin specific source terms to your preferred translations. For example, force "Arrow" to always translate as "艾蘿" instead of "箭頭", or specifically as "乙太翠雀之箭" on DC Comics-related sites.

The glossary has two layers: "Global" applies to all sites; "Domain-specific" only applies to designated domains. When the same term appears in both, domain rules override global. Append a path to a domain (e.g. `example.com/news`) to limit the scope to pages under that path, so different sections or series on the same site can each have their own glossary; path rules override site-wide rules. In the settings page, the domain list marks path-limited entries with " (path scope)" so you can see at a glance which ones apply to only part of a site.

The custom glossary takes priority over auto glossary consistency. During translation, glossary instructions are placed at the very end of the system prompt — the position the LLM weights most heavily. After editing the glossary, no need to manually clear the cache; Shinkansen invalidates old entries automatically.

The custom glossary and the blocked-word list are stored locally in your browser (not subject to the browser sync quota of 8KB per item, so hundreds of entries fit) and are not synced across devices; to move them to another device use "Import / Export settings" on the settings page — the backup file includes both lists.

## Custom models (OpenAI-compatible endpoints)

In addition to Gemini and Google Translate, you can connect one OpenAI-compatible endpoint to use any model other than Gemini — for example:

- **OpenRouter** (`https://openrouter.ai/api/v1`): one endpoint, hundreds of models — Anthropic / Gemini / Llama / Qwen / Grok / xAI / Mistral, etc.
- **Together / Groq / Fireworks** and other model providers
- **Local Ollama** (`http://localhost:11434/v1`): run open-source models on your own machine — zero cost, zero latency
- **OpenAI directly** (`https://api.openai.com/v1`)

### Setup steps

1. Go to the "Custom model" tab in settings
2. Fill the three required fields:
   - **Base URL**: e.g., `https://openrouter.ai/api/v1` (Shinkansen automatically appends `/chat/completions`, or `/responses` when the API format is set to Responses)
   - **Model ID**: e.g., `anthropic/claude-sonnet-4-5` (OpenRouter format is `provider/model`)
   - **API Key**: the Bearer token for that provider; click "Test" to verify connectivity instantly (~1 token cost)
3. Optional: translation prompt (leave blank = use the built-in compact default, identical to Gemini's) / temperature (leave blank = omit the parameter entirely, for reasoning models that only accept their own default) / thinking level and advanced JSON parameter pass-through / API format (Chat Completions by default; choose Responses when the endpoint or model only offers the Responses API, and requests go to `/responses` instead) / custom request headers (JSON, for endpoints that require extra headers besides the API Key, such as a session id or `api-key`) / model pricing input & output rates and cache-hit discount (USD per 1M tokens; 0 = don't display cost)
4. Save
5. In the "General" tab → "Translation shortcuts", change any preset's engine to "Custom model"
6. Triggering that preset's shortcut now routes through your custom endpoint

### Design notes

- **Independent translation prompt**: custom models use their own translation prompt, not inherited from the Gemini tab
- **Shared blocked-word list and custom glossary**: settings from those two tabs are auto-injected into the prompt end; custom models inherit them. Edit once, both engines apply.
- **Cache partitioning**: the cache key includes a base URL hash — different endpoints with the same model name don't pollute each other
- **API key not synced**: `customProvider.apiKey` and the custom request headers live only in your local browser — not synced across devices, not included in JSON export
- **429 retry with backoff built in**: when a provider returns 429 (quota limit), requests are automatically retried with backoff
- **Strong segment markers** (on by default): local quantized models (e.g. gemma-4 quantized) tend to mistranslate the compact `«1» «2»` segment markers as natural language ("N1, N2") and leak them into the output. With this on, multi-segment batches use `<<<SHINKANSEN_SEG-N>>>` instead — weak models don't mistranslate it. Cost: about 7 extra tokens per segment. Commercial APIs (OpenRouter / Groq, etc.) typically don't need this, but leaving it on is harmless

### Limitations

- Only **one** custom model can be configured
- Must be genuinely OpenAI-compatible (`POST /chat/completions` + `Bearer` Authorization + standard `messages` structure + `usage.prompt_tokens` / `completion_tokens` fields; or, with the API format set to Responses, `POST /responses` + the `instructions` / `input` structure). Anthropic's and Gemini's **native** APIs cannot be connected directly, but you can route them through OpenRouter
- Pricing must be entered manually; token counts depend on the provider returning a correct `usage` object in responses

### Firefox: connecting to a local server

Firefox's **HTTPS-Only Mode** (`about:preferences#privacy`, scroll to the bottom) — when enabled — forces all `http://` requests issued by extensions to be **upgraded to `https://`**, so connections to `http://localhost:11434/v1` (Ollama), `http://192.168.x.x:8081/v1` (local llama.cpp server), and similar HTTP endpoints fail outright. Chrome has no equivalent mechanism; this is Firefox-specific.

**Fix**: go to `about:preferences#privacy` → set HTTPS-Only Mode to "Don't enable", or add an exception for the URL. If the Base URL field starts with `http://`, Shinkansen detects Firefox and shows an inline warning.

## Blocked-word list

AI models occasionally produce wording you'd rather avoid in the translation — for example, when translating to British English you may want "colour" instead of "color"; when translating to European Portuguese you may want "telemóvel" instead of "celular"; or your in-house style guide may forbid certain words entirely ("utilize" should always be "use", "leverage" should always be "use", etc.). The blocked-word list lets you give the model an explicit rule per word: never use the left column; always use the right column.

The list works for any target language. Each entry has three columns — blocked word (required), replacement (optional), and a free-text note (optional, useful for documenting why an entry exists). Only the blocked word is required: fill in a replacement to force a specific word, or leave it blank to simply forbid the word and let the model rephrase naturally on its own — handy when you just dislike a word but can't pin down a fixed replacement (e.g. a cliché). You can edit, add to, or fully replace the list in the "Forbidden terms" settings tab, or click "Restore default list" to revert. By default the list is empty; only the Traditional Chinese (Taiwan) target ships with 26 prepopulated entries. Switching between targets only auto-resets the list if your current entries still match the previous target's defaults — your hand-edited entries are preserved.

After every translation response, Shinkansen scans the output and logs a `forbidden-term-leak` warning in the Debug tab (with original and translation snippets) for any blocked words that slipped through — letting you investigate model leakage without **automatically rewriting the translation**, following the design principle "language preferences belong in the prompt, not in post-hoc regex replace", which avoids damaging legitimate quoted uses in the translation.

## Translate opening only

For users sensitive to token usage who want to preview before committing to a full read, the Gemini tab has a "Save mode" section with a "Translate only article opening" toggle. When enabled, only the first N paragraphs (in DOM order, default 25, range 5–50) are translated; the rest are skipped. Significantly reduces token usage.

**Progressive experience**: translate the opening → if you decide to keep reading → a "Translate the rest" button appears in the bottom-right toast → click to run the full translation. Already-translated paragraphs hit the local cache fast path (0 tokens / ~9 ms); only the remainder hits the API. The toggle setting itself isn't modified, so the next page you open also runs in saving mode.

Off by default. Especially useful for blogs / news / Substack — most articles can be evaluated within the first 5–10 paragraphs. Less useful for sites like Wikipedia / GitHub where the DOM front-matter is nav / chrome rather than main content (you'd end up translating the navigation instead of the article).

## Glossary consistency

LLMs translating long articles tend to produce inconsistent renderings for the same name or term across paragraphs (e.g., the same person rendered as "強森" early on and "約翰森" later). With "Glossary consistency" enabled, Shinkansen first scans the full article to build a proper-noun mapping, then applies that mapping uniformly to every translation batch.

Off by default. Recommended only for articles where precision matters (e.g., long-form journalism with many names, academic articles). Side effect: the glossary translation step bypasses some system prompt instructions — for example, if you originally configured "keep English names untranslated", enabling glossary consistency forces them to be translated. Building the glossary also costs an extra API call, increasing token usage and translation time slightly.

## Current version

v2.7.7 — full feature list and specs in [SPEC.md](SPEC.md) (Traditional Chinese only).

## License

This project is licensed under the [Elastic License 2.0 (ELv2)](LICENSE).

In plain English: you're free to view the source, learn from it, modify it, and use it yourself, but you **cannot** package Shinkansen (or any modified version) as a hosted or managed service to third parties. See the [LICENSE](LICENSE) file for the full text.

## Third-Party Notices

Shinkansen bundles the following open-source libraries and fonts. Full source,
licenses, and license file locations are listed in
[THIRD-PARTY-NOTICES.md](shinkansen/THIRD-PARTY-NOTICES.md):

- **PDF.js** (Mozilla, Apache 2.0) — PDF parsing / page rendering for the document translation feature
- **pdf-lib** (@cantoo/pdf-lib, MIT) — translated PDF reconstruction on download
- **fontkit** (pdf-fontkit, MIT) — font parsing / subsetting backend used by pdf-lib
- **Chart.js** (Chart.js Contributors, MIT) — charts on the usage history tab
- **fflate** (Arjun Barrett, MIT) — EPUB unzip / repack for the translated book
- **@mozilla/readability** (Mozilla / Arc90, Apache 2.0) — article extraction before sending to Instapaper
- **opencc-js / OpenCC dictionaries** (nk2028 / BYVoid, MIT / Apache 2.0) — local Simplified ↔ Traditional Chinese conversion
- **Noto Sans CJK TC** (Google Noto, SIL OFL 1.1) — embedded Traditional Chinese font for the translated PDF (Regular + Bold); for Simplified Chinese / Japanese / Korean targets, **Noto Sans SC / JP / KR** (same license) is downloaded once from the project site on first use
