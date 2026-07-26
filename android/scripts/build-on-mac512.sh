#!/bin/zsh

set -euo pipefail

readonly BUILD_VOLUME="${CODEX_MONITOR_BUILD_VOLUME:-/Volumes/CodexMonitorBuild}"
readonly BUILD_ROOT="${BUILD_VOLUME}/CodexMonitorBuild/Android"
readonly SCRIPT_DIR="${0:A:h}"
readonly ANDROID_DIR="${SCRIPT_DIR:h}"
readonly DETECTED_ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${HOME}/Library/Android/sdk}}"

if [[ ! -d "${BUILD_VOLUME}" || ! -w "${BUILD_VOLUME}" ]]; then
  print -u2 "Mac512 is not mounted or writable: ${BUILD_VOLUME}"
  exit 1
fi

if [[ ! -f "${DETECTED_ANDROID_SDK}/platforms/android-36/android.jar" ]]; then
  print -u2 "Android SDK 36 was not found: ${DETECTED_ANDROID_SDK}"
  exit 2
fi

export ANDROID_HOME="${DETECTED_ANDROID_SDK}"
export ANDROID_SDK_ROOT="${DETECTED_ANDROID_SDK}"

mkdir -p "${BUILD_ROOT}/gradle-home" "${BUILD_ROOT}/project-cache" "${BUILD_ROOT}/outputs"

cd "${ANDROID_DIR}"
GRADLE_USER_HOME="${BUILD_ROOT}/gradle-home" ./gradlew \
  --project-cache-dir "${BUILD_ROOT}/project-cache" \
  -PcodexBuildRoot="${BUILD_ROOT}/build" \
  test assembleRelease

find "${BUILD_ROOT}/build/app/outputs/apk/release" -name 'app-release.apk' -exec cp {} "${BUILD_ROOT}/outputs/" \;
print "Android build output: ${BUILD_ROOT}"
