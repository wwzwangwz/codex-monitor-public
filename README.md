# Codex Monitor

Codex Monitor 是一套跨设备的 Codex 会话监控与控制工具。电脑端选择需要监控的 Codex 会话，手机扫码配对后可查看每台设备、每个会话的状态灯、最近工作内容、Goal 状态和证据图片，并通过原生 Steer/Queue 通道发送文字或图片引导。

## 平台

| 平台 | 目录/分支 | 当前状态 |
| --- | --- | --- |
| Android | `android/` | 可用；通过公开发布门禁的安装包在 GitHub Releases |
| macOS 桌面端 | `desktop/` | 可用；正式分发仍需固定 Developer ID 签名 |
| iOS | `ios/` | 开发中，尚未发布 App Store/TestFlight 版本 |
| Windows 桌面端 | `windows` 分支 | 独立开发；通过 CI 生成预发布安装包 |
| 可选远程中继 | `relay/` | 增量功能；局域网连接仍为默认稳定路径 |

详细状态见 [PLATFORM_STATUS.md](PLATFORM_STATUS.md)。

项目更新记录见 [CHANGELOG.md](CHANGELOG.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，正式发布门禁见 [docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md)。

## 状态灯

- 绿色：正在运行。
- 红色：明确报错、Goal 受阻或已停止且需要介入。
- 蓝色：已完成或空闲。
- 黑色：电脑离线、Codex 疑似关闭、重启或网络状态未知。

黑色离线状态必须经过稳定窗口确认，短暂重连或工作内容变化不会触发状态切换提醒。

## 下载

只从本仓库的 **Releases** 页面下载正式构建。各平台只有通过对应真实设备验收的版本才标记为 Stable；尚未验收的 Windows、iOS 或 Mac 构建会明确标记为 Pre-release 或仅提供源码。

Android 支持应用内检查更新和原位安装，签名不变时会保留配对、防休眠和其他设置。macOS 的更新也必须保持同一 bundle ID、安装路径和固定签名身份，避免重复应用与重复权限弹窗。

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

Copyright © 2026 wwzwangwz. All rights reserved.

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，属于**源码可见（source-available）**项目，不是 OSI 定义的开源软件。

允许个人学习、研究、实验、测试以及其他非商业用途。未经版权所有者事先书面许可，禁止：

- 商业使用或商业部署；
- 销售、转卖、收费分发或付费安装；
- 作为商业产品、商业服务、商业插件或 SaaS 的组成部分；
- 以本项目或其衍生版本向他人收取费用。

商业授权需另行取得版权所有者的书面许可。第三方依赖仍分别适用其原有许可证。
