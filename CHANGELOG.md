# 更新日志

本项目采用按平台独立版本号的发布方式。正式安装文件、完整版本说明和 SHA-256 校验值统一发布在 [GitHub Releases](https://github.com/wwzwangwz/codex-monitor-public/releases)。

## 待发布

- macOS：等待固定 Developer ID 签名、原位更新和权限继承完成真实设备验收。
- Windows：等待 `windows` 分支在真实 Windows 环境重新构建并完成通信、Goal 和图片链路验收。
- iOS：仍在开发中，尚无 App Store、TestFlight 或 IPA 发布。

## 公共开源基线 — 2026-07-27

- 项目许可证由 PolyForm Noncommercial 1.0.0 迁移为 `AGPL-3.0-only`，正式允许商业使用，同时要求保留署名、公开分发版本源码，并覆盖修改后的网络服务。
- 新增 `NOTICE`、`CITATION.cff`、中文许可证说明和统一发布规范。
- `main` 与 `windows` 分支的许可证、版权与引用信息保持一致。
- 已发布的版本标签、安装包和校验值保持冻结；后续修复或功能变化必须使用新的版本号和 Release，不能覆盖已有安装包。

## Android 0.11.22 — 2026-07-26

### 主要更新

- 证据图片下载会根据当前连接模式依次尝试局域网 IP、主机名和远程中继前缀。
- 移除仅适用于单台旧设备的一次性地址恢复规则。
- 公开源码和 APK 不再包含私人设备名、家庭局域网地址或真实配对信息。
- 保持原有应用签名、配对信息、防休眠设置和应用配置，支持原位升级。

### 验证

- Android Debug/Release 单元测试通过。
- Android Release lint 与 Release 构建通过。
- APK、桌面内置更新包和更新清单的文件大小与 SHA-256 完全一致。
- 公开源码与 APK 已执行隐私信息和常见密钥扫描。
- 真实 Android 手机已通过客户端握手报告 `0.11.22`（versionCode 50），保留原配对并成功恢复局域网连接。
- 证据图片完整链路仍待本版本最终验收，因此继续标记为 Pre-release，不冒充 Stable。

### 文件校验

`Codex-Monitor-Android-v0.11.22.apk`

```text
SHA-256 9e488585d42b7501a055a05a2f3e34aca6b70a3475d282881e4c30985c651e11
```
