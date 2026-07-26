# 发布流程

所有安装文件统一发布到 [GitHub Releases](https://github.com/wwzwangwz/codex-monitor-public/releases)，不通过聊天附件、临时网盘或源码目录替代正式发布。

## 每个 Release 必须包含

1. 独立版本标签和发布日期。
2. 中文“主要更新”。
3. 中文“验证”结果。
4. 对应平台的安装文件。
5. 每个安装文件的完整 SHA-256。
6. GitHub 自动生成的 Source code ZIP 和 TAR.GZ。
7. `AGPL-3.0-only`、`NOTICE` 和对应源码链接。
8. 未完成真实设备验收的版本必须标记为 Pre-release。

## 平台文件

| 平台 | Release 文件 |
| --- | --- |
| Android | `Codex-Monitor-Android-v<版本>.apk` |
| Windows | 安装版 EXE、便携版 EXE/ZIP、更新清单 |
| macOS Apple Silicon | 签名并公证的 DMG/ZIP |
| macOS Intel | 仅在实际构建与验收后提供 DMG/ZIP |
| iOS | App Store/TestFlight 为正式分发渠道；源码阶段不上传不可安装的伪 IPA |

## 稳定版门禁

- 自动化测试和静态检查全部通过。
- 安装包来自公开、已去隐私的对应提交。
- 标签指向的源码归档必须包含 `AGPL-3.0-only`、`NOTICE` 和 `CITATION.cff`。
- 安装包解包后未发现个人路径、真实设备名、家庭网络地址、配对信息或密钥。
- 已在真实目标设备完成安装、升级、连接和核心功能验收。
- Android 原位更新必须保留签名、配对、防休眠与应用设置。
- macOS 原位更新必须保持 bundle ID、安装路径和固定签名身份，不重复创建 App 或重新索要权限。
- Windows 必须在真实 Windows 环境完成安装、Steer/Queue、Goal 和双向图片验收。

未达到任一门禁时只能发布为 Pre-release，不能标记为 Latest Stable。
