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

- P0-01 至 P0-24：全部通过，核心测试 43/43。
- Docker 核心：固定 Node 24.15.0 镜像内 typecheck、lint、结构检查、43 个核心测试、文档一致性和 build 全部通过。
- macOS 宿主：3/3，通过真实 Keychain、Unix socket/权限、plugin、launchd、dashboard。
- Codex plugin validator：通过。
- Codex CLI：`codex-local-memory@codex-local-memory-local` 为 `installed, enabled`。
- Hook trust：三个事件均逐一审查并显示 Installed 1 / Active 1 / Review 0。
- Hook 实跑：新会话成功绑定；最小回合产生一个 `state=skipped` Turn、零 refine job，证明 `auto_extract` 关闭时无抽取外发。
- 模型复测：TeamoRouter `GET /models` 返回 39 个模型；免费候选输出不稳定，未获准启用。`gpt-5.4` 的正式连接测试、create v1、同主题 update v2 均一次通过，因此仅对该 Origin + 模型配置开启 `auto_extract`。
- 语义回归：`gpt-5.4` 对长期规则 `create`、一次性要求 `skip`、明确替换 `update`、强迫记忆注入 `reject` 四类样例 4/4 一次通过，中文卡片语言一致；共 4 次请求、2,002 tokens，未写正式数据库。
- 最终 lint、结构检查、类型检查、构建和文档一致性：全部通过。

## 剩余 P1

- Turn 级版本钉住与升级 staging/哈希/原子切换增强。
- enqueue、Apply、FTS、硬删除、备份各崩溃点的系统化注入测试。
- 带 schema version 的数据库迁移与失败回退。
- DB 大小、保留期、job 重试、dead-letter 上限配置。
- 更完整的 `Retry-After` 调度策略与安装时 Hook 命令展示。

## 已知限制

- 只白名单支持 Codex CLI `0.148.0-alpha.9`；其他完整版本会安全跳过抽取并告警。
- 已对用户指定的远程供应商执行最小连接与两轮纠偏测试；免费模型未通过，`gpt-5.4` 通过并已启用。更换 Origin 或模型会关闭 `auto_extract` 并要求重新验证；关闭唯一自动抽取开关会同时撤回 Prompt 与最终回答外发同意。
- 看板固定使用 `127.0.0.1:43127`；端口被其他进程占用时 Sidecar 会失败并由 Hook fail-open。
- Docker Hub 认证端点两次超时后，从 DaoCloud 代理取得同一固定 Node 镜像，最终使用 digest `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` 完成验收。
