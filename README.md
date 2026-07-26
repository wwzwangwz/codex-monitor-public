# Codex Monitor for Windows

这是 Codex Monitor 的 Windows 独立开发分支，包含 Windows 桌面伴侣、Codex 原生 Steer/Queue 适配、Goal 控制、局域网/可选 Relay、安装包和更新验证源码。

## 当前状态

- 源码版本：0.8.10。
- 自动化测试和 GitHub Actions 构建已建立。
- 物理 Windows 设备尚未完成 0.8.10 全量验收，因此构建只能标记为 Pre-release。
- Windows 分支不构建 Android APK、iOS IPA 或 macOS 安装包。

## 开发

```powershell
cd desktop
npm ci
npm test
npx electron-builder --win nsis portable --publish never
```

推送到 `windows` 分支后，`.github/workflows/windows-build.yml` 会在 GitHub 的 Windows runner 上测试并生成短期构建 Artifact。只有通过物理 Windows 验收、签名和隐私门禁的版本才可复制到 GitHub Release 并标记 Stable。

## 安全边界

- 原生引导只允许目标会话内的 Steer/Queue，不使用 `codex exec resume`，不创建第二个模型回合。
- Goal 恢复、删除必须返回对应 request/session/command 的 ACK 和最终 result。
- 发布包只包含 Windows 更新公钥；私钥不得进入源码、安装包、日志或 CI。
- 真实设备验证脚本、真实会话 ID、配对码、局域网地址和内部协作文档不属于公开分支。
- 默认 Relay 地址只是 `relay.example.com` 示例，使用者必须配置自己的 TLS Relay。

## 许可证与版权

Copyright © 2026 wwzwangwz. All rights reserved.

本分支与主分支相同，采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，属于源码可见项目。未经版权所有者事先书面许可，禁止商业使用、销售、转卖、付费部署、付费集成或商业 SaaS 使用。自愿赞助不等于商业授权。
