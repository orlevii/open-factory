# U3 spike traces

Copied from the U3 spike (`docs/product/ui-review/u3-spikes/`, Claude Code with
`--include-partial-messages` where the name says `partial`). Each line is the driver's record:
`t` (ms since start) and `dir` (`in` is what the driver wrote to stdin, `out` is stdout) wrap the
stream-json line. Not part of the top-level "every fixture" sweep.

**Redacted** before copying: image `base64` (in `tool_use_result.file` and the `tool_result` image
source) became `<base64>`, non-empty thinking `signature`s became `<signature>`, the scratch work dir
became `/spike/work` and the home dir `/home/user` (also inside streamed `text_delta` and
`input_json_delta` chunks, where a path is split across lines).

| File | Shows |
|---|---|
| `attach-file-path` | `[attached: …]` lines read with `Read` under `acceptEdits`; an image `Read` result is `{type: "image", file: {base64, type, originalSize, dimensions}}` (the base64 that tool meta never copies, §9.1) |
| `partial-text-and-write` | Streamed `text_delta`s and a `Write` call streamed as `input_json_delta` chunks |
| `partial-interrupt-mid-text` | An interrupt while text is streaming |
| `partial-subagent` | A background (`isAsync`, `status: "async_launched"`) Agent launch with partial messages |
| `partial-thinking-summaries-forward-subagent` | Thinking summaries, and a foreground Agent result with `totalToolUseCount`, `totalTokens`, `totalDurationMs` |
