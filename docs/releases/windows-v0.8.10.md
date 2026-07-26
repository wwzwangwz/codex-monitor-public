# Codex Monitor Windows 0.8.10（预发布）

这是 Windows x64 的一键安装候选版本：

- 推荐普通用户使用：`Codex-Monitor-Windows-x64-Setup-v0.8.10.exe`
- 无需安装的备用版本：`Codex-Monitor-Windows-x64-Portable-v0.8.10.exe`

## 安装

1. 下载 Setup 安装程序。
2. 当前构建没有 Windows 商业代码签名。如 Microsoft Defender SmartScreen 拦截，请先核对下方 SHA-256，再选择“更多信息 → 仍要运行”。
3. 启动 Codex Monitor，选择要监控的 Codex 会话，再使用 Android 手机扫码配对。

## 主要功能

- 向手机同步 Windows Codex 会话状态、最近工作内容、Goal 状态和证据图片。
- 接收手机发来的原生 Steer/Queue 文字或图片引导。
- 支持安装版和便携版，局域网连接仍是默认稳定路径。

## 验证

- 对应源码提交：`88ace8e2b5f0a131139ec0347c49864c45147f9e`
- 构建记录：[GitHub Actions run 30210544106](https://github.com/wwzwangwz/codex-monitor-public/actions/runs/30210544106)
- Setup 与 Portable 内部应用载荷一致。
- 安装包中的源码与对应公开提交一致，仅存在 Windows 标准 CRLF 换行差异。
- 已通过已知设备信息、局域网地址、配对令牌和常见密钥扫描。
- 尚未在独立物理 Windows 设备完成完整安装、通信、Goal 与图片链路验收，且没有 Windows 代码签名，因此标记为 Pre-release。

## SHA-256

```text
6307f9b9f1cbdb68ef8678abb8c8c2d9695727c86f6e185096c9fcd8bffcc0b4  Codex-Monitor-Windows-x64-Portable-v0.8.10.exe
1e3b100544c635d13f9ede9562b01634e71fd28a1d1b029cb78c7b193c2a989b  Codex-Monitor-Windows-x64-Setup-v0.8.10.exe
```

完整源码由本 Release 的 Source code 附件提供。项目采用 AGPL-3.0-only，使用、修改或分发时请同时遵守 `LICENSE` 和 `NOTICE`。
