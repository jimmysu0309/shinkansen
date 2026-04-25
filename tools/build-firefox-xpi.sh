#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/shinkansen"
DIST_DIR="$ROOT_DIR/dist"
TMP_DIR="$DIST_DIR/.firefox-build"

if [[ ! -d "$EXT_DIR" ]]; then
  echo "Error: extension directory not found: $EXT_DIR" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip command not found. Please install zip first." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node command not found. Please install Node.js first." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git command not found. Please install git first." >&2
  exit 1
fi

RAW_GIT_VERSION="$(git -C "$ROOT_DIR" describe --always --dirty --tags)"
VERSION="${RAW_GIT_VERSION#v}"
if [[ -z "$VERSION" ]]; then
  echo "Error: failed to read version from git describe output." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
OUT_FILE="$DIST_DIR/shinkansen-firefox-local-${VERSION}.xpi"
rm -f "$OUT_FILE"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

cp -R "$EXT_DIR/." "$TMP_DIR/"

# Firefox stable/ESR may reject MV3 service_worker. Bundle background.js into one
# classic script and switch manifest background to scripts[] for local install.
BUNDLE_OUT="$TMP_DIR/background.firefox.js"
if command -v esbuild >/dev/null 2>&1; then
  esbuild "$EXT_DIR/background.js" --bundle --platform=browser --format=iife --outfile="$BUNDLE_OUT"
elif command -v npx >/dev/null 2>&1; then
  npx --yes esbuild "$EXT_DIR/background.js" --bundle --platform=browser --format=iife --outfile="$BUNDLE_OUT"
else
  echo "Error: esbuild/npx not found. Install esbuild or npm (for npx)." >&2
  exit 1
fi

node -e '
const fs = require("fs");
const p = process.argv[1];
const version = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.version = version;
m.background = { scripts: ["background.firefox.js"] };
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$TMP_DIR/manifest.json" "$VERSION"

(
  cd "$TMP_DIR"
  zip -qr "$OUT_FILE" . -x "*.DS_Store" "*/.DS_Store"
)

SIZE="$(du -h "$OUT_FILE" | awk '{print $1}')"
echo "Built: $OUT_FILE ($SIZE)"
