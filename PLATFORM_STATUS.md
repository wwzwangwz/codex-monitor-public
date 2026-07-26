# 平台发布状态

本文档只记录公开仓库的发布门禁，不包含私人设备、真实会话或内部开发安排。

## Android

- 源码版本：0.11.22。
- 当前真实手机运行版：0.11.22（versionCode 50）；客户端握手、原配对保留和局域网重连已验证。
- 0.11.22 已完成单元测试、Release lint、构建、签名、匿名下载、隐私扫描和安装包 SHA-256 校验。
- 证据图片完整链路仍待本版本最终验收，因此当前继续标记为 Pre-release。

## macOS

- 桌面源码版本：0.11.15。
- 局域网监控、会话选择、原生引导、Goal 控制和证据图片接口已实现。
- 0.11.15 已提供 Apple Silicon 与 Intel 的 DMG/ZIP，发布页为 [macos-v0.11.15](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/macos-v0.11.15)。
- Desktop 111 项测试、Relay 15 项测试、DMG/ZIP 完整性、架构、内部源码一致性和隐私扫描均已通过。
- 当前没有固定 Apple Developer ID 和 Apple 公证，因此只标记为 Pre-release；不宣称具备自动更新或继承其他签名版本权限的能力。

## Windows

- 在 `windows` 分支独立维护。
- 0.8.10 已提供 x64 Setup 安装版与 Portable 便携版，发布页为 [windows-v0.8.10](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/windows-v0.8.10)。
- Setup 与 Portable 内部载荷一致，公开源码边界、构建来源和隐私扫描已核验。
- 尚无 Windows 代码签名，且未在独立物理 Windows 设备完成完整通信、Goal 与图片链路验收，因此只标记为 Pre-release。

## iOS

- 客户端源码已建立，仍处于开发阶段。
- 按当前发布计划暂缓 iOS 安装包，尚未完成 Apple Developer 身份、APNs 真机、TestFlight 和 App Store 验收。
- 当前不提供 IPA，不宣称可正式使用。

## 发布规则

1. Stable Release 必须通过自动化测试、隐私/密钥扫描、签名校验和对应真实设备验收。
2. 未通过任一门禁的构建只能标记为 Pre-release。
3. Android APK、Windows 安装包、macOS DMG/ZIP 和演示视频只作为 Release 附件，不把逐版本二进制写入 Git 历史。桌面构建所需的单个当前 Android 更新资源除外。
4. 所有 Release 必须附带 AGPL-3.0-only、`NOTICE`、对应源码链接和安装文件 SHA-256。
5. 已发布标签、安装包和校验值不得覆盖；任何后续改动都必须增加版本号并创建新的 Release。
