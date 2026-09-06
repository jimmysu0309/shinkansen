#!/usr/bin/env bash
# safari-build-devid.sh — Build & notarize Developer ID Safari Extension
#
# 用途:
#   產 Developer ID 簽名 + Apple 公證 + stapled 的 .pkg,給 GitHub Releases
#   公開下載手動安裝用(雙擊 Gatekeeper 認帳)。
#
#   產出: build/shinkansen-macos-v<version>.pkg
#   發布: gh release upload v<version> build/shinkansen-macos-v<version>.pkg
#
# 一般情況下不必手動跑 — `./tools/release/release.sh` 內已一律呼叫本 script,自動 build +
# notarize + 上傳到 GitHub Release。本 script 保留獨立可呼叫,給「release.sh 中段
# 出錯後手動補 Developer ID .pkg」這類情境用。
#
# 注意:
#   - 跟 safari-build.sh(MAS 軌)拆開兩個 script。release.sh 會依序呼叫兩支,
#     兩 script 各自 archive(版本對不上時自動規避踩坑,代價是重 build 一次)。
#   - notarize 等 Apple cloud 時間不固定(實測過 27 秒;Apple 文件聲稱可達 30-60 分鐘)。
#
# 用法:
#   ./safari-app/safari-build-devid.sh
#
# 一次性前置(三步,缺則本 script 開頭 check 失敗會印 step-by-step):
#   - Developer ID Application cert(Apple Developer Portal 申請 + Keychain 裝)
#   - Developer ID Installer cert(同上)
#   - notarytool keychain profile 'shinkansen-notary'(xcrun notarytool store-credentials)

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_DIR="safari-app/Shinkansen"
PROJECT_FILE="$PROJECT_DIR/Shinkansen.xcodeproj"
PBXPROJ="$PROJECT_FILE/project.pbxproj"
EXTENSION_RESOURCES="$PROJECT_DIR/Shinkansen Extension/Resources"
EXPORT_OPTS_DEVID="safari-app/safari-export-options-developerid.plist"
# v1.9.26: BUILD_DIR 改用 $TMPDIR 繞開 iCloud Drive fileprovider 接管成 root:wheel
# 問題(詳見 safari-build.sh 同段註解)。
BUILD_DIR="${TMPDIR%/}/shinkansen-build"
NOTARY_PROFILE="shinkansen-notary"
DEVID_INSTALLER_CERT="Developer ID Installer: Zhimin Su (PR6NG3PH45)"

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi
if [ ! -d "$PROJECT_FILE" ]; then
  echo "ERROR: $PROJECT_FILE 不存在;先跑 ./safari-app/safari-bootstrap.sh。" >&2
  exit 1
fi
if [ ! -f "$EXPORT_OPTS_DEVID" ]; then
  echo "ERROR: $EXPORT_OPTS_DEVID 不存在。" >&2
  exit 1
fi

# 前置 check:三項缺哪項就印對應安裝指引
echo "==> 前置 check(Developer ID cert + notarytool profile)..."
MISSING=""
if ! security find-identity -p codesigning -v 2>/dev/null | grep -q "Developer ID Application: Zhimin Su (PR6NG3PH45)"; then
  MISSING="${MISSING}A"
fi
if ! security find-identity -v 2>/dev/null | grep -q "Developer ID Installer: Zhimin Su (PR6NG3PH45)"; then
  MISSING="${MISSING}I"
fi
# v1.10.23: notarytool 憑證雙軌——keychain profile 優先;不可用時 fallback ASC API key
# (跟 MAS altool 上傳同一套 env 憑證:ASC_KEY_ID / ASC_ISSUER_ID +
# ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8)。
# Why:headless / 自動化 session 的 keychain 常鎖死(store-credentials 寫入報
# 「User interaction is not allowed」),API key 走檔案不碰 keychain。
NOTARY_AUTH_ARGS=()
NOTARY_AUTH_DESC=""
ASC_KEY_FILE="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-}.p8"
if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" &>/dev/null; then
  NOTARY_AUTH_ARGS=(--keychain-profile "$NOTARY_PROFILE")
  NOTARY_AUTH_DESC="keychain profile '$NOTARY_PROFILE'"
elif [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "$ASC_KEY_FILE" ] \
  && xcrun notarytool history --key "$ASC_KEY_FILE" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" &>/dev/null; then
  NOTARY_AUTH_ARGS=(--key "$ASC_KEY_FILE" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")
  NOTARY_AUTH_DESC="ASC API key(env ASC_KEY_ID=${ASC_KEY_ID})"
else
  MISSING="${MISSING}N"
fi

if [ -n "$MISSING" ]; then
  echo "" >&2
  echo "ERROR: 前置不全,以下項目缺失:" >&2
  [[ "$MISSING" == *A* ]] && echo "  ✗ Developer ID Application cert(Keychain)" >&2
  [[ "$MISSING" == *I* ]] && echo "  ✗ Developer ID Installer cert(Keychain)" >&2
  [[ "$MISSING" == *N* ]] && echo "  ✗ notarytool 憑證(keychain profile '$NOTARY_PROFILE' 與 ASC API key env 均不可用)" >&2
  echo "" >&2
  echo "一次性設定:" >&2
  if [[ "$MISSING" == *A* ]] || [[ "$MISSING" == *I* ]]; then
    echo "  [1] 申請 Developer ID 兩張 cert(Apple Developer Portal):" >&2
    echo "      https://developer.apple.com/account/resources/certificates → +" >&2
    echo "      選 Developer ID Application + Software 子類型,上傳 CSR,下載 .cer 雙擊裝" >&2
    echo "      重複一次,改選 Developer ID Installer(每張 cert 要用各自獨立的 CSR)" >&2
  fi
  if [[ "$MISSING" == *N* ]]; then
    echo "  [2] notarytool keychain profile:" >&2
    echo "      到 https://appleid.apple.com「登入與安全性」→「App 專用密碼」產一支" >&2
    echo "      跑:" >&2
    echo "        xcrun notarytool store-credentials $NOTARY_PROFILE \\" >&2
    echo "          --apple-id 'jimmy.zm.su@gmail.com' \\" >&2
    echo "          --team-id 'PR6NG3PH45' \\" >&2
    echo "          --password '<上面那支 app-specific password>'" >&2
  fi
  exit 1
fi
echo "    ✓ Developer ID Application cert"
echo "    ✓ Developer ID Installer cert"
echo "    ✓ notarytool 憑證:$NOTARY_AUTH_DESC"

VERSION=$(jq -r '.version' shinkansen/manifest.json)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "ERROR: 無法從 manifest 讀 version。" >&2
  exit 1
fi
echo ""
echo "Building Developer ID notarized .pkg for version: $VERSION"
echo "(notarize 步驟等 Apple cloud,預估 ~30-60 分鐘,可背景跑)"

# 1. 同步 + bump pbxproj(跟 safari-build.sh 同邏輯,避免兩 script 版本 drift)
echo "==> Sync extension Resources..."
mkdir -p "$EXTENSION_RESOURCES"
rsync -a --delete shinkansen/ "$EXTENSION_RESOURCES/"

echo "==> Sync version to project.pbxproj..."
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${VERSION};/g" "$PBXPROJ"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = ${VERSION};/g" "$PBXPROJ"

# 2. clean + archive(本 script 獨立跑一次,不複用 safari-build.sh 的 archive)
echo "==> xcodebuild clean..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  clean

echo "==> xcodebuild archive..."
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  archive

# 3. exportArchive Developer ID → .app(注意:此 method 不產 .pkg,只產 .app)
echo "==> Export Developer ID .app..."
xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  -exportPath "$BUILD_DIR/safari-export-developerid" \
  -exportOptionsPlist "$EXPORT_OPTS_DEVID"

DEVID_APP="$BUILD_DIR/safari-export-developerid/Shinkansen.app"
if [ ! -d "$DEVID_APP" ]; then
  echo "ERROR: $DEVID_APP 不存在,Developer ID export 失敗。" >&2
  exit 1
fi

# 4. productbuild 把 .app 包進 installer .pkg + Developer ID Installer cert 簽
DEVID_PKG="build/shinkansen-macos-v${VERSION}.pkg"
# 刪除舊版 Developer ID .pkg(每次 bump 換版本號會留下舊檔累積)。
# 只清非 -mas 的版本檔,避免誤刪 MAS 軌的 -mas.pkg。
mkdir -p build && find build -maxdepth 1 -name 'shinkansen-macos-v*.pkg' ! -name '*-mas.pkg' -delete
echo "==> productbuild Developer ID .pkg(install 到 /Applications,Installer cert 簽)..."
productbuild \
  --component "$DEVID_APP" /Applications \
  --sign "$DEVID_INSTALLER_CERT" \
  "$DEVID_PKG"

# 5. notarize submit --wait(這步動輒 ~30-60 分鐘)
echo "==> Submit to Apple notarization service(等 Apple cloud)..."
echo "    Start: $(date +%H:%M:%S)"
xcrun notarytool submit "$DEVID_PKG" \
  "${NOTARY_AUTH_ARGS[@]}" \
  --wait
echo "    End:   $(date +%H:%M:%S)"

# 6. staple notarization ticket 進 pkg(離線可驗)
echo "==> Staple 公證 ticket 進 .pkg..."
xcrun stapler staple "$DEVID_PKG"

# 7. 驗證 stapled ticket + Gatekeeper 模擬
echo "==> 驗證..."
xcrun stapler validate "$DEVID_PKG"
spctl -a -t install -vv "$DEVID_PKG" 2>&1 | head -5

# 8. Source drift forcing function
echo "==> Source drift check..."
DRIFT=$(diff -r --brief shinkansen/ "$EXTENSION_RESOURCES/" 2>&1 || true)
if [ -n "$DRIFT" ]; then
  echo "ERROR: source drift between shinkansen/ and Resources/:" >&2
  echo "$DRIFT" >&2
  exit 1
fi

echo ""
echo "Done: $DEVID_PKG(已 notarize + stapled)"
echo ""
echo "發布到 GitHub Release(假設 v${VERSION} tag 已存在):"
echo "  gh release upload v${VERSION} $DEVID_PKG"
