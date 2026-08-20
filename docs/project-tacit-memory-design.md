# 项目隐性知识检查点设计

状态：首版产品事实补充  
日期：2026-08-19

## 1. 目标

系统只沉淀无法通过简单重读当前代码或文档立即得到、并且未来在同一仓库仍有价值的项目隐性知识：

- `decision`：设计决策与权衡；
- `invariant`：容易被破坏的隐藏约束；
- `pitfall`：真实遇到的坑、失败方案与失败原因；
- `lesson`：经过项目工作得到的可复用工程结论。

不保存个人偏好、通用流程、一次性要求、当前进度、目录清单、普通代码摘要或无证据推测。本系统不是项目文档索引，也不做 Skill、Prompt 或 Subagent 自修改。

活跃知识数量不是优化指标。新经验可以继续增加知识；整合只消除有把握的重复，不追求卡片单调减少。一个健康仓库的 active 集合应当是增减并存、信息密度逐渐提高，而不是越少越好。

## 2. 三个 Hook 的职责

只注册现有三个 Codex Hook，不新增 Compact Hook：

```text
SessionStart(startup|resume|clear)
→ 绑定 session_id 与 repo_id

SessionStart(compact)
→ 保持原 session 绑定
→ 只入队检查点

UserPromptSubmit
→ 只召回已经正式沉淀的 active 项目知识
→ 不调用模型

Stop
→ 只记录 session_id / turn_id / transcript_path / cwd
→ 不读 rollout、不调用模型
→ 永远 continue:true
```

`compact` 是 SessionStart 的 source，不是第四种 Hook，也不是压缩正文。

## 3. 检查点与 overlap

每个 session 独立累计正常完成的 turn：

- 25 个尚未检查的新 turn 触发一次检查点；
- `SessionStart(source=compact)` 在存在尚未检查 turn 时立即触发；
- 每批最多 25 个新 turn；
- 额外读取上一检查点最后 5 个已处理 turn 作为 context-only overlap。

```text
上一批最后 5 个已处理 turn（只提供上下文）
+
本批最多 25 个新 turn（唯一可成为知识来源）
```

Gate 的 `selected_turn_ids` 只能引用本批新 turn，不能引用 overlap turn。成功后只把实际看过的新 turn 标记为 processed；因字符上限未进入模型的 turn 保持 pending。

字符边界：

- Gate 输入最多 40,000 字符；
- Refiner 输入最多 80,000 字符；
- 超限时先删除最旧 overlap；
- 仍超限时只取能够完整放入的最早新 turn；
- 不截断半个 turn，不把未读 turn 标记为已处理。

## 4. Gate

Gate 使用配置的高质量模型和严格 Structured Output，只回答：

> 这里是否存在只有经历本项目工作后才得到、未来仍有用、且不能简单从当前代码或文档重新读取的知识？

输入：

- 安全投影 turn：仅用户 Prompt 与最终回答；
- overlap turn；
- 本批 eligible turn ID；
- 当前仓库 active 知识卡。

输出：

```json
{
  "should_refine": true,
  "selected_turn_ids": ["turn-id"]
}
```

最多选择 8 个本批新 turn。`false` 时数组必须为空。Gate 不生成知识正文、不写 memory/FTS。

## 5. Refiner

Gate 通过后，同一高质量模型运行 Refiner。输入为同一安全上下文、Gate 选中的 turn 和当前 active 知识。

Refiner 输出最多 8 个 create/update edit：

```json
{
  "edits": [
    {
      "action": "create",
      "source_turn_id": "turn-id",
      "target_memory_id": null,
      "base_version": null,
      "memory": {
        "kind": "pitfall",
        "title": "生成文件不可直接修改",
        "knowledge": "直接修改生成文件会在重新生成时被覆盖，应修改生成源。",
        "rationale": "本次任务中直接修改后的内容被生成器覆盖。",
        "applicability": "本仓库生成代码"
      }
    }
  ]
}
```

`update` 必须引用输入 active 知识的精确 ID/version。Refiner 不允许自动硬删除；过期或不再适用的知识由看板人工归档或删除。

## 6. 项目知识 Schema

```text
kind          decision | invariant | pitfall | lesson
title         1～40 字
knowledge     1～240 字
rationale     1～200 字
applicability 0～80 字
```

卡片使用用户主要语言并保留技术术语。不得包含链接、代码块、角色标记或工具协议。来源只保存 session/turn 引用，不复制对话正文。

召回默认渲染：

```text
[kind] title：knowledge（applicability）
```

`rationale` 用于看板核对和后续 Refiner 对照，默认不注入 UserPromptSubmit。

## 7. Apply 与失败

Refiner edit 在一个 `BEGIN IMMEDIATE` 事务中：

1. 校验 source turn 属于本批 eligible turn；
2. 重读 repo、target、base_version 与 tombstone；
3. 校验全部卡片；
4. 写 version、切 active、更新 FTS、audit 与 pending review；
5. 整批提交。

任一步失败整批回滚。Gate/Refiner 失败或 stale 时，新 turn 保持 pending，后续检查点重新处理；现有 active 知识不变。最终 create/update 都进入待核对，但 Apply 后立即参与召回。

## 8. 隐私与外发

rollout 只按兼容的必需事件结构投影：

- 用户 Prompt；
- `phase=final_answer` 最终回答。

禁止读取或外发 reasoning、commentary、工具调用/输出、token_count、world_state、媒体路径或完整 rollout。外发前遮蔽 PAT、JWT、PEM 与高熵密钥。Prompt/回答只存在于检查点内存，不进入 SQLite、WAL、备份、FTS 或日志。

## 9. Codex 版本兼容

产品不按 Codex CLI 完整版本号设置白名单，也不因出现未测试的新版本而拒绝安装。兼容判断只基于 rollout 的必需结构：

- `session_meta.payload.id` 与非空 `cli_version`；
- `event_msg.task_started` / `task_complete` 的精确 `turn_id`；
- `event_msg.user_message.payload.message`；
- `event_msg.agent_message.payload.phase=final_answer` 与 `payload.message`；
- 用户根线程判定字段。

新版本增加额外 record 或 payload 字段时一律忽略，不影响兼容。若缺少必需字段、turn 窗口不闭合或事件结构改变，则该检查点 fail-closed，健康页显示 `incompatible_rollout_shape`；禁止猜字段、禁止回退 `last_agent_message`，也禁止读取 reasoning 或工具输出。

仓库保留已测试 CLI 版本列表作为健康信息和 fixture 回归证据，但它不是运行白名单。安装器只要求 `codex --version` 返回非空完整版本字符串。

## 10. 定时知识整合

Sidecar 常驻进程每 24 小时为 active 知识数量不少于 2 的 repo 调度一次整合检查，不安装额外 cron 或第二个 launchd job。使用持久化的 `last_consolidation_at:<repo_id>` 防止进程重启后重复执行。

整合只在 `auto_extract` 已开启且模型的整合 strict Schema 已通过连接测试时运行。连接测试分别标记 `gate_*`、`refiner_*`、`consolidation_*` 失败阶段，任一失败都保持关闭。模型只读取同仓 active 项目知识卡，不读取原始对话、rollout 或来源会话。一次输入最多 80,000 字符；超过上限时整次安全跳过并报告 `consolidation_input_too_large`，首版不做可能漏掉跨批关系的局部自动整合。

严格输出最多 8 条建议：

- `merge`：两个或多个知识实质重复、部分重叠或应合成一个更完整主题；
- `conflict`：知识在相同适用范围内互相矛盾，无法仅凭现有卡片安全决定；
- 无建议：保持不变。

`merge` 必须同时满足：

1. 全部卡片属于同一 repo；
2. `kind` 相同，且 `applicability` 字符串完全相同；首版不让模型自行扩大或改写适用范围；
3. 核心主题相同，内容是重复或互补，不存在互斥结论；
4. 建议卡保留全部非重复 `knowledge` 与关键 `rationale`；
5. 不扩大适用范围，不把多个独立主题为了减少数量强行拼接。

任一条件无法确认就不建议 `merge`。相同主题但结论互斥时只能输出 `conflict`；类型不同、适用范围不同或只是关键词相似时保持不变。

模型建议包含目标 knowledge ID/base_version、相关 knowledge ID/version、建议后的完整知识卡和判断原因；Sidecar 再按参与卡的排序后 ID/version 计算稳定指纹。建议进入「待核对」，不自动改变召回结果。同一组版本已经存在 pending 或 ignored 建议时不重复创建；任一参与卡版本变化后才允许重新建议。

用户确认 `merge` 后在一个事务中：

1. 重读全部目标版本和 repo；
2. 为主知识创建新 version；
3. 将被合并知识标为 archived，但保留其全部版本和来源；
4. 更新 FTS、generation 与 audit；
5. 标记建议 applied。

`conflict` 只展示对照，不自动选择胜者；用户可以忽略建议，或等待后续项目证据由检查点 Refiner 更新。首版不提供手工改写建议正文。

自动禁止硬删除 knowledge、memory_versions、来源引用或 tombstone。整合失败只记录错误码和时间，不影响 Hook、召回或下一次检查点；错误审计永久保留，失败 job 元数据可在三份 strict Schema 后续全部复测成功时清理，避免已解决告警永久占据健康页。

因此 active 数量不是单向变化：新检查点可能增加卡片，明确更新通常保持数量，确认合并会减少 active 数量，冲突和忽略不会改变数量。历史版本与被归档卡仍保留，不计入 active 召回。

## 11. 验收重点

- 第 24 个新 turn 后无长期知识；第 25 个触发检查点；
- compact 可提前触发，但没有 pending turn 时不重复运行；
- overlap turn 可被模型读取但不能成为 edit 来源；
- 超过字符边界的未读 turn 不得被标记 processed；
- Gate false 不产生知识；
- Refiner create/update 经事务后才可召回；
- 同 repo 多 session 的最终知识共享，但检查点计数按 session 隔离；
- DB/日志/备份无 Prompt 和最终回答原文。
- 未测试但结构兼容的 CLI 版本正常投影；结构不兼容时安全跳过并告警。
- 每日整合幂等；建议不自动改变召回；确认 merge 后主卡版本化、相关卡只归档不硬删除。
- 整合不得以减少数量为目标；类型、适用范围或结论不一致时不能合并，冲突不能自动裁决。
