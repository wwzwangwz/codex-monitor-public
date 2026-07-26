# 安全说明

请勿在公开 Issue 中提交以下内容：

- `codex-monitor://` 完整配对码；
- WebSocket token、推送密钥、GitHub token 或任何 API 密钥；
- 真实 Codex 会话 ID、私人工作内容或未脱敏截图；
- 家庭/办公局域网 IP、设备名和本机绝对路径。

发现安全问题时，请先制作最小复现并脱敏。部署 Relay 时，FCM/APNs 凭据和设备 token 只能从运行环境注入，不能写入仓库或客户端。

Required Notice: Copyright © 2026 wwzwangwz. Commercial use and resale require separate prior written permission.
