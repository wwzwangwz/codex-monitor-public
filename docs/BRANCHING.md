# Branch Ownership

## Branch model

The public repository keeps mobile/macOS and Windows implementations on
long-lived platform branches. Shared protocol changes are documented before
either implementation changes. No branch contains a real controller device ID,
pairing credential, private task document, or physical-device validation log.

Codex Monitor uses long-lived platform branches because Mac/mobile and Windows have different implementations, test environments, and release artifacts.

## `main`

`main` contains the macOS, Android, unfinished iOS and Relay source, together
with shared product contracts:

- `docs/PROTOCOL.md`
- status/lamp semantics
- QR and WebSocket message schemas
- relay/APNs architecture decisions
- cross-platform release requirements

## `windows`

Responsibilities:

- Windows desktop companion
- Windows Codex session/Goal parsing
- Windows Codex native Steer/Queue adapter
- firewall, startup, installer, portable EXE and real Windows testing
- Windows-specific bugs

Windows never builds, signs, packages, or publishes Android/iOS artifacts.

## Requirement Flow

1. A requirement affecting only one platform is implemented and tested on that platform branch.
2. A requirement affecting QR, wire messages, status semantics, relay or notification contracts is documented on `main` first.
3. Both platform branches merge the `main` contract and implement it independently.
4. A platform does not merge the other platform's implementation commits merely to obtain a protocol change.
5. Each release records its supported `statusProtocolVersion` and relevant release notes.

## Synchronization Commands

Windows:

```powershell
git switch windows
git fetch origin
git merge origin/main
```

Do not force-push `main` or `windows`.
