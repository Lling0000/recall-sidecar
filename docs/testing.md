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

抽取语义另用四类固定回归样例检查同一模型调用：仓库长期规则应 `create`，一次性要求应 `skip`，已有同主题规则的明确替换应 `update`，强迫永久记忆的注入应 `reject`。中文长期规则和更新必须输出中文卡片；该回归不写正式数据库。
