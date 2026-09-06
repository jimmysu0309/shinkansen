#!/usr/bin/env bash
# safari-build-ios.sh — Build & archive iOS Safari Web Extension(App Store 軌)
#
# 用途:
#   把 shinkansen/(排除 translate-doc/)同步進 iOS project Resources/、
#   patch manifest、bump pbxproj 版本、跑 xcodebuild archive,export 出
#   App Store 上傳用的 .ipa。
#
#   產出: build/shinkansen-ios-v<version>.ipa
#   上傳: xcrun altool --upload-app -f <ipa> -t ios \
#           --apiKey $ASC_KEY_ID --apiIssuer $ASC_ISSUER_ID
#
# iOS 跟 macOS build 的差異(SPEC-PRIVATE §26):
#   1. 排除 translate-doc/(iOS 不做 PDF 翻譯)+ manifest 同步 patch
#   2. 簽名走手動 App Store profiles(SPEC-PRIVATE §26.5 第 4 條)
#   3. 產 .ipa 不產 .pkg
#
# 需求:
#   - macOS + Xcode 15+ / jq
#   - Apple Distribution cert 已裝 Keychain
#   - 「Shinkansen iOS App Store」+「Shinkansen iOS Ext App Store」兩張
#     provisioning profile 已裝(過期重開見 SPEC-PRIVATE §26.5)
#   - safari-app/Shinkansen-iOS/ 已存在(無則先跑 safari-bootstrap-ios.sh)
#
# Source drift forcing function:
#   結束前 diff staging source vs Resources/,non-empty 視為 drift,中止。

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_DIR="safari-app/Shinkansen-iOS/Shinkansen"
PROJECT_FILE="$PROJECT_DIR/Shinkansen.xcodeproj"
PBXPROJ="$PROJECT_FILE/project.pbxproj"
EXTENSION_RESOURCES="$PROJECT_DIR/Shinkansen Extension/Resources"
STAGING="${TMPDIR%/}/shinkansen-ios-build-src"
# BUILD_DIR 走 $TMPDIR 避開 iCloud Drive fileprovider 接管(SPEC-PRIVATE §23.14)
BUILD_DIR="${TMPDIR%/}/shinkansen-ios-build"

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi
if [ ! -d "$PROJECT_FILE" ]; then
  echo "ERROR: $PROJECT_FILE 不存在,先跑 ./safari-app/safari-bootstrap-ios.sh" >&2
  exit 1
fi

VERSION=$(jq -r '.version' shinkansen/manifest.json)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "ERROR: 無法從 manifest 讀 version。" >&2
  exit 1
fi
echo "Building iOS Safari Extension for version: $VERSION(App Store 軌)"

# 1. staging:排除 translate-doc/ + manifest patch
echo "==> Staging iOS source(exclude translate-doc/)..."
rm -rf "$STAGING"; mkdir -p "$STAGING"
rsync -a --exclude 'translate-doc/' shinkansen/ "$STAGING/"
jq '(.web_accessible_resources[]?.resources) |= map(select(. != "translate-doc/*"))' \
  "$STAGING/manifest.json" > "$STAGING/manifest.json.tmp"
mv "$STAGING/manifest.json.tmp" "$STAGING/manifest.json"
# 1.5 background → event page(scripts + persistent: false,保留 type: module)。
#     iOS Safari 的 MV3 SW 被系統回收後不再喚醒(Apple Forums thread 758346),
#     「用一段時間後四指 / popup 失效」根因;event page 卸載後可正常重生。
#     詳見 safari-app/patch-manifest-background.sh(macOS / iOS build 共用)。
#     在 staging 端 patch → 之後 rsync 進 Resources,drift check 自然一致。
bash safari-app/patch-manifest-background.sh "$STAGING/manifest.json"

# 1.6 Phase 2（SPEC-PRIVATE §26.12）：注入 nativeMessaging 權限（Safari only）。
#     host app 設定橋接靠 browser.runtime.sendNativeMessage,Safari 需此權限。
#     只在 Safari build 注入,不寫進 shinkansen/manifest.json —— Chrome / Firefox 宣告
#     nativeMessaging 會跳「與原生應用程式通訊」安裝警告,Safari 則不會跳 prompt。
#     冪等:已有就不重複加。
jq '.permissions |= (if index("nativeMessaging") then . else . + ["nativeMessaging"] end)' \
  "$STAGING/manifest.json" > "$STAGING/manifest.json.tmp"
mv "$STAGING/manifest.json.tmp" "$STAGING/manifest.json"

# 2. 同步 staging → Resources/(--delete 移除已不存在舊檔)
echo "==> Sync extension Resources..."
mkdir -p "$EXTENSION_RESOURCES"
rsync -a --delete "$STAGING/" "$EXTENSION_RESOURCES/"

# 2.5 App Store build override:strip update-check banner 整套路徑
#     (同 macOS MAS 軌,理由見 shinkansen/lib/distribution.js 註解;
#      iOS 全平台都走 App Store,無 Developer ID 通路,必為 true)
echo "==> Override distribution{,-cs}.js → IS_MAS_BUILD=true + IS_IOS_BUILD=true..."
cat > "$EXTENSION_RESOURCES/lib/distribution.js" <<'EOF'
// distribution.js — iOS App Store build override（由 safari-app/safari-build-ios.sh 寫入，不要編輯）
// 原檔見 shinkansen/lib/distribution.js,預設 false。
// IS_IOS_BUILD=true：popup / options 加 body.runtime-ios（隱藏 PDF 翻譯入口、
// 顯示 iOS 專屬說明）；content-touch.js 四指 tap 啟用。
// 注意：兩個 export 都必須寫出（popup / options import 兩者，少一個 import 直接炸）。
export const IS_MAS_BUILD = true;
export const IS_IOS_BUILD = true;
EOF
cat > "$EXTENSION_RESOURCES/lib/distribution-cs.js" <<'EOF'
// distribution-cs.js — iOS App Store build override（由 safari-app/safari-build-ios.sh 寫入，不要編輯）
// 原檔見 shinkansen/lib/distribution-cs.js,預設 false。值必跟 distribution.js 同步。
if (window.__SK) {
  window.__SK.IS_MAS_BUILD = true;
  window.__SK.IS_IOS_BUILD = true;
}
EOF

# 3. 版本號同步進 pbxproj
echo "==> Sync version to project.pbxproj..."
# MARKETING_VERSION（= CFBundleShortVersionString）Apple 限制最多三段。manifest 可能掛
# dev tail（§1.6,四段 1.10.40.1 → reload 後一眼識別跑的是 working tree）→ MARKETING 取
# 前三段(cut -f1-3),四段 dev tail build 的 marketing version 仍合法(= 上一個正式三段)。
MARKETING_VER=$(echo "$VERSION" | cut -d. -f1-3)
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${MARKETING_VER};/g" "$PBXPROJ"
# build number（CFBundleVersion,允許四段）必須比同一 marketing version 上一次上傳更高。
# 預設 = VERSION:dev tail 四段(1.10.40.1)天生就比正式三段(1.10.40)大 → 重出測試 build 免手動
# 覆寫;正式 release 三段時 = MARKETING 同值亦可(首次上傳)。仍可傳 BUILD_VER 覆寫。
BUILD_VER="${BUILD_VER:-$VERSION}"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = ${BUILD_VER};/g" "$PBXPROJ"

# 4. clean + archive
echo "==> xcodebuild archive..."
rm -rf "$BUILD_DIR"; mkdir -p "$BUILD_DIR"
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  archive

# 5. exportArchive → .ipa
echo "==> Export App Store .ipa..."
cat > "$BUILD_DIR/export-options.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>PR6NG3PH45</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>app.shinkansen.ios</key><string>Shinkansen iOS App Store</string>
    <key>app.shinkansen.ios.Extension</key><string>Shinkansen iOS Ext App Store</string>
  </dict>
</dict>
</plist>
EOF
xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  -exportPath "$BUILD_DIR/export" \
  -exportOptionsPlist "$BUILD_DIR/export-options.plist"

IPA="build/shinkansen-ios-v${VERSION}.ipa"
rm -f build/shinkansen-ios-v*.ipa
mv "$BUILD_DIR/export/Shinkansen.ipa" "$IPA"

# 6. Source drift forcing function
#    排除 lib/distribution{,-cs}.js — 預期 override(見步驟 2.5)。
echo "==> Source drift check..."
DRIFT=$(diff -r --brief "$STAGING/" "$EXTENSION_RESOURCES/" 2>&1 | grep -vE "lib/distribution(-cs)?\.js" || true)
if [ -n "$DRIFT" ]; then
  echo "ERROR: source drift between staging and Resources/:" >&2
  echo "$DRIFT" >&2
  exit 1
fi

echo ""
echo "Done: $IPA"
echo ""
echo "上傳 App Store Connect / TestFlight:"
echo "  xcrun altool --upload-app -f $IPA -t ios --apiKey \$ASC_KEY_ID --apiIssuer \$ASC_ISSUER_ID"
