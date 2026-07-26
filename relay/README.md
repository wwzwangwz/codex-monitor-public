# Codex Monitor 远程中继

这个服务为 Codex Monitor 提供可选的公网 WebSocket 转发。现有局域网连接保持默认且不受影响。

## 当前能力

- 电脑主动连接 `/relay/device/<设备 ID>`，手机连接 `/relay/phone/<设备 ID>`。
- 每台设备使用独立配对密钥，设备之间不能读取或控制彼此的通道。
- 转发当前会话快照、文字/图片 guidance、Goal 操作以及对应 ACK/result。
- 证据图片按需从当前在线电脑的白名单流式转发；中继不落盘、不缓存图片。
- 电脑离线时，手机操作会立即收到明确的失败结果。
- 只在内存中保留每台设备最近一个快照和当前未读灯色事件；未读事件每 60 秒重复推送，手机查看会话后通过 `/push/read/<设备ID>` 清除。进程重启全部清空，不保存聊天历史、图片或操作记录。

## 本机运行

要求 Node.js 20 或更高版本。

```bash
npm ci
export CODEX_MONITOR_RELAY_DEVICE_TOKENS='{"00000000-0000-4000-8000-000000000001":"替换为设备配对密钥"}'
export RELAY_HOST=127.0.0.1
export PORT=8080
npm start
```

Android 系统推送还需要 Firebase 服务账号 JSON，只能通过部署环境注入：

```bash
export CODEX_MONITOR_FCM_SERVICE_ACCOUNT="$(jq -c . /安全目录/firebase-service-account.json)"
```

未配置该变量时 Relay 会明确拒绝手机推送注册，不能假报成功。服务账号不得写入仓库、二维码或客户端。

iPhone APNs 使用 Apple Developer 创建的 `.p8` Push Notifications 密钥：

```bash
export CODEX_MONITOR_APNS_CREDENTIALS="$(jq -c . /安全目录/apns-credentials.json)"
```

开发真机测试把 `environment` 设为 `sandbox`，TestFlight/App Store 使用 `production`。APNs 私钥同样只能存在于 Relay 部署环境。

健康检查：`GET http://127.0.0.1:8080/health`。

## 公网部署要求

- 必须由 Caddy、Nginx 或云负载均衡器终止 TLS，对外只提供 `wss://`。
- `CODEX_MONITOR_RELAY_DEVICE_TOKENS` 必须是“设备 ID → 配对密钥”的 JSON 对象，不得提交到 Git。
- 反向代理需允许 WebSocket Upgrade，并把 `/relay/*`、`/push/*`、`/evidence/*` 和 `/health` 转发到本服务。
- 进程重启会清空全部快照，这是预期行为；本服务不应接数据库。
- 当前版本尚未完成 FCM/APNs 端到端接入，不能把普通 WebSocket 宣传为系统杀后台后的永久推送。
- 当前已具备 FCM HTTP v1 与 APNs HTTP/2 服务端发送器，但仍需创建 Firebase 项目、配置 Android 客户端并完成 vivo X80 真机后台验收；APNs 真机仍等待 Apple Developer 身份和推送密钥。

Caddy 示例：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 验证

```bash
npm test
```

测试覆盖鉴权、快照短期回放、设备隔离、guidance/result 转发及电脑离线失败。
