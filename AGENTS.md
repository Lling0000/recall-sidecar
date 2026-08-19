# AGENTS.md

给实现本仓库 `Company-Agent-Memory-Implementation-Spec.md` 的编码 Agent。产品行为、数据合同和验收以 Spec 为唯一事实源；本文件只规定实施纪律，不另起产品。

开工前必须读完 Spec 第 2 节、3.1～3.4、3.7～3.10、4.1～4.3、5～7 节。MemoraX / Prime 只作附录对照，禁止照搬其 skill、云端账号、按 N 轮提醒、system prompt 总览或无 Git 命名空间。

## 技术栈与运行形态

- 统一使用 TypeScript / Node.js，提交锁文件并固定支持的 Node 范围。
- 正式系统只在 macOS 宿主机运行：Codex plugin、Hook、Sidecar、launchd、Keychain、Unix socket、SQLite 和看板不得放进 Docker。
- Docker 只用于开发、测试和 CI，覆盖 parser/repo fixture、SQLite/FTS、模型 mock、Sidecar 可移植核心和看板。
- Docker 不得挂载真实 `~/.codex`、Keychain 或正式数据目录；Keychain/launchd 使用测试替身。
- 真实 plugin trust、Codex Hook、Keychain、launchd、宿主 Unix socket 和权限测试必须在 macOS 宿主机执行，不能用容器结果替代。

## 禁止

- 不做 Codex Skill / `$xxx` 搜索入口；首版由 UserPromptSubmit 自动召回。
- 不做向量库、embedding、第二个判断 Agent、廉价意图模型或按 N 轮抽取。
- 不用词表作抽取硬门；本地短句规则只能决定是否第一次带上一轮用户句。
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

开工第一步是固定 Codex CLI 完整版本和对应 rollout fixture。首个白名单版本为 `0.148.0-alpha.9`；只比较 `0.x` 主版本不算兼容。未知完整版本或 fixture 不匹配时不抽取，健康页告警。

一轮窗口必须精确匹配 Stop 的 `turn_id`：`event_msg.task_started` → 同 turn 的 `event_msg.task_complete`。禁止退化为“最新完整窗口”。

- 用户 Prompt：窗口内最后一条 `type=event_msg` + `payload.type=user_message` 的 `payload.message`；若以 `<environment_context` 开头则跳过并向前找。空则不抽。
- 最终回答：窗口内最后一条 `payload.type=agent_message` 且 `payload.phase=final_answer` 的 `payload.message`；没有则不抽。
- 上一轮用户句：仅 3.7 指代流程需要时，对前一个完整窗口重复用户 Prompt 规则。
- 子代理不抽：`thread_source != "user"`、source 为 subagent 或存在 `inter_agent_communication_metadata`。

Prompt 和最终回答只在 job 内存中存在，也是启用 `auto_extract` 的必选外发字段；用户撤回任一项同意时自动关闭抽取。外发前仅遮蔽 PAT、JWT、PEM 和高熵密钥；普通文本、路径和文件夹名不处理。DB、WAL、备份、FTS 和日志禁止保存 Prompt/回答正文。只可保存 session/turn 引用、不可逆投影摘要、状态、错误元数据和四字段记忆卡；重试重新读取同一 rollout，文件不可用则失败。

## 抽取模型合同

连接测试必须使用正式 Schema 验证模型支持严格 `json_schema`；不支持时 `auto_extract` 保持关闭。Schema 必须等价于：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["action", "target_memory_id", "base_version", "memory"],
  "properties": {
    "action": {
      "enum": ["skip", "reject", "create", "update", "need_prev_turn"]
    },
    "target_memory_id": { "type": ["string", "null"] },
    "base_version": { "type": ["integer", "null"], "minimum": 1 },
    "memory": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["title", "wrong_behavior", "correct_behavior", "applicability"],
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 40 },
        "wrong_behavior": { "type": "string", "maxLength": 120 },
        "correct_behavior": { "type": "string", "minLength": 1, "maxLength": 240 },
        "applicability": { "type": "string", "maxLength": 80 }
      }
    }
  }
}
```

Schema 通过后执行 action 语义校验：

- `create`：target/base 均为 `null`，memory 为合法对象。
- `update`：target 为本次同 repo 对照集 ID，base 为其正整数版本，memory 为合法对象。
- `skip` / `reject` / `need_prev_turn`：target/base/memory 全为 `null`。

对照集只取本仓 active 记忆，用本轮用户句（已带上一轮时用两句）FTS，最多 8 条。`need_prev_turn` 最多触发一次追加上一轮后的逻辑重试；已带过仍返回该 action 时当 skip。每个完成 Turn 逻辑抽取 0、1 或最多 2 次；不得 polish 或解析 repair。429/5xx 的一次有界传输重试必须计入每日限额。

Apply 使用 `BEGIN IMMEDIATE`。提交前重读目标并校验 `base_version`、tombstone 和 repo；任何失败整体回滚。`base_version` 过期时 candidate 标记 `stale`，不生效、不自动重跑。active 只在事务提交后可见；Hook 和下一条 Prompt 不等待后台抽取。

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

模板见 Spec 3.7。查询必须先限定 `repo_id`，再对用户输入 tokenize/quote 后做 FTS；中文用 trigram 或 CJK n-gram。最多 3 条、总计不超过 2,000 字符，默认只渲染 title + correct_behavior + 可选 applicability。失败返回空注入。

Hook → Sidecar 使用 Unix socket 和一行一个 JSON 请求。UserPromptSubmit 截止 250 ms；SessionStart、Stop 截止 1 秒且 Stop 只入队。Sidecar 不可用时 fail-open。只有 Sidecar 可以写 SQLite。

## 看板与来源

- 四页：待核对、记忆、模型、健康。
- 允许：确认、回滚、归档、硬删除、暂停、模型配置和健康查看。
- 禁止：手工创建/编辑正文、导出、repo 合并。
- 来源只保存 `client/session_id/turn_id/time` 等引用，不复制 Codex 会话正文。
- 来源操作只复制 `codex resume <session_id>`；不使用未公开 `codex://` 深链，不承诺精确滚动到 turn。原会话不存在时安全提示不可用。

## 合入门槛

- Docker 核心测试与 macOS 宿主集成测试必须分开报告。
- 必须覆盖 Spec 第 7 节全部 P0，特别是多 session 共享、worktree/clone、无 Git 同名路径隔离、跨仓 cwd、正文不落盘、strict Schema、stale、来源命令和 Apply 前后可见性。
- 修改 Spec 中任一硬规则时，同一变更必须同步本文件及对应 P0；禁止只改一处。
