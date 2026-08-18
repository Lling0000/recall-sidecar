# 首版实现与验收报告

日期：2026-08-18

## 已实现

- TypeScript / Node.js 24.15，提交 `package-lock.json` 并固定 engine 范围。
- 单写者 Sidecar、私有 Unix socket、SQLite WAL/FTS5 CJK n-gram、7 天托管备份。
- 只读 `.git` / `gitdir` / `commondir` 仓库身份，多 session 粘性、worktree 共享、clone/无 Git 路径隔离。
- `SessionStart`、`UserPromptSubmit`、`Stop` 三个 fail-open Hook；Stop 固定 `continue:true`。
- `0.148.0-alpha.9` rollout fixture 与精确 turn 投影；不读取 reasoning、工具输出、commentary 或 fallback 字段。
- PAT/JWT/PEM/高熵密钥遮蔽、正式 strict `json_schema`、action 语义校验、最多一次上一轮逻辑重试、stale/事务 Apply。
- 待核对、记忆、模型、健康四页看板；确认、回滚、归档、硬删除、仓库暂停/清空和来源命令。
- loopback Host/Origin/CSRF、一次性 fragment bootstrap、HttpOnly Cookie、CSP/no-store。
- macOS Keychain、launchd KeepAlive、本地 Codex marketplace/plugin、安装和保留数据的卸载。

## 验证结果

- P0-01 至 P0-24：全部通过，核心测试 40/40。
- Docker 核心：固定 Node 24.15.0 镜像内 typecheck、lint、结构检查、40 个核心测试、文档一致性和 build 全部通过。
- macOS 宿主：3/3，通过真实 Keychain、Unix socket/权限、plugin、launchd、dashboard。
- Codex plugin validator：通过。
- Codex CLI：`codex-local-memory@codex-local-memory-local` 为 `installed, enabled`。
- Hook trust：三个事件均逐一审查并显示 Installed 1 / Active 1 / Review 0。
- Hook 实跑：新会话成功绑定；最小回合产生一个 `state=skipped` Turn、零 refine job，证明 `auto_extract` 关闭时无抽取外发。
- 最终 lint、结构检查、类型检查、构建和文档一致性：全部通过。

## 剩余 P1

- Turn 级版本钉住与升级 staging/哈希/原子切换增强。
- enqueue、Apply、FTS、硬删除、备份各崩溃点的系统化注入测试。
- 带 schema version 的数据库迁移与失败回退。
- DB 大小、保留期、job 重试、dead-letter 上限配置。
- 更完整的 `Retry-After` 调度策略与安装时 Hook 命令展示。

## 已知限制

- 只白名单支持 Codex CLI `0.148.0-alpha.9`；其他完整版本会安全跳过抽取并告警。
- 未提供用户模型凭据，因此没有对真实远程供应商执行连接测试；`auto_extract` 保持关闭。用户必须在模型页通过正式 Schema 测试并同意 Prompt/最终回答外发后才能开启。
- 看板固定使用 `127.0.0.1:43127`；端口被其他进程占用时 Sidecar 会失败并由 Hook fail-open。
- Docker Hub 认证端点两次超时后，从 DaoCloud 代理取得同一固定 Node 镜像，最终使用 digest `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` 完成验收。

