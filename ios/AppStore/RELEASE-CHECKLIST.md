# iPhone 发布检查清单

## 必须条件

- 安装完整 Xcode 与目标 iOS SDK。
- 加入 Apple Developer Program，并在 Xcode 选择有效 Team。
- 在 App Store Connect 创建 bundle ID `com.codexmonitor.ios` 对应的 App。
- 提供公开可访问的支持 URL 与隐私政策 URL。
- 准备审核期间持续在线的测试电脑和二维码。

## 构建验证

- `swift test` 通过核心协议测试。
- iPhone 真机允许相机、本地网络和通知权限。
- 分别连接真实 Mac 和 Windows。
- 验证四种灯、20 秒断线确认、NEW、前台不弹通知。
- 验证 Steer 和 Queue 不产生 `codex exec resume` 回合。
- 验证局域网是默认路径，远程选项只在设备提供 `relayWsUrl` 时可用。
- 强制退出后的后台限制与产品说明一致。

## App Store 素材

- 1024x1024 无透明通道图标。
- 6.9 英寸和 6.5 英寸 iPhone 截图。
- 简体中文名称、副标题、描述、关键词和审核说明。
- App Privacy 问卷与实际启用的 LAN/relay 功能一致。

## 发布顺序

1. Xcode 真机运行。
2. Archive 并 Validate App。
3. 上传 App Store Connect。
4. 先发布 TestFlight 内测。
5. 测试者验证 Mac/Windows 双端。
6. 修复阻断问题后提交 App Review。
