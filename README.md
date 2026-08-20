# Recall Sidecar

Recall Sidecar 是面向本地 coding agent 的仓库级项目隐性知识 Sidecar。它按本机 Git `common_dir` 或无 Git 根目录真实路径隔离仓库；Stop 只累计 turn 引用，25 回合或 compact 后由 Gate＋Refiner 提炼 decision、invariant、pitfall 和 lesson。

Sidecar 每 24 小时只比较同仓 active 知识，生成待核对的无损合并、冲突或拆分建议。它不以减少数量为目标、不自动裁决冲突；只有用户确认后才执行 merge 或 split。

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
CLM_EXPECT_INSTALLED=1 npm run test:host
```

安装、启用 Hook、打开看板和卸载步骤见 [docs/installation.md](./docs/installation.md)。测试边界和 P0 映射见 [docs/testing.md](./docs/testing.md)。

首版最终实现与验收结果见 [docs/implementation-report.md](./docs/implementation-report.md)。

首版不包含 embedding、向量库、Skill 搜索入口、手工创建/编辑知识、导出或仓库合并。25 个新 turn 或 compact 检查点经 Gate＋Refiner 后才沉淀项目知识；新卡 knowledge 最多 120 字，历史长卡召回时也只注入约 120 字。
