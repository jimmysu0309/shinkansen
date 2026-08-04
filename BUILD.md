# Shinkansen Firefox — Build Instructions for AMO Reviewers

This document explains how to rebuild the submitted Firefox extension ZIP
(`shinkansen-firefox-vX.Y.Z.zip`) from the accompanying source ZIP
(`shinkansen-firefox-vX.Y.Z-source.zip`).

The build process is **trivial**: a single `jq` invocation patches 5 lines
of JSON in `manifest.json`. There is **no** minification, bundling,
transpilation, or any other code transformation. All `.js` / `.css` / `.html`
files in the submitted ZIP are byte-for-byte identical to the source.

---

## Prerequisites

- bash 3.2+
- [jq](https://jqlang.org/) 1.6+
- `zip` (standard on Linux / macOS; Windows: install via WSL or Git Bash)

Install jq:

```bash
# macOS
brew install jq

# Ubuntu / Debian
sudo apt-get install jq

# Windows (winget)
winget install jqlang.jq
```

---

## Build Steps

1. Extract the source ZIP. After extraction you should see:
   ```
   shinkansen/
     manifest.json
     background.js
     content-*.js
     ...
   firefox-build.sh
   BUILD.md  (this file)
   ```

2. Run the build script from the extracted root directory:

   ```bash
   chmod +x firefox-build.sh
   ./firefox-build.sh
   ```

3. Output: `shinkansen-firefox-vX.Y.Z.zip` in the current directory,
   matching the submitted Firefox ZIP byte-for-byte (modulo ZIP timestamp
   metadata).

---

## Note on `shinkansen/lib/instapaper-keys.js`

The source ZIP contains `shinkansen/lib/instapaper-keys.js`, a 20-line file
holding the Instapaper Full API **consumer key / consumer secret** for the
optional "Send to Instapaper" feature.

- It is **not** in the public git repository. It is generated at release time
  from CI secrets using `tools/instapaper-keys.template.js`, then packaged.
  Keeping it out of the repository (and out of git history) is only meant to
  reduce automated scraping of public code search — the credential is
  inherently distributed inside every published build and is not a secret in
  any strong sense.
- It contains no logic: it assigns two string constants onto
  `globalThis.__SK.INSTAPAPER_KEYS`. `lib/instapaper.js` reads them from there.
- The build script does not transform it. It is copied verbatim, like every
  other file.
- If the file is absent, the extension still builds and runs; only the
  Instapaper integration is disabled (`lib/instapaper.js` returns a
  configuration error). Tests inject the credentials rather than reading
  this file.

---

## What the Build Does

The repository's `shinkansen/manifest.json` is the **Chrome version**
(declares `background.service_worker`). Chrome MV3 rejects the
`background.scripts` key with a warning ("requires manifest version 2 or
lower"). Firefox MV3 does not support `background.service_worker` at all.
The two browsers' rules are mutually incompatible, so a single manifest
cannot serve both.

The build performs exactly one transformation, applied via `jq`:

```bash
jq '.background = {"scripts": ["background.js"], "type": "module"} |
    .browser_specific_settings.gecko.strict_min_version = "128.0" |
    .browser_specific_settings.gecko.data_collection_permissions = {"required": ["none"]}' \
    shinkansen/manifest.json > firefox-build/manifest.json
```

This:

1. Replaces `background.service_worker` with `background.scripts`
   (Firefox's required form for MV3 background pages).
2. Adds `browser_specific_settings.gecko.strict_min_version: "128.0"`
   (the extension uses `content_scripts.world: "MAIN"`, supported in
   Firefox 128+ only).
3. Adds `browser_specific_settings.gecko.data_collection_permissions: {"required": ["none"]}`
   (Mozilla's 2025 built-in data-consent rule. Shinkansen does NOT collect
   any user data — translation calls go directly from the user's browser to
   the Gemini API with the user-supplied API key; no Shinkansen-controlled
   server is involved.)

### Note on `strict_min_version: 128.0` vs `data_collection_permissions: 140+`

`web-ext lint` will produce two warnings:

```
KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION:
  "strict_min_version" requires Firefox 128, which was released before
  version 140 introduced support for "data_collection_permissions".
KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION:
  Same, for Android (140 desktop / 142 Android).
```

**This is intentional.** The extension genuinely requires Firefox 128 for
`content_scripts.world: "MAIN"` (used by `content-youtube-main.js` to
intercept YouTube's player XHR for caption translation). On Firefox
128–139 the `data_collection_permissions` key is silently ignored,
which is harmless because the extension does not collect any data
anyway. On Firefox 140+ the consent UI will display "no data collected"
correctly. Lowering `strict_min_version` to 140 would lock out two
years of Firefox users from a feature that works fine for them; raising
it would be unnecessarily restrictive.

All other files (`background.js`, `content-*.js`, `lib/**/*`, `popup/**/*`,
`options/**/*`, `_locales/**/*`, icons, CSS) are copied unchanged.

---

## Verifying the Build Output

After running `firefox-build.sh`, verify the patched manifest:

```bash
unzip -p shinkansen-firefox-vX.Y.Z.zip manifest.json | jq '{version, background, browser_specific_settings}'
```

Expected output:

```json
{
  "version": "X.Y.Z",
  "background": {
    "scripts": ["background.js"],
    "type": "module"
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "shinkansen@jimmy.zm.su",
      "strict_min_version": "128.0",
      "data_collection_permissions": {
        "required": ["none"]
      }
    }
  }
}
```

---

## innerHTML Usage Rationale (for AMO reviewer)

`web-ext lint` flags 21 `UNSAFE_VAR_ASSIGNMENT` warnings on `innerHTML`
assignments. **None of these accept untrusted user input.** Each
assignment is annotated with `// AMO source review: ...` in the source,
explaining the source of the assigned string. The categories are:

| Category | Locations | Source |
|---|---|---|
| **Restore self-saved DOM (translation guard)** | `content-spa.js` × 4, `content.js` × 2 | The string was previously read from the same element via `el.innerHTML` and saved to `STATE.translatedHTML` / `STATE.originalHTML`. We are restoring it back to the same element. |
| **Sanitized via `_escapeHtml`** | `content-youtube.js` × 4 | The string is `_escapeHtml(text) + '<br>' + _escapeHtml(text)`. The `<br>` is a developer-controlled literal; user input is escaped. |
| **Static template + numeric data** | `content-toast.js` × 1, `popup.js` × 1, `options.js` × 9 | All variables interpolated into the template are either: (a) developer-hardcoded strings (`RELEASE_HIGHLIGHTS` literal), (b) numeric values from internal calculation, or (c) escaped via `escapeHtml` / `escapeAttr` helpers. |

User input (translation source text, glossary entries, model names,
domain whitelist entries) is always escaped via `escapeHtml` /
`escapeAttr` before being interpolated. We use `innerHTML` rather than
DOM API construction because the strings being assigned are large
HTML fragments (entire translated paragraphs, table rows with multiple
cells, etc.) and DOM API construction would significantly inflate code
size and cost without a security benefit.

---

## Source Repository

Public repository: https://github.com/jimmysu0309/shinkansen

The Chrome version (`shinkansen/manifest.json` as-is) is the canonical
source of truth. The Firefox build script lives in `.github/workflows/release.yml`
and is mirrored in `firefox-build.sh` for reproducibility outside of CI.

License: Elastic License 2.0 (ELv2). See `LICENSE` in the repo.

---

## AMO Source Submission Questionnaire — Quick Answers

For convenience, the typical AMO source submission form answers:

| Question | Answer |
|---|---|
| Do you use any tools to compile / minify / process source? | Yes — `jq` only, to patch 5 lines of JSON in `manifest.json`. No JS / CSS / HTML transformation. |
| Are there any third-party libraries? | `lib/vendor/chart.min.js` (Chart.js v4.5.1, MIT). Distributed as-is from upstream. |
| Build environment | bash + jq + zip (any Linux / macOS / WSL) |
| How to reproduce | `./firefox-build.sh` (see steps above) |
