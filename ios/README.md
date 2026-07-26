# Codex Monitor for iPhone

原生 SwiftUI iPhone 客户端，兼容共享协议 v7。

## 功能

- 扫码连接多台 Mac/Windows
- 四色状态灯、设备归属、NEW 和最近工作内容
- 只在灯色变化且 App 不活跃时发送本地通知
- 20 秒断线确认与主动 `/health` 探测
- 原生 Steer/Queue 手机引导
- 系统照片选择器发送最多 10 张截图，支持发送前预览和移除
- 局域网与远程中继独立端点、可切换且不互相覆盖
- 仅保存配对和模板，不保存完整聊天历史

## 本地验证

核心协议测试不依赖完整 Xcode：

```bash
cd ios
swift test
```

完整 App 需要 Xcode：

```bash
cd ios
xcodegen generate
open CodexMonitorIOS.xcodeproj
```

在 Xcode 的 Signing & Capabilities 中选择自己的 Apple Developer Team，再连接 iPhone 运行。

## 外置盘构建目录

构建缓存和归档默认写入外置 `CodexMonitorBuild` 卷，避免占用系统盘；也可通过脚本环境变量改成自己的构建卷：

```bash
cd ios
./scripts/build-on-mac512.sh
./scripts/archive-on-mac512.sh
```

输出目录为 `/Volumes/CodexMonitorBuild/CodexMonitorBuild`。脚本也会优先使用
`/Volumes/CodexMonitorBuild/Applications/Xcode.app`；未安装完整 Xcode 时会直接退出，不会退回系统盘构建。

## 后台限制

iOS 不能保证普通局域网 WebSocket 在 App 长时间挂起或被强制退出后永久运行。局域网前台功能完整保留；真正长期后台提醒需要公网 `wss://` 中继和 APNs。远程功能上线前不得删除或改写稳定的 LAN 路径。
