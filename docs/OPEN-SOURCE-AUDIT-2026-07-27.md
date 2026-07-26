# 公共开源迁移审计（2026-07-27）

本报告记录 Codex Monitor 从私人开发仓库迁移到公共 AGPL 仓库时的可复查证据。报告不包含真实设备名、局域网地址、配对码、会话 ID、私人会话内容或签名私钥。

## 审计对象

- 公共仓库：<https://github.com/wwzwangwz/codex-monitor-public>
- `main`：`d5f4c8dfae1eae753a623ab273b1ce9acbd545c4`
- `windows`：`92457b5c4769a3898afbbfd939b5fadb4e4cb5ac`
- Android 标签：`android-v0.11.22`
- Android 标签源码提交：`883b79ec0f5532d40a254bdc3c3506e9ce7c5024`
- Android Release：<https://github.com/wwzwangwz/codex-monitor-public/releases/tag/android-v0.11.22>

## 许可证与版权

- GitHub 仓库 API 将当前许可证识别为 `AGPL-3.0`。
- `main` 与 `windows` 分支均包含 `LICENSE`、`NOTICE`、`CITATION.cff` 和中文许可证说明。
- 两个分支的上述法律文件内容一致。
- `LICENSE` 与 GNU 官方 AGPLv3 文本逐字一致。
- `LICENSE` SHA-256：

```text
0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0
```

- Desktop 与 Relay 的包元数据使用 SPDX 标识 `AGPL-3.0-only`。
- 商业使用、收费部署和销售副本均被允许，但仍须履行 AGPL、保留 `NOTICE`、提供对应源码并明确标注修改版本。

## 隐私与密钥扫描

扫描范围：

- `main` 与 `windows` 当前远端分支的完整 Git 归档；
- Android 0.11.22 APK 的解包内容；
- Android 标签的匿名 ZIP 与 TAR.GZ 源码归档。

扫描内容：

- 已知真实设备名、局域网地址、本机绝对路径、配对 token 和会话 ID；
- GitHub、云服务和 API 常见密钥格式；
- PEM 私钥、签名私钥、Android keystore、数据库、JSONL 会话记录和 `.env`；
- APK 内的资源、DEX 和清单文件。

结果：未发现上述私人数据或密钥。`docs/assets/` 中的微信和支付宝赞助码是版权所有者明确要求公开的项目素材。

## Android Release 校验

- 版本：`0.11.22`
- versionCode：`50`
- 包名：`com.codexmonitor.mobile`
- APK 大小：`12,879,190` 字节
- APK SHA-256：

```text
9e488585d42b7501a055a05a2f3e34aca6b70a3475d282881e4c30985c651e11
```

- APK、`android-latest.json` 和 Release 日志中的大小、版本号与 SHA-256 一致。
- APK Signature Scheme v2 验证通过，签名证书与现有侧载安装链保持一致。
- APK 签名证书 SHA-256：

```text
bbac7231051f899163374abebe19fa4d3a7bc876d40ff7174de13f342dae7c51
```

- 匿名下载的源码 ZIP 与 TAR.GZ 均包含 `LICENSE`、`NOTICE`、`CITATION.cff`、中文许可证说明和发布规范。
- 真实 Android 手机已通过客户端握手报告 `0.11.22`（versionCode 50），原配对保留，局域网断网恢复后可重新连接。
- 证据图片完整链路仍待本版本最终验收，因此 Release 保持 **Pre-release**，不标记为 Stable。

## 自动化验证

- Android Debug/Release 单元测试、Release lint 与 Release 构建通过。
- macOS Desktop：111 项测试通过。
- Relay：15 项测试通过。
- iOS 协议：15 项测试通过。
- Windows 源码：233 项通过、4 项仅因本机不是 Windows 而跳过、0 项失败。
- Windows GitHub Actions 已在 Windows runner 完成安装版/便携版构建和打包边界测试：
  <https://github.com/wwzwangwz/codex-monitor-public/actions/runs/30210544106>

Windows、macOS 和 iOS 尚未满足各自的公开稳定安装包门禁，因此不发布伪 Stable 文件。详细状态见 [PLATFORM_STATUS.md](../PLATFORM_STATUS.md)。

## 发布不可变性

Android 0.11.22 的标签、APK 和 SHA-256 已冻结。后续修复、功能变化、依赖升级或构建方式变化必须增加版本号并创建新的 Release，不覆盖本版本。
