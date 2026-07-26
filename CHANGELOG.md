# Windows 更新日志

Windows 安装文件、完整版本说明和 SHA-256 校验值统一发布在 [GitHub Releases](https://github.com/wwzwangwz/codex-monitor-public/releases)。

## 待发布

- 项目许可证由 PolyForm Noncommercial 1.0.0 迁移为 `AGPL-3.0-only`，正式允许商业使用，同时要求保留署名、公开分发版本源码，并覆盖修改后的网络服务。
- 新增 `NOTICE`、`CITATION.cff`、中文许可证说明和统一发布门禁。

## Windows 0.8.10 — Pre-release

### 当前能力

- Windows Codex 会话选择、状态监控和手机扫码配对。
- 原生 Steer 当前轮与 Queue 下一轮，不使用 `codex exec resume`。
- Goal 状态、恢复、重启和删除协议。
- 手机与电脑之间的文字、截图和证据图片通道。
- 局域网优先，并保留可选远程 Relay。

### 待验收

- 必须在真实 Windows 设备重新构建净化后的安装版和便携版。
- 必须完成安装、更新、Steer/Queue、Goal、双向图片和断线恢复验收。
- 完成前不得标记为 Stable 或 Latest。
