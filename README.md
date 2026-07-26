# Codex Monitor for Windows

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/wwzwangwz/codex-monitor-public?include_prereleases)](https://github.com/wwzwangwz/codex-monitor-public/releases)

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

Windows 安装包必须从公开 `windows` 分支在 Windows 环境重新构建。只有通过自动化测试、物理 Windows 验收、签名和隐私门禁的版本，才可上传到 GitHub Release 并标记 Stable。详细规则见 [docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安全边界

- 原生引导只允许目标会话内的 Steer/Queue，不使用 `codex exec resume`，不创建第二个模型回合。
- Goal 恢复、删除必须返回对应 request/session/command 的 ACK 和最终 result。
- 发布包只包含 Windows 更新公钥；私钥不得进入源码、安装包、日志或 CI。
- 真实设备验证脚本、真实会话 ID、配对码、局域网地址和内部协作文档不属于公开分支。
- 默认 Relay 地址只是 `relay.example.com` 示例，使用者必须配置自己的 TLS Relay。

## 许可证与版权

Copyright © 2026 Wenzhen Wang（GitHub：wwzwangwz）。

本分支与主分支相同，采用 [GNU Affero General Public License v3.0 only](LICENSE)，SPDX 标识为 `AGPL-3.0-only`，属于 OSI 正式认可的开源软件。

允许商业使用、收费部署、销售副本和提供收费服务，但必须保留许可证、版权和 [NOTICE](NOTICE)，明确标注修改，并按照 AGPL 提供分发版本或修改后网络服务的对应源码。中文说明见 [docs/LICENSE-zh-CN.md](docs/LICENSE-zh-CN.md)，标准引用信息见 [CITATION.cff](CITATION.cff)。
