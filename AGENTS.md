# AGENTS.md

给实现本仓库 `Company-Agent-Memory-Implementation-Spec.md` 的编码 Agent。产品行为、数据合同和验收以 Spec 为唯一事实源；本文件只规定实施纪律，不另起产品。

开工前必须读完 Spec 第 2 节、3.1～3.4、3.7～3.10、4.1～4.4、5～7 节及 `docs/project-tacit-memory-design.md`。MemoraX / Prime 只作附录对照；允许借鉴 Gate＋Refiner 检查点思想，但只处理本产品项目隐性知识卡，禁止照搬其 skill、prompt、subagent、云端账号、system prompt 总览或无 Git 命名空间。

## 技术栈与运行形态

- 统一使用 TypeScript / Node.js，提交锁文件并固定支持的 Node 范围。
- 正式系统只在 macOS 宿主机运行：Codex plugin、Hook、Sidecar、launchd、Keychain、Unix socket、SQLite 和看板不得放进 Docker。
- Docker 只用于开发、测试和 CI，覆盖 parser/repo fixture、SQLite/FTS、模型 mock、Sidecar 可移植核心和看板。
- Docker 不得挂载真实 `~/.codex`、Keychain 或正式数据目录；Keychain/launchd 使用测试替身。
- 真实 plugin trust、Codex Hook、Keychain、launchd、宿主 Unix socket 和权限测试必须在 macOS 宿主机执行，不能用容器结果替代。

## 禁止

- 不做 Codex Skill / `$xxx` 搜索入口；首版由 UserPromptSubmit 自动召回。
- 不做向量库、embedding、廉价意图模型或独立判断 Agent。Stop 不调用模型；同一已配置高质量模型在每个 session 累积 25 个正常完成回合或 `compact` 后依次运行 Gate 与 Refiner。
- 不用词表作提炼硬门；检查点固定 overlap 仍不足以确认时必须跳过。
- 不信任 `last_assistant_message`、`task_complete.last_agent_message` 或 commentary；不得执行 `git` 二进制。
- 不读取或存储 reasoning、工具调用/输出、检索事件、token_count、world_state 或媒体路径。
- UserPromptSubmit stdout 只能是本文件规定的 Hook JSON 信封；`additionalContext` 值必须是纯文本，禁止嵌套记忆 JSON、角色对象、工具协议或第二层信封。
- 不教或调用 `--dangerously-bypass-hook-trust`，不与 MemoraX 三个 Hook 并行。
- UserPromptSubmit 和所有 Hook 进程内禁止 HTTP 调模型；三个 Hook 永远 exit 0。
- Stop stdout 必须包含 `{"continue": true}`，不得自动续跑。
- 不回退自由文本、普通 JSON/JSON mode，不为解析失败再调用模型 repair，不接受 `supersede`。
- 看板不提供首页、设置、导出、手工创建/编辑记忆正文或合并仓库。

## 产品名与固定路径

- 看板仓库标题：只显示仓库名称，不加产品前缀；路径作为副标题保留
- 正式数据目录：`~/Library/Application Support/codex-local-memory/`
- Unix socket：数据目录下 `sidecar.sock`
- Keychain service：`codex-local-memory`
- Keychain account：`extract-api-key`
- Key 引用：`os-keychain://codex-local-memory/extract-api-key`
- launchd label：`local.codex-memory.sidecar`
- plugin 目录名：`codex-local-memory`（`.codex-plugin/plugin.json` + `hooks/hooks.json`，命令用 `$PLUGIN_ROOT`）

项目源码只在本仓库开发；安装后不得要求源码目录继续存在。正式数据不得写入本仓库或任何被 Codex 打开的业务仓库。

## 仓库与会话身份

- Git：只读解析 `.git`、`gitdir`、`commondir`，身份为 `sha256(realpath(common_dir))`。worktree 共享，独立 clone 隔离；remote 只作标签。
- 无 Git 或 Git 元数据不可用：根目录为 SessionStart 初始 `cwd`（损坏 `.git` 时取发现该 `.git` 的层级），身份为 `sha256(realpath(root_dir))`。同名不同路径隔离；移动/重命名后视为新身份。
- 禁止按文件夹名合并无 Git 项目，禁止扫描 `package.json`、`AGENTS.md` 等文件猜项目根。
- `sessions(client,native_session_ref)` 唯一。一个 `repo_id` 可绑定多个 session；Turn 属于 session，记忆属于 repo。
- session 一旦绑定 `repo_id` 就保持粘性。Git session 每轮重算 `common_dir`；folder session 允许 cwd 等于绑定 `root_path` 或位于其目录边界内。进入子目录不得产生新 repo，离开绑定根或切到另一 repo 时当前轮空操作，不重绑、不串写。
- 目录日后 `git init` 不自动迁移 folder 记忆；首版不合并 repo。

## Hook 与 rollout 投影

只注册 `SessionStart`、`UserPromptSubmit`、`Stop`：

- SessionStart：1 秒内探活并绑定 `session_id → repo_id`，不启动 Sidecar、不扫描工作树。
- UserPromptSubmit：使用官方字段 `session_id`、`turn_id`、`cwd`、`prompt`；Prompt 只在内存中做 FTS，不落盘；IPC 250 ms，失败空注入。
- Stop：使用官方字段 `session_id`、`turn_id`、`transcript_path`、`cwd`；1 秒内只入队，不读 rollout、不调模型，忽略 `last_assistant_message`。

Codex 兼容性按 rollout 必需事件结构判断，不设 CLI 完整版本白名单。`0.148.0-alpha.9` 仅是首个测试 fixture。未测试版本只要结构兼容就正常工作；结构不兼容时 fail-closed 并报告 `incompatible_rollout_shape`，不得猜字段。

一轮窗口必须精确匹配 Stop 的 `turn_id`：`event_msg.task_started` → 同 turn 的 `event_msg.task_complete`。禁止退化为“最新完整窗口”。

- 用户 Prompt：窗口内最后一条 `type=event_msg` + `payload.type=user_message` 的 `payload.message`；若以 `<environment_context` 开头则跳过并向前找。空则不抽。
- 最终回答：窗口内最后一条 `payload.type=agent_message` 且 `payload.phase=final_answer` 的 `payload.message`；没有则不抽。
- overlap 用户句：只对前 5 个已处理完整窗口重复同一 Prompt 投影规则；只能作上下文，不能成为 edit 来源。
- 子代理不抽：`thread_source != "user"`、source 为 subagent 或存在 `inter_agent_communication_metadata`。

Prompt 和最终回答只在检查点 job 内存中存在，也是启用 `auto_extract` 的捆绑必选外发字段。看板只提供一个自动知识开关：开启即同意 25 回合/compact 检查点外发和只含 active 卡片的每日整合，关闭即撤回并停止新检查点与整合。外发前仅遮蔽 PAT、JWT、PEM 和高熵密钥；普通文本、路径和文件夹名不处理。DB、WAL、备份、FTS 和日志禁止保存 Prompt/回答正文。只可保存 session/turn 引用、不可逆投影摘要、状态、错误元数据和项目知识卡；重试重新读取同一 rollout，文件不可用则失败。

Stop 只累计 turn 引用，不调用模型。每个 session 的 25 个新 turn 或 `compact` 触发检查点；额外带前 5 个已处理 turn 作为 context-only overlap。Gate 最多读取 40,000 字符，只能选择本批新 turn；Refiner 最多读取 80,000 字符并输出最多 8 个 create/update edit。只保存项目工作中形成、未来仍有用且不能简单从当前代码或文档重读得到的 `decision | invariant | pitfall | lesson`。普通代码事实、目录摘要、一次性要求、进度、个人偏好、通用流程和无证据推测都不保存。完整规则以 `docs/project-tacit-memory-design.md` 为准。

## 抽取模型合同

模型 Base URL 只接受 HTTPS，必须使用 API Key，不支持 HTTP loopback 本地模型。保存配置时必须分别验证 Gate、Refiner 与定时知识整合三份正式 strict Schema；任一不支持时 `auto_extract` 保持关闭。项目知识卡固定为：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["kind", "title", "knowledge", "rationale", "applicability"],
  "properties": {
    "kind": { "enum": ["decision", "invariant", "pitfall", "lesson"] },
    "title": { "type": "string", "minLength": 1, "maxLength": 40 },
    "knowledge": { "type": "string", "minLength": 1, "maxLength": 240 },
    "rationale": { "type": "string", "minLength": 1, "maxLength": 200 },
    "applicability": { "type": "string", "maxLength": 80 }
  }
}
```

Gate Schema 固定为 `should_refine + selected_turn_ids[≤8]`；selected 只能来自 eligible turn，不能来自 overlap。Refiner edit 固定为 `action=create|update + source_turn_id + target/base + memory`。产品不设置每日模型请求次数上限；429/5xx 只允许一次有界传输重试，不得解析 repair。

Refiner Apply 使用 `BEGIN IMMEDIATE`。提交前重读所有目标并校验 `base_version`、tombstone、repo 与 eligible 来源 turn；任何失败整体回滚。过期结果不生效，等待后续检查点重新读取，不覆盖人工动作。active 只在 Refiner 事务提交后可见；turn 引用、overlap、Gate 和 Hook 都不写 memory/FTS。

Sidecar 每 24 小时在进程内为 active 知识不少于 2 条的 repo 运行一次知识整合，不安装额外 cron/launchd。整合只读取同仓 active 卡片，最多 80,000 字符；只生成最多 8 条 `merge|conflict` 待核对建议。合并只允许同 kind、同等 applicability、同主题且无冲突的重复或互补卡片，不能扩大范围或损失非重复知识。建议不自动生效；确认 merge 后事务化更新主卡版本并归档相关卡，禁止自动硬删除。conflict 不自动裁决。活跃数量不是优化指标。

## 召回 stdout 与 IPC

UserPromptSubmit 成功时只输出：

```json
{
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<纯文本>"
  }
}
```

模板见 Spec 3.7。查询必须先限定 `repo_id`，再对用户输入 tokenize/quote 后做 FTS；中文用 trigram 或 CJK n-gram。最多 3 条、总计不超过 2,000 字符，默认只渲染 kind + title + knowledge + 可选 applicability；rationale 默认不注入。失败返回空注入。

Hook → Sidecar 使用 Unix socket 和一行一个 JSON 请求。UserPromptSubmit 截止 250 ms；SessionStart、Stop 截止 1 秒且 Stop 只入队。Sidecar 不可用时 fail-open。只有 Sidecar 可以写 SQLite。

## 看板与来源

- 四页：待核对、记忆、模型、健康。定时知识整合建议复用「待核对」，不新增页面。
- 允许：确认、回滚、归档、硬删除、仓库暂停、模型配置、单一自动抽取开关和健康查看。
- 禁止：手工创建/编辑正文、导出、repo 合并。
- 来源只保存 `client/session_id/turn_id/time` 等引用，不复制 Codex 会话正文。
- 来源操作只复制 `codex resume <session_id>`；不使用未公开 `codex://` 深链，不承诺精确滚动到 turn。原会话不存在时安全提示不可用。

## 合入门槛

- Docker 核心测试与 macOS 宿主集成测试必须分开报告。
- 必须覆盖 Spec 第 7 节全部 P0，特别是多 session 共享、worktree/clone、无 Git 同名路径隔离、跨仓 cwd、正文不落盘、strict Schema、stale、来源命令和 Apply 前后可见性。
- 修改 Spec 中任一硬规则时，同一变更必须同步本文件及对应 P0；禁止只改一处。
