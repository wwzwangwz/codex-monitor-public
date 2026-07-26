# Codex Monitor Android

稳定局域网监控始终可在没有 Firebase 的情况下构建和运行。FCM 是远程 Relay 的可选后台备援，不替代 LAN 前台服务。

## Mac512 构建

默认构建不初始化 Firebase：

```bash
./scripts/build-on-mac512.sh
```

创建 Firebase Android App 后，通过 Gradle 环境变量注入公开的客户端配置，不提交 `google-services.json`：

```bash
export ORG_GRADLE_PROJECT_codexFcmAppId='1:...:android:...'
export ORG_GRADLE_PROJECT_codexFcmApiKey='...'
export ORG_GRADLE_PROJECT_codexFcmProjectId='...'
export ORG_GRADLE_PROJECT_codexFcmSenderId='...'
./scripts/build-on-mac512.sh
```

四项配置必须同时存在，否则 App 不初始化 Firebase。Relay 端另需私密的 FCM 服务账号，只能放在部署环境变量中，不能放入 APK 或仓库。

FCM 使用高优先级 data 消息。App 会验证 `lamp_changed`、设备配对和监控总开关，工作文字变化不会通知；前台只响声和标记 NEW，后台显示系统通知，贾维斯绿色转蓝色保持静默。

Android 12 及以上版本建议在 App 的“后台保护设置”中允许“闹钟和提醒”。获授权后，局域网前台服务会用 60 秒精确 PendingIntent 作为 vivo 等系统冻结 Handler 时的保活补偿；未授权时自动退回普通闹钟。关闭监控总开关会取消保活 PendingIntent，不会被旧闹钟重新启动。

## 独立自动更新源

Android `0.11.20` 起，局域网配对会先查询同一电脑 `43118` 端口的外置更新源，再回退桌面应用原有的 `43117` 更新接口。这样发布新 APK 时不需要替换或重签 Mac App，也不会因此重新申请 Mac 权限；WebSocket 监控仍固定使用原有 `43117`。

Mac 主开发机完成 APK 构建和清单更新后执行：

```bash
cd desktop
python3 scripts/install_android_update_feed.py \
  --apk resources/Codex-Monitor-Android.apk \
  --manifest resources/android-latest.json
```

安装器会先校验 APK 大小和 SHA-256，再原子更新 `~/Library/Application Support/codex-monitor-update-feed`，并安装当前用户的 LaunchAgent。更新源开机自动启动；`/health`、`/android/latest.json` 和 `/android/apk` 均不依赖 Mac App 进程。

仍在 `0.11.19` 或更早版本的手机尚不知道 `43118`。首次迁移时可使用相同设备 ID、名称和 token 生成一个只把 `wsUrl` 改为 `ws://<Mac-IP>:43118/monitor` 的临时 v1 配对码。外置源会把 WebSocket 原样转发至稳定的 `43117`，不会创建第二台设备；更新清单中的 migration 会在发现更新时自动把配对恢复为 `43117`。完成这一次迁移后，后续版本不再需要临时配对码。
