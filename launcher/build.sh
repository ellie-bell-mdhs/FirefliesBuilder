#!/bin/bash
# Build the MeetingBuildBot launcher .app and install it into the menu-bar apps folder
# so applicationManager can discover and toggle it. Mirrors the convention used by the
# sibling Swift apps (caffeinated/applicationManager): swiftc → assemble bundle →
# PlistBuddy-patch keys → ad-hoc codesign.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"          # <repo>/launcher
APP_NAME="MeetingBuildBot"
EXEC_NAME="MeetingBuildBot"
BUILD_DIR="$ROOT/build"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
DEST="$HOME/Projects/menuBarApplications/$APP_NAME.app"

XCODE_DEV="/Applications/Xcode.app/Contents/Developer"
if ! xcode-select -p &>/dev/null; then
    if [[ -d "$XCODE_DEV" ]]; then
        export DEVELOPER_DIR="$XCODE_DEV"
    else
        echo "Error: Apple developer tools are not installed (need swiftc)."
        echo "Install Xcode from the App Store, or run: xcode-select --install"
        exit 1
    fi
fi

echo "Building $APP_NAME launcher..."
rm -rf "$BUILD_DIR"
mkdir -p "$MACOS_DIR"

swiftc -O -o "$MACOS_DIR/$EXEC_NAME" "$ROOT/MeetingBuildBot.swift" -framework AppKit

cp "$ROOT/Info.plist" "$CONTENTS_DIR/Info.plist"
PLIST="$CONTENTS_DIR/Info.plist"
for key_value in \
    "CFBundleExecutable:$EXEC_NAME" \
    "CFBundleIdentifier:com.meetingbuildbot.app" \
    "CFBundleName:$APP_NAME" \
    "LSMinimumSystemVersion:13.0"; do
    key="${key_value%%:*}"
    value="${key_value#*:}"
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$PLIST" 2>/dev/null || \
        /usr/libexec/PlistBuddy -c "Add :$key string $value" "$PLIST"
done

# Ad-hoc codesign with a stable identifier so LaunchServices/NSRunningApplication
# identity is consistent (matches how chatterBot signs).
codesign --force --sign - --identifier com.meetingbuildbot.app "$APP_DIR" || true

# Install into the menu-bar apps folder applicationManager scans.
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$APP_DIR" "$DEST"

echo "Built:     $APP_DIR"
echo "Installed: $DEST"
echo "Toggle it on in applicationManager."
