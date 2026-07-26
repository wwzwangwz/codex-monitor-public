#!/bin/zsh

set -euo pipefail

readonly BUILD_VOLUME="${CODEX_MONITOR_BUILD_VOLUME:-/Volumes/CodexMonitorBuild}"
readonly BUILD_ROOT="${BUILD_VOLUME}/CodexMonitorBuild/Desktop"
readonly SCRIPT_DIR="${0:A:h}"
readonly DESKTOP_DIR="${SCRIPT_DIR:h}"

if [[ ! -d "${BUILD_VOLUME}" || ! -w "${BUILD_VOLUME}" ]]; then
  print -u2 "Mac512 is not mounted or writable: ${BUILD_VOLUME}"
  exit 1
fi

mkdir -p "${BUILD_ROOT}/cache/electron" "${BUILD_ROOT}/cache/electron-builder"
export ELECTRON_CACHE="${BUILD_ROOT}/cache/electron"
export ELECTRON_BUILDER_CACHE="${BUILD_ROOT}/cache/electron-builder"
export CODEX_MONITOR_RELEASE_CHANNEL="${CODEX_MONITOR_RELEASE_CHANNEL:-stable}"

cd "${DESKTOP_DIR}"
npm test
node scripts/check-mac-signing.js
npx electron-builder \
  --mac dmg zip \
  --config.directories.output="${BUILD_ROOT}/releases"

print "Mac desktop build output: ${BUILD_ROOT}"
