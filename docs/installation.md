# macOS 安装与运行

支持 Node `>=24.15.0 <25`。首个 Codex CLI/rollout 白名单仅为完整版本 `0.148.0-alpha.9`；安装器发现其他版本会拒绝安装，运行时发现未知版本会跳过抽取并在健康页告警。

```bash
npm ci
npm run build
node dist/cli.js install
```

安装器会：

1. 拒绝与 MemoraX Code 的同组三个 Hook 并行启用。
2. 把自包含 runtime 和本地 marketplace 复制到 `~/Library/Application Support/codex-local-memory/`。
3. 通过 Codex CLI 安装 `codex-local-memory` plugin。
4. 安装并启动 `local.codex-memory.sidecar` launchd 服务。

随后在 Codex 中检查 `/plugins`，并在 `/hooks` 审查、信任 `SessionStart`、`UserPromptSubmit`、`Stop`；重启 Codex 后新开会话。Hook 不会冷启动 Sidecar。

打开看板：

```bash
node "$HOME/Library/Application Support/codex-local-memory/runtime/cli.js" dashboard url
```

命令返回含一次性 URL fragment 的本机看板地址。看板只有待核对、记忆、模型、健康四页。模型页填写 HTTPS Base URL、逐轮候选模型、Gate/Refiner 模型和 API Key；Key 只进入 macOS Keychain，不支持 HTTP loopback 本地模型。点击「保存并测试」会分别验证候选、Gate、Refiner 三份 strict Schema；通过后，唯一开关用于同意逐轮 Prompt/最终回答，以及 25 回合或 compact 检查点最多 40,000/80,000 字符的安全投影外发。

卸载：

```bash
node "$HOME/Library/Application Support/codex-local-memory/runtime/cli.js" uninstall
```

卸载会停止 launchd、移除 plugin 与 runtime，但默认保留数据库和 Keychain 配置，便于重新安装。正式数据不写入源码仓库或业务仓库。
