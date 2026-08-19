# 首版实现与验收报告

日期：2026-08-18

## 已实现

- TypeScript / Node.js 24.15，提交 `package-lock.json` 并固定 engine 范围。
- 单写者 Sidecar、私有 Unix socket、SQLite WAL/FTS5 CJK n-gram、7 天托管备份。
- 只读 `.git` / `gitdir` / `commondir` 仓库身份，多 session 粘性、worktree 共享、clone/无 Git 路径隔离。
- `SessionStart`、`UserPromptSubmit`、`Stop` 三个 fail-open Hook；Stop 固定 `continue:true`。
- `0.148.0-alpha.9` rollout fixture 与精确 turn 投影；不读取 reasoning、工具输出、commentary 或 fallback 字段。
- PAT/JWT/PEM/高熵密钥遮蔽、逐轮候选 strict Schema、25 回合/compact Gate＋Refiner、最多一次上一轮逻辑重试、批次 stale/事务 Apply。
- 待核对、记忆、模型、健康四页看板；确认、回滚、归档、硬删除、仓库暂停/清空和来源命令。
- loopback Host/Origin/CSRF、一次性 fragment bootstrap、HttpOnly Cookie、CSP/no-store。
- macOS Keychain、launchd KeepAlive、本地 Codex marketplace/plugin、安装和保留数据的卸载。

## 验证结果

- P0-01 至 P0-24：全部通过，核心测试 48/48。
- Docker 核心：固定 Node 24.15.0 镜像内 typecheck、lint、结构检查、48 个核心测试、文档一致性和 build 全部通过。
- macOS 宿主：3/3，通过真实 Keychain、Unix socket/权限、plugin、launchd、dashboard。
- Codex plugin validator：通过。
- Codex CLI：`codex-local-memory@codex-local-memory-local` 为 `installed, enabled`。
- Hook trust：三个事件均逐一审查并显示 Installed 1 / Active 1 / Review 0。
- Hook 实跑：新会话成功绑定；最小回合产生一个 `state=skipped` Turn、零 refine job，证明 `auto_extract` 关闭时无抽取外发。
- 模型复测：TeamoRouter 模型列表鉴权成功；免费候选输出不稳定，未获准启用。逐轮候选使用 `gpt-5.4`，Gate/Refiner 使用高一档 `gpt-5.5`，三份 strict Schema 均需通过后才开启 `auto_extract`。
- 语义回归：`gpt-5.4` 对长期规则 `create`、一次性要求 `skip`、明确替换 `update`、强迫记忆注入 `reject` 四类样例 4/4 一次通过，中文卡片语言一致；共 4 次请求、2,002 tokens，未写正式数据库。
- 检查点回归：TeamoRouter `gpt-5.5` Gate 从长期、一次性、更新、注入四类候选中只选中长期 create/update；Refiner 输出中文 create 和精确 v2 update，两次调用均一次通过 strict Schema，共 1,884 tokens，未写正式数据库。
- 最终 lint、结构检查、类型检查、构建和文档一致性：全部通过。

## 剩余 P1

- Turn 级版本钉住与升级 staging/哈希/原子切换增强。
- enqueue、Apply、FTS、硬删除、备份各崩溃点的系统化注入测试。
- 带 schema version 的数据库迁移与失败回退。
- DB 大小、保留期、job 重试、dead-letter 上限配置。
- 更完整的 `Retry-After` 调度策略与安装时 Hook 命令展示。

## 已知限制

- 只白名单支持 Codex CLI `0.148.0-alpha.9`；其他完整版本会安全跳过抽取并告警。
- 已对用户指定的远程供应商执行候选、Gate、Refiner 隔离验证；当前配置为 `gpt-5.4` 候选 + `gpt-5.5` Gate/Refiner。更换 Origin 或任一模型会关闭 `auto_extract` 并要求重新验证；关闭唯一开关会撤回单轮与检查点外发同意。
- 看板固定使用 `127.0.0.1:43127`；端口被其他进程占用时 Sidecar 会失败并由 Hook fail-open。
- 新纠正只在单 session 累积 25 个 staged 候选或发生 compact 后，经过 Gate＋Refiner 才成为长期记忆；检查点前不会参与召回。
- Docker Hub 认证端点两次超时后，从 DaoCloud 代理取得同一固定 Node 镜像，最终使用 digest `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` 完成验收。
