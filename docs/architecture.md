# 架构

正式系统只有一个写入者：Sidecar。Hook 和本地看板通过 Unix socket/Sidecar 服务层工作，不直接打开 SQLite。

```text
Codex plugin
  ├─ SessionStart ───────┐
  ├─ UserPromptSubmit ───┼─ Unix socket ─ Sidecar ─ SQLite/FTS
  └─ Stop ───────────────┘                    ├─ refine worker
                                             ├─ strict model transport
Browser 127.0.0.1 ─ secure dashboard ────────┘
```

主要目录：

- `src/repo`：只读解析 `.git`、`gitdir`、`commondir`，不执行 Git。
- `src/db`：schema、连接、仓库/session、job、Apply、查询和管理按职责拆分。
- `src/rollout`：只投影白名单 CLI 版本的允许字段。
- `src/hooks`、`src/sidecar`：有截止时间的 NDJSON IPC 与 fail-open Hook。
- `src/model`、`src/jobs`：正式 strict Schema transport 和后台抽取。
- `src/dashboard`：一次性 fragment bootstrap、Cookie/CSRF/Origin/Host 防护。
- `src/macos`：Keychain、launchd、marketplace、安装和卸载。

Prompt、最终回答只在 refine job 内存中存在。持久化只允许不可逆投影摘要、状态、错误码、来源引用和四字段记忆卡。

