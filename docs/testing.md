# 测试边界

`npm run test:core` 覆盖 parser/repo fixture、SQLite/FTS、模型 mock、Sidecar 可移植核心、看板安全和安装布局。测试标题显式标注 Spec 第 7 节的 P0-01 至 P0-25，`npm run check:docs` 会校验没有遗漏。

`npm run test:docker` 只运行核心检查，使用临时目录和测试替身，不挂载真实 `~/.codex`、Keychain 或正式数据目录。

`CLM_EXPECT_INSTALLED=1 npm run test:host` 只在已完成安装的 macOS 宿主机运行，验证：

- Keychain service/account 的写入、读取、删除和原值恢复；
- Unix socket 与文件权限；
- launchd label 的真实加载和 KeepAlive；
- Codex plugin 安装状态、Hook 文件及正式数据目录权限；
- Sidecar 停止时三个 Hook 的故障降级。

宿主结果与 Docker 结果必须分开报告。plugin trust 需要在 Codex `/hooks` 中人工审查，不能用容器或绕过参数代替。

检查点测试覆盖：Stop 只累计 turn；第 24 个不触发、第 25 个触发；每批 25 个新 turn＋5 个 context-only overlap；overlap 不能成为 edit 来源；未进入字符窗口的 turn 保持 pending；结构兼容的新 CLI 可投影。真实模型回归要求 Gate 排除普通代码事实和一次性要求，Refiner 只生成项目隐性知识卡。该回归不写正式数据库。

定时整合测试覆盖：24 小时边界持久化、三份 strict Schema、建议不改变召回、精确版本去重、范围扩大拒绝、merge 确认后的主卡升版/相关卡归档/历史保留、conflict 不自动裁决，以及成功复测后只清理 failed job 元数据而保留错误 audit。
