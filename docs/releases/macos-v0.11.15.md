# Codex Monitor macOS 0.11.15（预发布）

这是面向普通用户的一键安装包。推荐下载与 Mac 处理器对应的 DMG：

- Apple 芯片 Mac（M1、M2、M3、M4 等）：`Codex-Monitor-macOS-arm64-v0.11.15.dmg`
- Intel Mac：`Codex-Monitor-macOS-x64-v0.11.15.dmg`
- ZIP 是同一应用的备用分发格式，普通用户优先使用 DMG。

## 安装

1. 下载对应架构的 DMG 并打开。
2. 将 `Codex Monitor.app` 拖入“应用程序”。
3. 当前构建没有 Apple Developer ID 和 Apple 公证。首次打开时请在 Finder 中按住 Control 点击应用并选择“打开”；如仍被阻止，请前往“系统设置 → 隐私与安全性”选择“仍要打开”。

## 主要功能

- 选择并监控本机 Codex 会话，向 Android 手机同步状态灯、最近工作内容、Goal 状态和证据图片。
- 手机扫码配对后可通过原生 Steer/Queue 通道发送文字与图片引导。
- 保留稳定局域网连接，可选远程中继保持为增量功能。
- 内置 Android 0.11.22 更新安装包与更新清单。

## 验证

- 对应源码提交：`0cbcff32a6a9b33e54175de387479139a02ffe71`
- Desktop 测试：111/111 通过。
- Relay 测试：15/15 通过。
- 生产依赖审计：0 个已知漏洞。
- Apple Silicon 与 Intel 的 DMG、ZIP、包标识、版本、处理器架构、内部源码一致性和隐私扫描均已核验。
- 当前仅使用 ad-hoc 签名，没有 Developer ID、Team ID 或 Apple 公证，因此标记为 Pre-release；本版本不承诺自动更新或继承其他签名版本的 macOS 权限。

## SHA-256

```text
b499825d38e0b791bc5844e37791eb22909f7dd233954e3e26896e13bcd910e8  Codex-Monitor-macOS-arm64-v0.11.15.dmg
f87921a2d36e743c36e5782c5fa0cf48e0c710a52c8db8c43e27c148563dedba  Codex-Monitor-macOS-arm64-v0.11.15.zip
c16f69d33655d33e1bb6620cdd792df2a93c3b321ead6254a873130800ded3f4  Codex-Monitor-macOS-x64-v0.11.15.dmg
8fbebd713fce51879e12c61a664ca11273c4f6864a8e22ce472e1e1fddea53ce  Codex-Monitor-macOS-x64-v0.11.15.zip
```

完整源码由本 Release 的 Source code 附件提供。项目采用 AGPL-3.0-only，使用、修改或分发时请同时遵守 `LICENSE` 和 `NOTICE`。
