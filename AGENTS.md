# aiforall-image-gen project rules

<!-- BEGIN aiforall-image-gen managed rules -->
- For image generation, image editing, transparent-background, and batch-image tasks, use the `aiforall-image-gen` Codex plugin first.
- Use `gpt-image-2` by default. Use `--native-transparent` only when the user explicitly requests it and never silently submit a paid fallback request after native transparency fails.
- Set the outer command timeout to at least 360 seconds. The plugin API request timeout is at least 300 seconds.
- Do not print complete API keys in chat, logs, source files, tests, or Git. Use environment variables or the plugin's private configuration flow.
- Treat timeout, disconnect, and `fetch failed` results as unknown after submission. Do not automatically resubmit a paid request; check request history first.
- Save generated files to the current project's `aiforall-image-gen/` directory unless the user specifies another output directory.
- For batch work, use the plugin's worker pool and bounded concurrency. Respect the configured per-key slots and do not create duplicate paid requests to compensate for a client-side timeout.
<!-- END aiforall-image-gen managed rules -->
