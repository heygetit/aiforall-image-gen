---
name: "aiforall-image-gen"
description: "Generate or edit images through the official aiforall.me Codex plugin. Use for GPT Image generation, local image edits, transparent-background assets, multi-reference edits, batches, or worker-based production workflows."
---

# aiforall-image-gen

Use the bundled script. It sends paid image requests only to `https://aiforall.me/v1/images/generations` and `/v1/images/edits`.

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs"
```

## Entry checks

1. Require Node.js 18+.
2. Check Python 3 and Pillow with `python -c "import PIL"`.
3. Run `--get-config`. Never display or store a full Key in chat, source files, logs, or commits.
4. Use `AIFORALL_API_KEY` for `gpt-image-2`. Use `AIFORALL_IMAGE15_API_KEY`, JSON `AIFORALL_IMAGE15_API_KEYS`, or `--add-native-worker-key` only for `gpt-image-1.5`.
5. Before a batch, warn that accepted cloud requests may still be billed after a local crash, then run `--dry-run` and `--limit 1` where supported.
6. When invoking the script through a shell tool, set the command execution timeout to at least 360 seconds and at least 60 seconds longer than the configured API timeout. The plugin's API timeout defaults to 300 seconds; `AIFORALL_REQUEST_TIMEOUT_SECONDS` may increase it but never reduce it below 300 seconds.

## Prompt planning

The current Codex model compiles the prompt. Preserve exact names, quoted text, numbers, required objects and prohibitions. For edits, repeat invariants and describe each repeated `--image` in order with a matching `--image-role`. Do not create unrequested variants or paid corrective loops.

## Generate

Default to one `gpt-image-2` request, `quality=medium`, `size=auto`, PNG output, and the current project's `aiforall-image-gen/` directory.

```powershell
node "$HOME\plugins\aiforall-image-gen\scripts\generate.mjs" --prompt "<PROMPT>"
```

Use `--size WIDTHxHEIGHT` when exact dimensions are requested. `gpt-image-2` requires max edge 3840, both edges divisible by 16, ratio at most 3:1, and 655,360 to 8,294,400 total pixels. Use `--aspect` only as a 2K convenience mapping and never combine it with `--size`.

## Transparent output

For a simple opaque subject, stay on `gpt-image-2` and use `--transparent`. Choose `#00ff00` by default or `#ff00ff` for green subjects. The plugin preserves the source, samples the generated border, identifies the connected background, performs soft-matte removal and despill, and validates alpha. If validation fails and optional `rembg[cpu]` is installed, it runs local `u2net` without another API request.

As verified on 2026-07-30, aiforall.me accepts ordinary `gpt-image-1.5` generation but currently rejects `background=transparent` with HTTP 400. Treat `gpt-image-2 --transparent` plus adaptive chroma key and optional local rembg as the supported production path. Warn that hair, fur, feathers, smoke, glass, liquid, translucency, and reflections may be less accurate than true native alpha.

Keep `--native-transparent` only as an explicit experimental capability probe after user approval. If the route reports that transparent background is unsupported, stop after that one request, do not switch native Keys, and report `[CAPABILITY-UNAVAILABLE]`. Switch native workers only after an explicit authentication/group/access rejection. Never retry unknown request states and never submit a new `gpt-image-2 --transparent` request after a native failure or pool exhaustion without asking the user.

## Edit

- Use `--edit` and repeated `--image` arguments for one combined edit request.
- Accept no more than 16 PNG/JPEG/WebP inputs, each under 50 MB.
- Repeat `--image-role` once per input and preserve their order.
- A single `--mask` applies to the first image and must have alpha and matching dimensions.
- Never pass `--input-fidelity` to `gpt-image-2`; it is always high fidelity. Use `low|high` only with `gpt-image-1.5`.
- Save non-destructively. Do not use `--force` unless the user explicitly requests replacement.

## Batch and workers

Use `--count` only for variants of one prompt and `--batch`/`--batch-inline` for distinct prompts. A multi-reference edit remains one worker task; `--batch-edit` makes each source an independent task. Keep `[NO-RETRY]` requests out of automatic retries because their billing state is unknown. For timeout, `fetch failed`, socket loss, or a terminated response, explain that upstream may still have completed the image and check aiforall.me request history before considering another paid request. Never enable preview for batch or edit requests.

## Output display

Immediately show successful files in Codex using absolute Markdown image paths. For large workflows show a summary and a small sample, while keeping the full result set and reports under the current project's `aiforall-image-gen/` directory.

## Verification

After script changes run `node --check`, `npm test`, the Python unit tests, and all four built-in `--self-test-*` commands. Live verification requires explicit billing authorization and `AIFORALL_API_KEY` in the local environment.
