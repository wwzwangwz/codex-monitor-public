# Codex Monitor

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/wwzwangwz/codex-monitor-public?include_prereleases)](https://github.com/wwzwangwz/codex-monitor-public/releases)

Codex Monitor 是一套跨设备的 Codex 会话监控与控制工具。电脑端选择需要监控的 Codex 会话，手机扫码配对后可查看每台设备、每个会话的状态灯、最近工作内容、Goal 状态和证据图片，并通过原生 Steer/Queue 通道发送文字或图片引导。

## 平台

| 平台 | 目录/分支 | 当前状态 |
| --- | --- | --- |
| Android | `android/` | 可用；通过公开发布门禁的安装包在 GitHub Releases |
| macOS 桌面端 | `desktop/` | 0.11.15 预发布；提供 Apple Silicon / Intel 一键安装 DMG |
| iOS | `ios/` | 开发中；按当前计划暂不发布 App Store、TestFlight 或 IPA |
| Windows 桌面端 | `windows` 分支 | 0.8.10 预发布；提供 x64 安装版和便携版 |
| 可选远程中继 | `relay/` | 增量功能；局域网连接仍为默认稳定路径 |

详细状态见 [PLATFORM_STATUS.md](PLATFORM_STATUS.md)。

项目更新记录见 [CHANGELOG.md](CHANGELOG.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，正式发布门禁见 [docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md)。
本次 AGPL 公共迁移的逐项证据见 [docs/OPEN-SOURCE-AUDIT-2026-07-27.md](docs/OPEN-SOURCE-AUDIT-2026-07-27.md)。

## 状态灯

- 绿色：正在运行。
- 红色：明确报错、Goal 受阻或已停止且需要介入。
- 蓝色：已完成或空闲。
- 黑色：电脑离线、Codex 疑似关闭、重启或网络状态未知。

黑色离线状态必须经过稳定窗口确认，短暂重连或工作内容变化不会触发状态切换提醒。

## 下载

普通用户请从以下 Release 下载一键安装文件：

| 平台 | 推荐下载 | 发布页 |
| --- | --- | --- |
| Android | [Codex-Monitor-Android-v0.11.22.apk](https://github.com/wwzwangwz/codex-monitor-public/releases/download/android-v0.11.22/Codex-Monitor-Android-v0.11.22.apk) | [Android 0.11.22](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/android-v0.11.22) |
| Apple 芯片 Mac（M1/M2/M3/M4） | [Codex-Monitor-macOS-arm64-v0.11.15.dmg](https://github.com/wwzwangwz/codex-monitor-public/releases/download/macos-v0.11.15/Codex-Monitor-macOS-arm64-v0.11.15.dmg) | [macOS 0.11.15](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/macos-v0.11.15) |
| Intel Mac | [Codex-Monitor-macOS-x64-v0.11.15.dmg](https://github.com/wwzwangwz/codex-monitor-public/releases/download/macos-v0.11.15/Codex-Monitor-macOS-x64-v0.11.15.dmg) | [macOS 0.11.15](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/macos-v0.11.15) |
| Windows x64 | [Codex-Monitor-Windows-x64-Setup-v0.8.10.exe](https://github.com/wwzwangwz/codex-monitor-public/releases/download/windows-v0.8.10/Codex-Monitor-Windows-x64-Setup-v0.8.10.exe) | [Windows 0.8.10](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/windows-v0.8.10) |

所有历史版本、备用 ZIP/Portable 文件、中文日志与 SHA-256 校验文件见 [Releases](https://github.com/wwzwangwz/codex-monitor-public/releases)。

Android 支持应用内检查更新和原位安装，签名不变时会保留配对、防休眠和其他设置。macOS 与 Windows 当前没有商业代码签名，因此暂标记为 Pre-release：Mac 首次打开可能需要按住 Control 点击并选择“打开”，Windows 可能需要在 SmartScreen 中选择“更多信息 → 仍要运行”。各平台只有通过对应真实设备、签名和完整功能验收后才会标记为 Stable。

## 本地开发

### Android

```bash
cd android
./gradlew testDebugUnitTest testReleaseUnitTest lintRelease assembleRelease
```

### macOS / Windows 桌面端

```bash
cd desktop
npm ci
npm test
npm run dist
```

### iOS

使用 Xcode 打开 `ios/CodexMonitor.xcodeproj`。当前 iOS 客户端仍在开发中，不应视为可发布产品。

### Relay

```bash
cd relay
npm ci
npm test
npm start
```

部署密钥必须通过环境变量注入，不得写入仓库、二维码或客户端。

## 安全与隐私

- 配对码包含设备连接凭据，不应截图公开或提交到 Issue。
- 仓库不保存 Codex 会话历史、API 密钥、手机推送私钥或用户设备信息。
- 发布镜像使用全新的无历史提交，不包含内部开发仓库的设备名、局域网地址、真实会话 ID 或协作文档。
- 报告安全问题前请先删除截图中的配对码、令牌和私人会话内容。

## 赞助

❤️ 如果这个项目对你有帮助，欢迎请我喝一杯咖啡。

微信和支付宝赞助码见 [SPONSOR.md](SPONSOR.md)。赞助属于自愿支持，不代表购买功能、服务或商业授权。

## 许可证与版权

Copyright © 2026 Wenzhen Wang（GitHub：wwzwangwz）。

本项目采用 [GNU Affero General Public License v3.0 only](LICENSE)，SPDX 标识为 `AGPL-3.0-only`，属于 OSI 正式认可的开源软件。中文说明见 [docs/LICENSE-zh-CN.md](docs/LICENSE-zh-CN.md)，署名与来源要求见 [NOTICE](NOTICE)，标准引用信息见 [CITATION.cff](CITATION.cff)。

允许个人、学校、研究机构和公司使用，也允许商业使用、收费部署、销售副本和提供收费服务，但必须遵守以下条件：

- 保留版权声明、完整 AGPL-3.0-only 许可证和 `NOTICE`；
- 修改版本必须明确标注修改，不得冒充官方版本；
- 分发安装包或衍生版本时，必须提供对应完整源码；
- 通过网络提供修改后的 Codex Monitor 或 Relay 时，必须向网络用户提供正在运行版本的对应源码；
- 在随附文档或“关于/法律声明”中合理显示 Codex Monitor 名称和官方项目链接。

合规商用不需要事先付费或逐一联系作者。第三方依赖仍分别适用其原有许可证。
