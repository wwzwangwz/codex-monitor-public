# Codex Monitor Shared Protocol v7

This file is the cross-platform contract. Mac/mobile and Windows implementations may differ internally but must preserve these behaviors.

## Pairing

QR format:

```text
codex-monitor://pair?data=<base64url-json>
```

Payload:

```json
{
  "v": 1,
  "id": "machine-uuid",
  "name": "device-name",
  "wsUrl": "ws://192.168.1.8:43117/monitor",
  "token": "random-secret"
}
```

`v: 1` pairing keeps the original single `wsUrl` field and remains fully supported.

`v: 2` may add separate LAN and relay endpoints without changing the v1 fallback:

```json
{
  "v": 2,
  "id": "machine-uuid",
  "name": "device-name",
  "wsUrl": "ws://192.168.1.8:43117/monitor",
  "lanWsUrl": "ws://192.168.1.8:43117/monitor",
  "relayWsUrl": "wss://relay.example/relay/phone/machine-uuid",
  "token": "random-secret"
}
```

Mobile clients expose `自动`、`局域网`、`远程中继` per device. `自动` must prefer `lanWsUrl`/`wsUrl` and only fall back to `relayWsUrl`; `远程中继` is disabled when no relay endpoint exists. The existing `wsUrl` may be a LAN `ws://` endpoint or a future Internet relay `wss://` endpoint. Mobile clients must not assume that the computer is on the same network.

## Snapshot

```json
{
  "type": "snapshot",
  "machine": { "id": "machine-uuid", "name": "device-name" },
  "sentAt": "ISO-8601",
  "sessions": [
    {
      "id": "thread-uuid",
      "title": "task title",
      "updatedAt": "ISO-8601",
      "state": "running",
      "message": "latest visible work",
      "evidence": [
        {
          "id": "opaque-image-id",
          "name": "result.png",
          "mimeType": "image/png",
          "downloadPath": "/evidence/opaque-image-id"
        }
      ],
      "goal": {
        "status": "active",
        "objective": "goal objective"
      }
    }
  ]
}
```

`evidence` is optional and contains at most ten images explicitly referenced by the latest assistant work message. The visible `message` must omit local image Markdown and absolute image paths. Clients download each image from the paired computer's HTTP(S) origin using `downloadPath` plus the existing pairing token. The desktop serves only its current snapshot whitelist, accepts JPEG/PNG/WebP, returns `Cache-Control: private, no-store`, and never exposes arbitrary file paths. Mobile clients do not retain image history.

`message` carries the complete latest visible Codex work, completion, or
terminal-error text. Desktop endpoints must not truncate it to a fixed character
count or flatten its line breaks. Compact device/session lists may visually
ellipsize the value, but a scrollable session detail view must show the complete
received text. Clients do not persist it as conversation history; each snapshot
replaces the previous current value.

States:

- `running` / green: a task is active. Long reasoning and reconnectable stream errors stay green.
- `blocked` / red: execution stopped with a terminal error, or a Goal is explicitly blocked/limited.
- `completed` / blue: normal completion or idle.
- `unknown` / black: transport or source is unavailable after confirmation.

Changing work text does not trigger a notification. Only a lamp/state transition creates `NEW` and may notify while the mobile app is not active.

A live active turn is authoritative over a stale Goal database row. If Codex has
resumed or is visibly still executing, the state remains `running`; a Goal
`blocked`, `usage_limited`, or `budget_limited` state becomes red only after the
active turn has stopped.

Transport loss must be continuously unconfirmed for at least 20 seconds and include an active health probe before changing sessions to black.

## Guidance

Phone request:

```json
{
  "type": "guidance",
  "requestId": "uuid",
  "sessionId": "thread-uuid",
  "text": "继续",
  "mode": "steer",
  "attachments": [
    {
      "name": "problem-screenshot.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 123456,
      "dataBase64": "..."
    }
  ]
}
```

`mode` is `steer` or `queue`. The desktop must use the native Codex desktop turn input. `codex exec resume`, rollout writes, and shell interpolation are forbidden.

`attachments` is optional. Version 7 supports up to ten screenshot images per
request using `image/jpeg`, `image/png`, or `image/webp`. Each decoded image is
limited to 4 MiB and the decoded request total is limited to 24 MiB. A request
may contain text, images, or both; it must not be empty. Clients should resize
and compress large phone screenshots before Base64 encoding.

The desktop must authenticate and validate the complete request before writing
temporary files. It then targets and verifies the requested conversation ID,
adds every image through Codex's native attachment path, verifies all attachment
previews, inserts the text, and submits everything as one native Steer/Queue
message. If any image, text, navigation, identity check, or submission step
fails, the desktop must remove any draft content it inserted, return a failed
`guidance_result`, and must not submit a partial request or an unrelated
conversation. Temporary images are removed after native ingestion and are not
kept as Monitor history.

ACK means only that the desktop received the request:

```json
{
  "type": "guidance_ack",
  "requestId": "uuid",
  "sessionId": "thread-uuid",
  "message": "电脑端已收到，正在交给 Codex"
}
```

Final result:

```json
{
  "type": "guidance_result",
  "requestId": "uuid",
  "sessionId": "thread-uuid",
  "ok": true,
  "message": "native submission result"
}
```

## Goal Control

Mobile clients may request two explicit Goal operations:

```json
{
  "type": "goal_command",
  "requestId": "uuid",
  "sessionId": "thread-uuid",
  "command": "resume",
  "confirmed": false
}
```

`command` is `resume` or `delete`.

- `resume` has four explicit cases. A paused Goal may be restored to `active`
  even while its turn is running; this case must not send a duplicate Steer.
  An `active` Goal with an idle/stopped turn sends one native Steer to the same
  thread without rewriting Goal state. A blocked, usage-limited or
  budget-limited Goal may resume only after the turn has stopped: set it to
  `active`, then Steer the same thread, and roll back the previous Goal status
  if native delivery fails. Any non-paused Goal with a running turn rejects
  resume. No case may create a duplicate Goal or target another thread.
- `delete` removes only the Goal association after a mobile confirmation. It
  must not delete the Codex thread, rollout, worktree or user files.
- A `delete` request must carry `confirmed: true`; desktops reject an
  unconfirmed deletion even if a client UI is faulty.
- Desktops must use a supported native Codex Goal action. Direct ad-hoc SQLite
  mutation is forbidden while Codex is running.
- Both commands return `goal_command_ack` followed by `goal_command_result` with
  the same request ID, session ID, success flag and a visible result message.

## Internet Relay Direction

The relay uses TLS `wss://`. Computers connect outbound to `/relay/device/<machine-id>` and publish only current snapshots and guidance results. Phones connect to `/relay/phone/<machine-id>`. Both roles append the existing pairing token as the `token` query parameter. The relay stores no full conversation history; it keeps only the latest snapshot in memory for a short TTL.

The production relay may be mounted below an HTTPS path prefix. For example,
with a base of `wss://relay.example.com/codex-monitor`, the concrete device
and phone paths are `/codex-monitor/relay/device/<machine-id>` and
`/codex-monitor/relay/phone/<machine-id>`. Clients must preserve that prefix
when deriving the HTTPS `/push/register`, `/push/read`, `/evidence`, and
`/health` paths. They must also remain compatible with a relay mounted at the
domain root.

When a relay-connected phone downloads `/evidence/<opaque-image-id>`, the relay authenticates the pairing token and requests that image from the matching online computer's current evidence whitelist. The bytes are streamed back without relay disk storage or image caching. Missing, oversized, invalid or offline-device evidence returns an explicit HTTP failure.

### System push registration

After a phone obtains an actual FCM/APNs token, it may send the message below on its authenticated relay WebSocket. A phone currently using the LAN data path may POST the same JSON to `/push/register/<machine-id>?token=<pairing-token>` on the relay HTTPS origin, so LAN remains primary while system push acts as a background fallback.

```json
{
  "type": "push_registration",
  "platform": "android",
  "pushToken": "provider-issued-token",
  "enabled": true,
  "silentCompletionSessionIds": ["jarvis-thread-id"]
}
```

The relay returns `push_registration_result`. It must return `ok: false` when the matching provider is not configured. The first snapshot establishes a baseline and never pushes. Later work-text changes never push; only a state/lamp transition emits `lamp_changed`. A registered Jarvis session's `running -> completed` event carries `silent: true`; other transitions retain normal sound behavior. `enabled: false` unregisters that provider token.

Each delivered lamp transition remains pending in relay memory for that exact
provider token and session. Until the phone marks it read, the relay sends the
same event every 60 seconds with `reminder: true`; work-text changes still do
not create or refresh a reminder. Opening the session removes NEW locally and
POSTs the following authenticated JSON to
`/push/read/<machine-id>?token=<pairing-token>`:

```json
{
  "type": "push_read",
  "platform": "android",
  "pushToken": "provider-issued-token",
  "sessionId": "changed-thread-id",
  "state": "blocked"
}
```

The relay returns `push_read_result`. A read acknowledgement clears only that
phone token's reminder for that session when `state` still matches the unread
event; a late acknowledgement cannot erase a newer lamp transition. A later
lamp transition creates a new pending event. Pending reminders are memory-only
and disappear when the relay restarts; they are not notification history.

Long-term iPhone background notifications require APNs. A suspended iOS app cannot maintain an ordinary LAN WebSocket indefinitely. Relay authentication, device key rotation, end-to-end encryption and APNs credentials require a separate protocol version before public deployment.
