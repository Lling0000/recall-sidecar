# Recall Sidecar

Recall Sidecar 是面向本地 coding agent 的仓库级纠偏记忆 Sidecar。首版适配 Codex，并以内部组件名 `codex-local-memory` 运行；它按本机 Git `common_dir` 或无 Git 根目录真实路径隔离仓库，通过 `SessionStart`、`UserPromptSubmit`、`Stop` 三个 Hook 自动召回和后台抽取四字段纠偏卡。

产品行为与数据合同以 [Company-Agent-Memory-Implementation-Spec.md](./Company-Agent-Memory-Implementation-Spec.md) 为唯一事实源，实施纪律见 [AGENTS.md](./AGENTS.md)。

## 开发检查

```bash
npm ci
npm run lint
npm run check:structure
npm run typecheck
npm run test:core
npm run build
npm run check:docs
```

Docker 只运行可移植核心测试：

```bash
npm run test:docker
```

macOS 宿主能力单独验证：

```bash
npm run test:host
```

安装、启用 Hook、打开看板和卸载步骤见 [docs/installation.md](./docs/installation.md)。测试边界和 P0 映射见 [docs/testing.md](./docs/testing.md)。

首版最终实现与验收结果见 [docs/implementation-report.md](./docs/implementation-report.md)。

首版不包含 embedding、向量库、Skill 搜索入口、手工创建/编辑记忆、导出或仓库合并。逐轮候选在 25 回合或 compact 检查点经 Gate＋Refiner 后才沉淀为长期记忆。
