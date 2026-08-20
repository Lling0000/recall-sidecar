# 首版实现与验收报告

日期：2026-08-20

## 已实现

- TypeScript / Node.js 24.15，提交 `package-lock.json` 并固定 engine 范围。
- 单写者 Sidecar、私有 Unix socket、SQLite WAL/FTS5 CJK n-gram、7 天托管备份。
- 只读 `.git` / `gitdir` / `commondir` 仓库身份，多 session 粘性、worktree 共享、clone/无 Git 路径隔离。
- `SessionStart`、`UserPromptSubmit`、`Stop` 三个 fail-open Hook；Stop 固定 `continue:true`。
- rollout 必需结构兼容检测与精确 turn 投影；未测试 CLI 结构兼容即可使用，不读取 reasoning、工具输出、commentary 或 fallback 字段。
- Stop 只累计 turn 引用；25 个新 turn＋5 个 context-only overlap 或 compact 后运行 Gate＋Refiner；批次 stale/事务 Apply。
- Sidecar 内部 24 小时知识整合；同仓 active 卡只生成无损 merge/conflict 待核对建议，确认 merge 后主卡升版、相关卡归档且历史保留。
- 项目隐性知识卡：decision、invariant、pitfall、lesson，以及 title/knowledge/rationale/applicability。
- 待核对、记忆、模型、健康四页看板；确认、回滚、归档、硬删除、仓库暂停/清空和来源命令。
- loopback Host/Origin/CSRF、一次性 fragment bootstrap、HttpOnly Cookie、CSP/no-store。
- macOS Keychain、launchd KeepAlive、本地 Codex marketplace/plugin、安装和保留数据的卸载。

## 验证结果

- P0-01 至 P0-25：全部通过；核心测试 56/56。
- Docker 核心：固定 Node 24.15.0 镜像内 typecheck、lint、结构检查、56/56 核心测试、文档一致性和 build 全部通过。
- macOS 宿主：3/3，通过真实 Keychain、Unix socket/权限、plugin、launchd、dashboard；未使用容器结果替代。
- Codex plugin validator：通过。
- Codex CLI：`codex-local-memory@codex-local-memory-local` 为 `installed, enabled`。
- Hook trust：`SessionStart`、`UserPromptSubmit`、`Stop` 三个当前 plugin 身份均存在持久化 `trusted_hash`，未使用绕过参数。
- Hook 实跑：在正式安装目录和真实 `$PLUGIN_ROOT` 下，三个包装命令均 exit 0、stderr 为空；无匹配知识时 UserPromptSubmit 空注入，Stop stdout 精确为 `{"continue":true}`。
- 模型复测：`gpt-5.5` 的 Gate、Refiner、知识整合三份 strict Schema 共 3 次请求通过；知识整合再从两张同范围生成代码坑点与一张无关 Socket 决策中，只输出前两张的无损 merge，一次通过 ID/version/范围校验。全部为隔离合成内容，不写正式数据库。Stop 与 UserPromptSubmit 不调用模型。
- 项目隐性知识回归：Gate 从隐藏生成约束、普通文件事实和一次性格式要求中只选中隐藏约束；Refiner 生成中文 `pitfall`。首次矛盾 Gate 输出被严格语义校验拒绝，强化不变量后再次通过；未写正式数据库。
- 正式运行状态：`gpt-5.5`、三份 strict Schema 已验证、`auto_extract=true`、SQLite `ok`、failed/pending consolidation 均为 0；旧版 5 张不兼容四字段卡已按用户授权通过 Sidecar 永久清除。随后正式 Gate/Refiner 已为 cloud-server 形成 4 张五字段 active 知识卡并进入待核对，证明端到端写回可用。
- 最终 lint、结构检查、类型检查、构建和文档一致性：全部通过。

## 剩余 P1

- Turn 级版本钉住与升级 staging/哈希/原子切换增强。
- enqueue、Apply、FTS、硬删除、备份各崩溃点的系统化注入测试。
- 带 schema version 的数据库迁移与失败回退。
- DB 大小、保留期、job 重试、dead-letter 上限配置。
- 更完整的 `Retry-After` 调度策略与安装时 Hook 命令展示。

## 已知限制

- 不承诺未来任意 rollout 结构都兼容；未测试 CLI 只要必需结构兼容即可使用，结构变化时 fail-closed 并告警。
- 当前 Gate/Refiner 使用 `gpt-5.5`；更换 Origin 或模型会关闭自动提炼并要求重新验证。
- 看板固定使用 `127.0.0.1:43127`；端口被其他进程占用时 Sidecar 会失败并由 Hook fail-open。
- 项目知识只在单 session 累积 25 个新 turn 或发生 compact 后，经 Gate＋Refiner 才形成；检查点前不会参与召回。
- 每日整合输入上限为 80,000 字符；超过时整次安全跳过并告警，首版不做可能漏掉跨批关系的局部整合。
- Docker 使用固定 Node 镜像 digest `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` 完成验收。
