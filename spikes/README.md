# S0 spikes

Throwaway scripts used to answer the S0 open questions against a real Claude Code 2.1.327
stream-json process. Findings live in the (local) product knowledge bundle under
`docs/product/open-questions.md`; the recorded traces live in
[`packages/harness/fixtures/`](../packages/harness/fixtures/README.md).

- `drive.mjs <steps.json> <out-prefix> [-- claude args]`: spawns
  `claude -p --input-format stream-json --output-format stream-json --verbose …` (or `$CLAUDE_BIN`),
  runs the steps and writes `<out-prefix>.jsonl`, `.timeline.log` and `.stderr.log`. Steps:
  `send`, `raw`, `control`, `waitFor {type, subtype, tool, text}`, `mark` / `since: "mark"`,
  `sleep`, `closeStdin`, `kill`, `waitExit`, `shell`.
- `scenarios/*.json`: the steps behind each fixture (same names).
- `scrub.mjs <in> <out> <scratch-root>`: removes paths, emails, tokens and signatures before a trace
  is committed.
- `fake-factory-mcp.mjs <port> <log>`: a dependency-free Streamable-HTTP MCP server with
  `send_message` / `create_task`, standing in for the factory MCP.
- `docker-claude.sh` / `docker-exec-claude.sh`: `$CLAUDE_BIN` wrappers for the docker runtime
  (`docker run -i` per process, or `docker exec -i` into a long-lived container), with path-parity
  mounts.

Auth for the runs came from a dedicated config dir or `CLAUDE_CODE_OAUTH_TOKEN`; nothing here reads
or stores credentials.
