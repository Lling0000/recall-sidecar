# 测试边界

`npm run test:core` 覆盖 parser/repo fixture、SQLite/FTS、模型 mock、Sidecar 可移植核心、看板安全和安装布局。测试标题显式标注 Spec 第 7 节的 P0-01 至 P0-24，`npm run check:docs` 会校验没有遗漏。

`npm run test:docker` 只运行核心检查，使用临时目录和测试替身，不挂载真实 `~/.codex`、Keychain 或正式数据目录。

`npm run test:host` 只在 macOS 宿主机运行，验证：

- Keychain service/account 的写入、读取、删除和原值恢复；
- Unix socket 与文件权限；
- launchd label 的真实加载和 KeepAlive；
- Codex plugin 安装状态、Hook 文件及正式数据目录权限；
- Sidecar 停止时三个 Hook 的故障降级。

宿主结果与 Docker 结果必须分开报告。plugin trust 需要在 Codex `/hooks` 中人工审查，不能用容器或绕过参数代替。

抽取语义使用四类固定候选组成检查点：长期规则、一次性要求、已有同主题规则的明确替换、强迫永久记忆的注入。验证候选在检查点前不可召回；Gate 只选择长期 create/update；Refiner 输出中文 create 和精确 base_version update；最终 Apply 后才 active。该真实回归不写正式数据库。
