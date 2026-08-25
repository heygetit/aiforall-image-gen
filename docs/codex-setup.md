# Codex 安装与恢复

本项目把 marketplace 放在 Codex 临时目录之外，避免 Codex 升级清理缓存后丢失插件入口。安装脚本不保存 Key，也不会替换用户已有的全局规则。

## 一键安装

在从 GitHub 拉取的仓库根目录执行：

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex.ps1
```

### macOS/Linux

```sh
sh ./scripts/install-codex.sh
```

默认持久 marketplace 路径为 Windows `%USERPROFILE%\codex-marketplaces\aiforall-plugins`，POSIX 为 `$HOME/.codex-marketplaces/aiforall-plugins`。已有目录只执行 `git fetch` 和 fast-forward；有未提交修改时会停止，不执行 reset、checkout 或删除操作。安装会检查 Git、Codex CLI、Node.js 18+、Python 3 和 Pillow，并运行插件离线 self-test。

旧版 Codex 没有 `codex plugin add` 时，脚本仍会注册 marketplace 和启用配置；重启 Codex 后在插件市场安装一次即可。新版本会自动执行：

```text
codex plugin marketplace add <persistent-marketplace-path>
codex plugin add aiforall-image-gen@aiforall-plugins
```

## Key 配置

推荐只在当前 shell 设置环境变量：

```powershell
$env:AIFORALL_API_KEY = "<gpt-image-2-key>"
```

需要持久化时使用隐藏输入：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-key.ps1
```

```sh
sh ./scripts/configure-key.sh
```

Key 写入 `%USERPROFILE%\.codex\aiforall-image-gen-config.json` 或 `$HOME/.codex/aiforall-image-gen-config.json`，文件不复制到 marketplace、不进入 Git，输出只显示前后缀。可选的 `gpt-image-1.5` Key 仅用于明确请求的 `--native-transparent`。检查配置但不写入：

```powershell
powershell -File .\scripts\configure-key.ps1 -CheckOnly
```

## 升级后恢复

Codex 升级或缓存丢失后，在任意位置运行仓库中的恢复脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-codex.ps1
```

```sh
sh ./scripts/restore-codex.sh
```

恢复会更新干净的持久仓库、重新注册 marketplace、启用插件并检查 manifest、版本、Node 语法和 worker self-test。它不会把文件直接复制到 Codex cache；缓存缺失时会明确提示重启 Codex 或从插件市场点击安装。只检查不修改：

```powershell
powershell -File .\scripts\restore-codex.ps1 --check-only
```

也可以指定 fork：`--repo https://github.com/<owner>/<repo>`。若持久仓库有本地改动，恢复只报告并停止更新。

## 全局规则与卸载

安装会在用户级 `AGENTS.md` 和 `instruction.ctf.md` 中追加同一段带标记的图像生成规则。已有内容保持不变，首次修改前会创建时间戳备份；重复运行只替换托管区块，不会追加第二份。规则只约束图像生成任务，不覆盖安全、隐私或项目自身规则。

卸载插件请使用 Codex 自带命令：

```text
codex plugin remove aiforall-image-gen@aiforall-plugins
codex plugin marketplace remove aiforall-plugins
```

然后手动删除持久 marketplace 和配置文件；脚本不会自动删除用户数据。Windows、macOS、Linux 的差异仅在脚本后缀和用户目录路径，插件本身使用 `CODEX_HOME`（如需隔离测试可临时设置该变量）。

## 故障排查

- `Missing prerequisites`：安装 Git、Codex CLI、Node.js 18+、Python 3 和 Pillow；离线测试可加 `--skip-dependencies`。
- `local changes`：进入持久 marketplace 提交或处理改动后，再运行恢复；脚本不会强制覆盖。
- `plugin cache missing`：这是可恢复状态，重启 Codex 或在已注册 marketplace 中安装插件，不要手工复制 cache。
- `fetch failed`、超时或断流：请求状态未知，禁止自动重发；先检查 aiforall.me 请求历史。外层命令超时至少 360 秒，API 请求至少 300 秒。
