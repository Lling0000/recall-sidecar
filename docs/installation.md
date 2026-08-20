# macOS 安装与运行

支持 Node `>=24.15.0 <25`。Codex CLI 不设版本白名单；安装器记录版本，运行时按 rollout 必需事件结构判断兼容。未测试版本结构兼容即可使用，结构不兼容时安全跳过并告警。

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

安装后的宿主验收：

```bash
CLM_EXPECT_INSTALLED=1 npm run test:host
```

打开看板：

```bash
node "$HOME/Library/Application Support/codex-local-memory/runtime/cli.js" dashboard url
```

命令返回含一次性 URL fragment 的本机看板地址。看板只有待核对、记忆、模型、健康四页。模型页填写 HTTPS Base URL、Gate/Refiner/知识整合共用模型和 API Key；Key 只进入 macOS Keychain。点击「保存并测试」会验证 Gate、Refiner、知识整合三份 strict Schema；通过后，唯一开关用于同意 25 回合或 compact 检查点最多 40,000/80,000 字符的安全投影外发，以及每日只发送同仓 active 知识卡做合并/冲突/split 检查。Stop 不调用模型。软件升级导致 Schema revision 变化时会自动关闭提炼，必须重新测试后再开启。

每日整合建议显示在「待核对」。建议本身不改变召回；确认 merge 后主卡升版、相关卡归档；确认 split 后原卡升版并创建其余原子卡。conflict 只展示，不自动选择胜者。系统不会为了减少卡片数量强行合并，形成依据默认折叠。

卸载：

```bash
node "$HOME/Library/Application Support/codex-local-memory/runtime/cli.js" uninstall
```

卸载会停止 launchd、移除 plugin 与 runtime，但默认保留数据库和 Keychain 配置，便于重新安装。正式数据不写入源码仓库或业务仓库。
