#!/bin/sh
# Build DSHNotifier.app — the notification helper that carries DeepSeek
# Harness's icon and turns a click into "activate DeepSeek Harness".
#
#   sh scripts/build-helper.sh [output.app] [icon.icns]
#
# Defaults install into the DSH state directory so the plugin can find it.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"${DSH_HOME:-$HOME/.dsh}/dsh-mac-notify/DSHNotifier.app"}
ICON=${2:-"/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns"}

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found: install the Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O -o "$OUT/Contents/MacOS/DSHNotifier" "$ROOT/helper/DSHNotifier.swift" \
  -framework Cocoa -framework UserNotifications
cp "$ROOT/helper/Info.plist" "$OUT/Contents/Info.plist"
if [ -f "$ICON" ]; then
  cp "$ICON" "$OUT/Contents/Resources/AppIcon.icns"
else
  echo "warning: icon not found at $ICON; the helper keeps a generic icon" >&2
fi
codesign --force --deep --sign - "$OUT" >/dev/null 2>&1 || true
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$OUT" >/dev/null 2>&1 || true
echo "built $OUT"
