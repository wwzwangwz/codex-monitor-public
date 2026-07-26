#!/bin/zsh

set -euo pipefail

readonly BUILD_VOLUME="${CODEX_MONITOR_BUILD_VOLUME:-/Volumes/CodexMonitorBuild}"
readonly BUILD_ROOT="${BUILD_VOLUME}/CodexMonitorBuild"
readonly BUILD_STAMP="$(date +%Y%m%d-%H%M%S)"
readonly SCRIPT_DIR="${0:A:h}"
readonly IOS_DIR="${SCRIPT_DIR:h}"
readonly XCODE_ON_EXTERNAL="${BUILD_VOLUME}/Applications/Xcode.app/Contents/Developer"

if [[ ! -d "${BUILD_VOLUME}" || ! -w "${BUILD_VOLUME}" ]]; then
  print -u2 "Mac512 is not mounted or writable: ${BUILD_VOLUME}"
  exit 1
fi

if [[ -d "${XCODE_ON_EXTERNAL}" ]]; then
  export DEVELOPER_DIR="${XCODE_ON_EXTERNAL}"
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  print -u2 "Full Xcode is required. Install Xcode before running this script."
  exit 2
fi

mkdir -p "${BUILD_ROOT}/DerivedData" "${BUILD_ROOT}/Archives"

cd "${IOS_DIR}"
xcodebuild \
  -project CodexMonitorIOS.xcodeproj \
  -scheme CodexMonitorIOS \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -derivedDataPath "${BUILD_ROOT}/DerivedData" \
  -archivePath "${BUILD_ROOT}/Archives/CodexMonitorIOS-${BUILD_STAMP}.xcarchive" \
  archive

print "Archive directory: ${BUILD_ROOT}/Archives"
