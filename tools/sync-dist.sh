#!/usr/bin/env bash
# sync-dist.sh — release 後把 GitHub Release 全部資產 + source 壓縮檔同步到本機 dist/
#
# 規則(2026-08-20 Jimmy 指示):每次 release 後 dist/ 只保留最新版——先整個清掉再下載,
# 舊版檔案一律刪除。dist/ 在 .gitignore 內,不入 repo(GitHub Release 本身就是備份)。
#
# 用法:
#   tools/sync-dist.sh              # 版本讀 shinkansen/manifest.json
#   tools/sync-dist.sh v2.3.3      # 指定版本
#
# release.sh 尾端自動呼叫;也可手動補跑。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(python3 -c "import json; print(json.load(open('shinkansen/manifest.json'))['version'])")}"
VERSION="v${VERSION#v}"

# 等 GitHub Release 出現(由 Actions release workflow 建立;最多輪詢 5 分鐘)
FOUND=0
for i in $(seq 1 30); do
  if gh release view "${VERSION}" >/dev/null 2>&1; then FOUND=1; break; fi
  sleep 10
done
if [ "${FOUND}" != "1" ]; then
  echo "❌ GitHub Release ${VERSION} 5 分鐘內沒出現,稍後手動補跑:tools/sync-dist.sh ${VERSION}"
  exit 1
fi

# 只保留最新版:先清空再下載
rm -rf dist
mkdir -p dist

# 全部 release 資產(chrome / firefox / firefox-source zip + macOS DevID pkg 等)
gh release download "${VERSION}" --dir dist --pattern '*'
# source 壓縮檔(GitHub 自動產生的 Source code zip)
gh release download "${VERSION}" --dir dist --archive=zip

echo ""
echo "dist/ 已同步為 ${VERSION}(舊版已清除):"
ls -lh dist
