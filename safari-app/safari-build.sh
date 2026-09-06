#!/usr/bin/env bash
# safari-build.sh — Build & archive macOS Safari Web Extension(MAS 軌)
#
# 用途:
#   把 shinkansen/ 同步進 Resources/、bump pbxproj 版本、跑 xcodebuild archive,
#   export 出 Mac App Store 上傳用的 .pkg。
#
#   產出: build/shinkansen-macos-v<version>-mas.pkg
#   用法: open -a Transporter build/shinkansen-macos-v<version>-mas.pkg
#
# 雙軌:本 script 只跑 MAS 軌(快,每次 release.sh 跑這條)。
#      Developer ID 公開下載 .pkg 走獨立的 safari-app/safari-build-devid.sh
#      (含 notarize,Apple cloud 動輒 ~30-60 分鐘,不適合綁進 release flow)。
#
# 需求:
#   - macOS + Xcode 15+
#   - jq 1.6+
#   - 3rd Party Mac Developer Application/Installer cert 已裝 Keychain
#   - safari-app/safari-export-options.plist 內 teamID 已填
#   - safari-app/Shinkansen/Shinkansen.xcodeproj 已存在(無則先跑 safari-bootstrap.sh)
#
# Source drift forcing function:
#   結束前跑 diff -r --brief shinkansen/ Resources/,non-empty 視為 drift,中止。

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_DIR="safari-app/Shinkansen"
PROJECT_FILE="$PROJECT_DIR/Shinkansen.xcodeproj"
PBXPROJ="$PROJECT_FILE/project.pbxproj"
EXTENSION_RESOURCES="$PROJECT_DIR/Shinkansen Extension/Resources"
EXPORT_OPTS="safari-app/safari-export-options.plist"
# v1.9.26: BUILD_DIR 改用 $TMPDIR(macOS /var/folders/.../T/)而非 safari-app/build。
# 原因:repo 在 ~/Documents/(iCloud Drive 同步範圍)內,xcodebuild signed bundle 寫進
# safari-app/build/ 後會被 iCloud fileprovider 接管成 root:wheel ownership,下次
# build 連 sudo rm -rf 都不一定清得掉(SIP / fileprovider 競態)。$TMPDIR 在 iCloud
# 同步範圍外,不會被接管。同根本 cause 的 JRead 專案已驗此修法。
BUILD_DIR="${TMPDIR%/}/shinkansen-build"

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi

if [ ! -d "$PROJECT_FILE" ]; then
  echo "ERROR: $PROJECT_FILE 不存在。" >&2
  echo "       請先跑 ./safari-app/safari-bootstrap.sh 產出 Xcode project。" >&2
  exit 1
fi

if [ ! -f "$EXPORT_OPTS" ]; then
  echo "ERROR: $EXPORT_OPTS 不存在。" >&2
  exit 1
fi

if grep -q "TEAMID_TBD" "$EXPORT_OPTS"; then
  echo "ERROR: $EXPORT_OPTS 內 teamID 仍是 TEAMID_TBD,請填入真實 Team ID(PR6NG3PH45)。" >&2
  exit 1
fi

VERSION=$(jq -r '.version' shinkansen/manifest.json)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "ERROR: 無法從 manifest 讀 version。" >&2
  exit 1
fi
echo "Building macOS Safari Extension for version: $VERSION (MAS 軌)"

# 1. 同步 shinkansen/ → Resources/(--delete 移除已不存在舊檔)
echo "==> Sync extension Resources..."
mkdir -p "$EXTENSION_RESOURCES"
rsync -a --delete shinkansen/ "$EXTENSION_RESOURCES/"

# 1.2 background → event page(scripts + persistent: false,保留 type: module)。
#     iOS Safari 的 MV3 SW 被系統回收後不再喚醒(Apple Forums thread 758346);
#     macOS Safari 雖未觀察到同等死透行為,但 event page 是 WebKit 原生偏好的
#     background 形式,兩平台統一宣告避免 lifecycle 差異。Chrome 版 manifest
#     (shinkansen/)維持 service_worker 不動。drift check(步驟 6)排除 manifest。
#     詳見 safari-app/patch-manifest-background.sh(macOS / iOS build 共用)。
echo "==> Patch manifest background → event page..."
bash safari-app/patch-manifest-background.sh "$EXTENSION_RESOURCES/manifest.json"

# 1.5 MAS build override:strip update-check banner 整套路徑
# 為什麼:Apple Review Guideline 2.3.10 不准 app 內引導使用者到 App Store 外
# 下載 app;且同 Bundle ID(app.shinkansen.macos)使用者點 banner 載
# Developer ID .pkg 雙擊會覆蓋 MAS 安裝,從此 MAS 不再自動更新。
# 詳見 shinkansen/lib/distribution.js 註解。drift check(步驟 6)排除兩檔。
# 兩檔分別給 ES module(popup / options / background)跟 content script 用,
# 值必須同步。
echo "==> Override distribution{,-cs}.js → IS_MAS_BUILD=true(strip update-check for MAS)..."
cat > "$EXTENSION_RESOURCES/lib/distribution.js" <<'EOF'
// distribution.js — MAS build override(由 safari-app/safari-build.sh 寫入,不要編輯)
// 原檔見 shinkansen/lib/distribution.js,預設 false。
// 注意：兩個 export 都必須寫出（popup / options import 兩者，少一個 import 直接炸）。
export const IS_MAS_BUILD = true;
export const IS_IOS_BUILD = false;
EOF
cat > "$EXTENSION_RESOURCES/lib/distribution-cs.js" <<'EOF'
// distribution-cs.js — MAS build override(由 safari-app/safari-build.sh 寫入,不要編輯)
// 原檔見 shinkansen/lib/distribution-cs.js,預設 false。值必跟 distribution.js 同步。
if (window.__SK) {
  window.__SK.IS_MAS_BUILD = true;
  window.__SK.IS_IOS_BUILD = false;
}
EOF

# 2. 版本號同步進 pbxproj
echo "==> Sync version to project.pbxproj..."
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${VERSION};/g" "$PBXPROJ"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = ${VERSION};/g" "$PBXPROJ"

# 3. clean 舊 build artifacts
echo "==> xcodebuild clean..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  clean

# 4. archive
echo "==> xcodebuild archive..."
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  archive

# 5. exportArchive MAS → -mas.pkg
echo "==> Export MAS .pkg..."
xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  -exportPath "$BUILD_DIR/safari-export-mas" \
  -exportOptionsPlist "$EXPORT_OPTS"

MAS_PKG="build/shinkansen-macos-v${VERSION}-mas.pkg"
# 刪除舊版 MAS .pkg(每次 bump 換版本號會留下舊檔累積)。新檔此刻仍在
# $BUILD_DIR,先清空 safari-app/ 內所有 -mas.pkg 再 mv 進新版。
rm -f build/shinkansen-macos-v*-mas.pkg
mv "$BUILD_DIR/safari-export-mas/Shinkansen.pkg" "$MAS_PKG"

# 6. Source drift forcing function
# 排除 lib/distribution.js + lib/distribution-cs.js — MAS build 故意把它們
# override 成 IS_MAS_BUILD=true,跟 shinkansen/ 原檔的 false 必定不同,
# 這是預期 drift(見步驟 1.5)。
echo "==> Source drift check(排除 lib/distribution*.js 預期 override + manifest 預期 patch)..."
# manifest.json 排除理由:步驟 1.2 的 event page patch 是預期受控差異,
# 由 patch-manifest-background.sh(冪等)重跑 verify 補上 manifest 檢查。
DRIFT=$(diff -r --brief shinkansen/ "$EXTENSION_RESOURCES/" 2>&1 | grep -vE "lib/distribution(-cs)?\.js|manifest\.json" || true)
if [ -n "$DRIFT" ]; then
  echo "ERROR: source drift between shinkansen/ and Resources/:" >&2
  echo "$DRIFT" >&2
  exit 1
fi
bash safari-app/patch-manifest-background.sh "$EXTENSION_RESOURCES/manifest.json"

echo ""
echo "Done: $MAS_PKG"
echo ""
echo "MAS 上架:"
echo "  open -a Transporter $MAS_PKG"
echo ""
echo "要發 Developer ID 公開下載版(notarize 等 Apple cloud ~30-60 分鐘):"
echo "  ./safari-app/safari-build-devid.sh"
