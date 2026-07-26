# Windows 自动更新签名合同

本合同只定义 Windows Monitor 验证更新包的边界。当前只发布公钥；私钥必须保存在
仓库以外的受限目录，权限为 `0600`，并通过
`CODEX_MONITOR_WINDOWS_UPDATE_PRIVATE_KEY` 环境变量传给签名工具。禁止把私钥提交到
Git、放入安装包、日志、IPC 或 GitHub。仓库公钥为
`release/windows-update-ed25519-public.pem`。

## Manifest

签名 manifest 是 UTF-8、无 BOM、LF 换行的 JSON。签名前必须使用稳定序列化：对象键按
下面顺序写入，数组顺序固定，不添加空格或末尾换行；签名覆盖去掉 `signature` 字段后的
完整 JSON 字节：

```json
{"schema":2,"product":"Codex Monitor","platform":"windows","version":"0.0.1","publishedAt":"2026-01-01T00:00:00Z","asset":{"kind":"nsis","url":"https://github.com/wwzwangwz/codex-monitor-public/releases/download/windows-0.0.1/Codex-Monitor-Setup.exe","sha256":"64-lowercase-hex","sizeBytes":1},"rollback":{"version":"0.0.0","kind":"rollback","url":"https://github.com/wwzwangwz/codex-monitor-public/releases/download/windows-0.0.1/Codex-Monitor-rollback.zip","sha256":"64-lowercase-hex","sizeBytes":1},"releaseNotesZh":"中文更新说明"}
```

实际发布时在末尾追加 `,"signature":"<base64 Ed25519 签名>"}`。Windows 必须拒绝：

- `schema`、`product`、`platform`、版本号或时间格式不匹配；
- 非 HTTPS、跨域重定向、非 GitHub release asset、相对路径或下载地址改变；
- SHA-256、字节数、签名或公钥不匹配；
- 没有回滚包、回滚包校验失败或版本低于当前安装版；
- manifest 过大、字段未知、重复键、JSON 后有额外字节或签名验证超时。

下载必须写入新临时文件，完成哈希和签名验证后原子改名；更新失败保留当前安装目录和
LAN 端口，不能停止 Codex Desktop、当前会话或覆盖正在运行的 EXE。更新器必须提供回滚
入口，并在重启前保存当前版本的可验证备份。

Schema 2 把 `rollback.version`、`rollback.kind`、下载地址、SHA-256 和大小全部纳入签名字节。
回滚版本必须是三段语义版本且严格低于目标版本；manifest、asset 和 rollback 出现任何未知
字段都必须拒绝，避免签名端与验证端对同一 JSON 产生不同解释。Schema 1 不得用于安装。

## 当前状态

公钥已发布，私钥不属于公开仓库；尚未签署真实 Windows release asset。
签名工具为 `scripts/sign-windows-manifest.js`，只接受不带 `signature` 的合同 JSON，
使用固定字段顺序生成签名输入，并输出带 Base64 Ed25519 签名的 manifest。Windows 可先实现
验签、拒绝路径和回滚测试，但在收到真实签名 manifest 之前不得静默安装。
