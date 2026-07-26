# 参与开发

感谢关注 Codex Monitor。提交代码前请先阅读 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)；所有贡献均按 `AGPL-3.0-only` 提交。提交者应确认自己有权贡献相关代码和素材，并同意保留项目的合理署名与来源声明。

## 分支

- `main`：Mac、Android、iOS 与可选 Relay。
- `windows`：Windows 桌面端独立源码。

不要把真实配对码、设备名、局域网地址、会话 ID、访问令牌、API 密钥或用户截图提交到仓库和 Issue。

## 提交前验证

Android：

```bash
cd android
./gradlew testDebugUnitTest testReleaseUnitTest lintRelease assembleRelease
```

桌面端：

```bash
cd desktop
npm ci
npm test
```

Relay：

```bash
cd relay
npm ci
npm test
```

iOS：

```bash
cd ios
swift test
```

涉及连接、通知、原生 Steer/Queue、Goal、图片或自动更新的改动，还必须在对应真实设备上验收。仅模拟测试通过不能标记为稳定版。

## Pull Request

- 清楚说明问题、修复范围和测试证据。
- 一个 Pull Request 只处理一个可审查的主题。
- 不要提交构建缓存、签名私钥、证书、用户数据或内部协作文档。
- 新功能和 Bug 修复应同时增加自动化回归测试。
