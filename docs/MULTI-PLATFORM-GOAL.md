# Codex Monitor Multi-Platform Goal

This is the public cross-platform roadmap. Private requirement ledgers,
physical-device identifiers and user validation logs are intentionally not
published.

## Non-Negotiable Product Rules

- Preserve the stable LAN path. Remote connectivity is additive and switchable.
- Notify only when a session lamp changes. Work-text changes never notify.
- Keep a live active turn green even when an older Goal row says blocked.
- Mark a computer black only after at least 20 seconds without transport and a
  failed active health check.
- Use native Codex Steer/Queue. Never use `codex exec resume`, rollout mutation,
  or a second model turn for guidance.
- Mac is the primary controller. Windows owns only Windows implementation and
  real Windows validation.

## Phase 1: Reliable Communication

Mac/mobile owner:

- keep Mac controller pairing, remote snapshots and Steer/Queue results visible
- make ACK and final result distinguishable in every mobile and desktop UI
- keep Android monitoring alive in the background and suppress false offline
- notify outside the app on lamp changes; inside the app use sound plus NEW

Windows owner:

- finish the current status/heartbeat Bug repair without abandoning it
- make native Steer and Queue work for selected sessions present in Codex
- return useful `guidance_ack` and `guidance_result` errors
- verify Mac controller -> Windows Codex on a real Windows machine

Exit criteria: a Mac Steer reaches the intended Windows session, Windows shows
the instruction, and Mac receives a successful final result without changing an
unrelated session.

## Phase 2: Goal Controls

- add `resume` for an explicitly blocked Goal
- add `delete` with an explicit confirmation step
- expose controls on Android, iPhone, Mac and Windows where applicable
- keep Goal state precedence subordinate to a visibly active turn
- test normal tasks, active Goals, blocked Goals and stale blocked Goal rows

Exit criteria: Android and iPhone can resume and delete a Windows or Mac Goal,
with desktop execution and final result visible to the user.

## Phase 3: Mobile Parity

Android:

- preserve version 0.8.4 background monitoring, unread reminders and updater
- add Goal controls without regressing the notification rules
- Android `0.11.0` also accepts v2 LAN/relay pairing and keeps LAN first; it has no deployed public relay yet.

iPhone current baseline:

- native SwiftUI app and shared protocol v4 are implemented
- QR pairing, multiple devices, four lamps, NEW, recent content and Steer/Queue
  are implemented
- LAN and relay endpoints are independent and selectable
- seven protocol tests pass on macOS

iPhone remaining work:

- install full Xcode on `/Volumes/CodexMonitorBuild/Applications/Xcode.app`
- select the user's Apple Developer Team and run on a physical iPhone
- validate Mac and Windows pairing, notification permissions and guidance
- archive to `/Volumes/CodexMonitorBuild/CodexMonitorBuild`
- distribute with TestFlight before App Store review

Exit criteria: the same Mac and Windows sessions can be monitored and guided
from real Android and iPhone devices with matching lamp semantics.

## Phase 4: Optional Remote Connectivity

- retain direct LAN as the default and fallback
- allow a TLS relay such as `wss://relay.example.com/codex-monitor` as a
  separate, optional endpoint
- store no conversation history; retain only short-lived current state
- add device key rotation, authentication and end-to-end security review
- use APNs for reliable long-term iPhone background notification
- keep remote controls disabled when a pairing has no relay endpoint

Exit criteria: users can switch LAN/automatic/remote without breaking existing
LAN pairings, and iPhone receives an APNs lamp-change notification while the app
is suspended.

## Phase 5: Release

- Windows publishes tested EXE/installer and source from `windows`
- Mac/Android/iPhone publish from `mac-ios-android`
- large installers use GitHub Releases; source and contracts stay in Git
- complete TestFlight, privacy disclosure, screenshots and App Store review
- record supported protocol version and release notes for every client

## Progress Reporting

Each platform reports: current phase, current task, blockers, tests run, artifact
paths and pushed commit SHA. Do not mark the shared Goal complete while any exit
criterion remains unverified.
