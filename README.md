# aiforall-image-gen

`aiforall.me` 官方 Codex 图像生成插件。默认通过
`https://aiforall.me/v1/images/generations` 和 `/v1/images/edits`
调用 `gpt-image-2`，支持灵活尺寸、图像编辑、透明背景、SSE 预览、批量任务、断点续跑和最多 10 个 worker。

## 环境

- Codex
- Node.js 18+
- Python 3 + Pillow，用于图像校验、精确尺寸、mask 和色键去背
- 可选 `rembg[cpu]`，用于复杂或非纯色色键背景的本地 AI 去背兜底
- `aiforall.me` API Key

```powershell
node --version
python --version
python -c "import PIL; print(PIL.__version__)"
```

## 安装

```powershell
codex plugin marketplace add heygetit/aiforall-image-gen
codex plugin add aiforall-image-gen@aiforall-plugins
```

## 配置 Key

推荐使用环境变量。不要把真实 Key 写入源码、日志、提交或聊天：

```powershell
$env:AIFORALL_API_KEY="<YOUR_AIFORALL_IMAGE_KEY>"
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --get-config
```

单次 Images API 请求默认等待 `300` 秒。网络较慢时可继续调高，但不能降低到 300 秒以下：

```powershell
$env:AIFORALL_REQUEST_TIMEOUT_SECONDS="420"
```

Codex 或其他 shell 调用器应将整条命令的执行超时设置为至少 `360` 秒；如果调高了 API 超时，则命令超时应至少为 API 超时加 `60` 秒，为响应下载、精确缩放和透明后处理预留时间。

也可以保存到权限受限的 `~/.codex/aiforall-image-gen-config.json`：

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --set-key "<YOUR_AIFORALL_IMAGE_KEY>"
```

`AIFORALL_API_KEY` 优先于本地配置中的主 worker；最多可配置 10 个独立 Key。多 worker 只并行独立任务，不会加速单张图片。

`gpt-image-1.5` 使用独立的 native Key 池，避免普通分组 Key 被误用：

```powershell
$env:AIFORALL_IMAGE15_API_KEY="<YOUR_GPT_IMAGE_15_KEY>"
$env:AIFORALL_IMAGE15_API_KEYS='["<KEY_1>","<KEY_2>"]'
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --add-native-worker-key "<YOUR_GPT_IMAGE_15_KEY>" --worker-name native-1
```

## 生成

默认输出到调用命令时所在项目的 `aiforall-image-gen/` 文件夹。

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗"
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "产品海报" --size 1280x720 --quality high
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "竖版海报" --aspect 9:16
```

`gpt-image-2` 支持 `auto` 或满足以下条件的 `WIDTHxHEIGHT`：最大边 3840、两边均为 16 的倍数、长短边不超过 3:1、总像素为 655,360 至 8,294,400。

## 透明背景

默认透明路径只提交一次 `gpt-image-2` 请求。插件保留 source，先使用 Pillow 做边界采样、背景连通分析、软蒙版和 despill；验证不通过时才尝试本地 `rembg`：

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "白色陶瓷杯商品切图" --transparent
```

```powershell
python -m pip install "rembg[cpu]"
```

`rembg` 默认使用 `u2net`，可用 `--rembg-model` 覆盖。插件不会自动安装依赖或下载模型；`--no-rembg` 禁用 AI 兜底，`--keep-source` 保留 `*.source.png`。

截至 2026-07-30，在线验证确认 `gpt-image-1.5` 普通生图可用，但 aiforall.me 当前路由会对 `background=transparent` 返回 HTTP 400：`Transparent background is not supported for this model.`。因此生产环境的透明输出应使用上面的 `gpt-image-2 --transparent` 分层流程；玻璃、烟雾等真实半透明材质可能仍不及模型原生 alpha。

`--native-transparent` 暂时保留为显式、实验性的 native-alpha 能力探测，不应作为当前生产流程：

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "透明玻璃瓶商品切图" --native-transparent --output-format png --size 1024x1024
```

脚本不会静默切换模型。遇到上述 HTTP 400 时，只报告 `[CAPABILITY-UNAVAILABLE]` 并停止，不换 Key；若未来服务端开放该能力，`gpt-image-1.5` 仍只使用 native Key 池。明确的权限或 `Upstream access forbidden` 错误可以换下一个 native Key，超时、断流和普通网关错误不会重发。native Key 全部失败后脚本停止，不会自动产生一笔 `gpt-image-2` 请求。若需要改走 `gpt-image-2 --transparent`，必须由用户确认后另起一次付费请求。

## 编辑

最多可在一个请求中按顺序上传 16 张参考图。`--mask` 作用于第一张图，必须带 alpha、与第一张图尺寸一致且小于 50 MB。

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --edit `
  --image "person.png" --image-role "identity" `
  --image "product.png" --image-role "product" `
  --mask "mask.png" --prompt "只替换产品，保持人物身份和构图" --size 1024x1536
```

`gpt-image-2` 输入恒为高保真，不能设置 `--input-fidelity`。该参数只用于 `gpt-image-1.5`：

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --edit --model gpt-image-1.5 --image "input.png" --input-fidelity high --prompt "只替换背景"
```

## 批量与安全

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "产品海报" --count 2 --concurrency 1
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --batch-inline "提示词一" "提示词二" --concurrency 1
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "ref.png" --item-dir "items" --template-inline "生成商品展示图" --limit 1 --dry-run
```

批量任务必须先以 `--limit 1 --concurrency 1 --dry-run` 验证数量。如果连接结束前已经收到可验证的完整 JSON 图片结果或 SSE completed 图片事件，插件会保存该图片并报告 `[recovered]`，不会重发请求。若没有收到完整结果，超时、`fetch failed` 或连接断开仍会标记 `[NO-RETRY]`，因为上游可能已经完成图片并产生计费；应先在 aiforall.me 请求历史中查找结果，再决定是否提交新请求。

## 开发验证

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py"
node "plugins/aiforall-image-gen/scripts/generate.mjs" --self-test-adaptive
node "plugins/aiforall-image-gen/scripts/generate.mjs" --self-test-images-api
node "plugins/aiforall-image-gen/scripts/generate.mjs" --self-test-image-stream
node "plugins/aiforall-image-gen/scripts/generate.mjs" --self-test-workflow
```

许可证：[MIT](LICENSE)。
