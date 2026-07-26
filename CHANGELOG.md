# 更新日志

本项目采用按平台独立版本号的发布方式。正式安装文件、完整版本说明和 SHA-256 校验值统一发布在 [GitHub Releases](https://github.com/wwzwangwz/codex-monitor-public/releases)。

## 待发布

- macOS：0.11.15 预发布后，仍需固定 Developer ID、Apple 公证、原位更新和权限继承验收，才能升级为 Stable。
- Windows：0.8.10 预发布后，仍需 Windows 代码签名与独立物理 Windows 的通信、Goal 和图片链路验收，才能升级为 Stable。
- iOS：仍在开发中，尚无 App Store、TestFlight 或 IPA 发布。

## macOS 0.11.15（Pre-release）— 2026-07-27

### 发布文件

- Apple Silicon：DMG 一键安装包与备用 ZIP。
- Intel Mac：DMG 一键安装包与备用 ZIP。
- 发布页：[macos-v0.11.15](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/macos-v0.11.15)

### 验证

- Desktop 测试 111/111 通过，Relay 测试 15/15 通过。
- 生产依赖审计为 0 个已知漏洞。
- 两种架构的 DMG/ZIP 完整性、包标识、版本、处理器架构、内部源码一致性、内置 Android 更新包和隐私扫描均通过。
- 当前只有 ad-hoc 签名，没有 Developer ID、Team ID 或 Apple 公证，因此保持 Pre-release，不冒充 Stable。

### 文件校验

```text
b499825d38e0b791bc5844e37791eb22909f7dd233954e3e26896e13bcd910e8  Codex-Monitor-macOS-arm64-v0.11.15.dmg
f87921a2d36e743c36e5782c5fa0cf48e0c710a52c8db8c43e27c148563dedba  Codex-Monitor-macOS-arm64-v0.11.15.zip
c16f69d33655d33e1bb6620cdd792df2a93c3b321ead6254a873130800ded3f4  Codex-Monitor-macOS-x64-v0.11.15.dmg
8fbebd713fce51879e12c61a664ca11273c4f6864a8e22ce472e1e1fddea53ce  Codex-Monitor-macOS-x64-v0.11.15.zip
```

## Windows 0.8.10（Pre-release）— 2026-07-27

### 发布文件

- Windows x64 Setup 一键安装包。
- Windows x64 Portable 免安装备用版本。
- 发布页：[windows-v0.8.10](https://github.com/wwzwangwz/codex-monitor-public/releases/tag/windows-v0.8.10)

### 验证

- 对应构建提交为 `88ace8e2b5f0a131139ec0347c49864c45147f9e`，构建记录为 [GitHub Actions run 30210544106](https://github.com/wwzwangwz/codex-monitor-public/actions/runs/30210544106)。
- Setup 与 Portable 内部应用载荷一致。
- 安装包源码与对应公开提交一致，仅存在 Windows 标准 CRLF 换行差异。
- 已通过已知设备信息、局域网地址、配对令牌和常见密钥扫描。
- 尚无 Windows 代码签名与独立物理 Windows 的完整功能验收，因此保持 Pre-release。

### 文件校验

```text
6307f9b9f1cbdb68ef8678abb8c8c2d9695727c86f6e185096c9fcd8bffcc0b4  Codex-Monitor-Windows-x64-Portable-v0.8.10.exe
1e3b100544c635d13f9ede9562b01634e71fd28a1d1b029cb78c7b193c2a989b  Codex-Monitor-Windows-x64-Setup-v0.8.10.exe
```

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
