# Stream-json fixture traces

Real `claude -p --input-format stream-json --output-format stream-json --verbose` traces captured
during the S0 spikes, for the S3 harness driver tests.

- **Claude Code version:** 2.1.327 (host macOS arm64 and the `open-factory-base:dev` image, arm64).
- **Models:** `haiku` (Haiku 5.5) for most runs, `sonnet` (Sonnet 5.5) for the factory MCP runs.
- **Permission mode:** `--permission-mode auto` unless noted.
- **Produced with** [`spikes/drive.mjs`](../../../spikes/drive.mjs): it spawns the process, writes the
  steps in `spikes/scenarios/<name>.json` to stdin (user messages, raw lines, `control_request`s,
  stdin close, signals) and records every stdout line. `<name>.jsonl` is stdout only (the stream does
  not echo our input); `<name>.timeline.txt` interleaves what we sent (`->`) with what came back
  (`<-`) and the timing, plus `shell:` probe output (e.g. `ps` before/after a kill).
- **Scrubbed** with [`spikes/scrub.mjs`](../../../spikes/scrub.mjs): scratch paths become `/spike/…`,
  `$HOME` becomes `/home/user`, per-user temp dirs become `/tmp/claude-uid`, thinking signatures become
  `<signature>`, account-level claude.ai connectors are dropped from `system/init`, and strings longer
  than 2000 chars (compaction filler) are truncated.

## Index

| File | How it was produced | Shows |
|---|---|---|
| `rate-limit-event-allowed` | One "pong" turn | `system/init`, `rate_limit_event` with `status: "allowed"` (emitted every turn), `result` |
| `background-bash-start-finish` | `run_in_background` Bash (`sleep 8`), stdin kept open | `system/background_tasks_changed`, `system/task_started`, `task_updated`, `task_notification{status:"completed"}`, then an unprompted turn whose `result.origin.kind` is `task-notification` |
| `background-subagent-stdin-closed` | Background subagent, stdin closed right after the turn | `task_type: "local_agent"`, nested `parent_task_id`, process waits for the subagent then exits 0 |
| `background-stdin-closed-drains` | `sleep 20` in background, stdin closed after the turn | Process stays up until the task finishes, runs one notification turn, exits 0 |
| `background-monitor-keeps-process-alive` | Background `sleep 600` + Monitor loop, stdin closed | Process never exits on its own; each Monitor line starts a new turn; ended by SIGKILL |
| `background-sigterm` | Same tasks, then SIGTERM | `task_notification{status:"stopped"}` for both, exit 143, no surviving children |
| `background-sigkill` | Same tasks, then SIGKILL | No events; timeline shows the shells survive, re-parented to PID 1 |
| `resume-after-sigkill-orphans` | `--resume` of the SIGKILL session | `task_notification{status:"stopped", summary:"Orphaned by a previous Claude Code process exit…"}` per task, a zero-cost `result` (`num_turns: 0`) before the first real turn, then the model probing `ps` |
| `interrupt-then-message` | Foreground `ping`, `control_request{subtype:"interrupt"}`, then a new message | `control_response{still_queued:[]}`, tool result "[Request interrupted by user for tool use]", `result{subtype:"error_during_execution", terminal_reason:"aborted_tools"}`, next turn runs normally |
| `interrupt-with-queued-message` | Message written mid-turn, then interrupt | The queued message runs as the next turn right after the interrupted one |
| `midturn-messages-absorbed` | Two messages written while a foreground tool runs | Both are absorbed into the running turn at the next tool boundary; one `result` answers all three |
| `user-message-priority-now` | Mid-turn user message with `"priority":"now"` | Current turn ends at the next tool boundary (`terminal_reason:"aborted_tools"`, tool not killed), then the message runs |
| `permission-denied` | Custom `autoMode.hard_deny` canary rule, credentials-file login | `system/permission_denied{decision_reason_type:"classifier"}`, `result.permission_denials[]` |
| `permission-denied-oauth-token` | Same, authenticated only with `CLAUDE_CODE_OAUTH_TOKEN`, empty config dir | Same shapes; `apiKeySource:"none"`, `permissionMode:"auto"` |
| `cron-create-fire-delete` | `CronCreate` every minute, one firing, `CronDelete` | Tool results with `tool_use_result{id, recurring, durable, nextFireAt}`, firing wrapped in `command_lifecycle{wakeup_source:"schedule_wakeup"}`, "Cancelled job <id>" |
| `cron-oneshot` | One-shot `CronCreate`, firing, `CronList` | Job fires once and auto-deletes with no `CronDelete` event |
| `auto-compaction` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`, five ~90 KB pastes | `system/status{status:"compacting"}`, `status{compact_result:"success"\|"failed", compact_error}`, `system/compact_boundary{compact_metadata.trigger:"auto"}` and the summary user message |
| `error-refusal-and-failed-compaction` | Random-word filler that tripped a safety false positive | `system/informational`, `system/model_refusal_no_fallback`, synthetic assistant message, `result{is_error:true, subtype:"success", terminal_reason:"api_error"}`, failed auto-compaction |
| `error-model-not-found` | `--model claude-nonexistent-9` | Synthetic assistant `error:"model_not_found"`, `result{is_error:true, subtype:"success", api_error_status:404}`; exit 1 after stdin close |
| `error-resume-missing-session` | `--resume` with an unknown id | Single `result{subtype:"error_during_execution", num_turns:0}`, stderr "No conversation found…", exit 1 |
| `error-malformed-stdin-line` | Non-JSON line on stdin | No stdout at all; stderr "Error parsing streaming input line"; process exits 1 immediately (timeline only) |
| `factory-mcp-and-project-symlink-edits` | Fake factory MCP (`spikes/fake-factory-mcp.mjs`) via `.mcp.json`, project symlinked at `./projects/demo`, `autoMode.environment` set | MCP calls approved by the classifier; Edit through the symlink denied with `decision_reason_type:"safetyCheck"` (outside working dirs) |
| `project-edits-with-additional-directories` | Same, plus `permissions.additionalDirectories: [<repo>]` | Edit/Write through the symlink approved |
| `config-dir-pickup` | Fresh `CLAUDE_CONFIG_DIR` with an installed plugin, global `CLAUDE.md`, `autoMode.hard_deny`; workdir with `AGENTS.md` and a symlinked skill | All picked up (see `system/init` `skills`/`plugins`); canary denied |
| `docker-config-dir-pickup-marketplace-unmounted` | Same inside `open-factory-base:dev`, directory marketplace not mounted | Plugin silently missing; everything else picked up |
| `docker-exec-sigkill` | `docker exec -i` into a long-lived container, background tasks, `pkill -KILL claude` | Shells survive inside the container under `tini` |
| `docker-exec-resume-orphans` | `--resume` via a new `docker exec` | Same orphan notifications as the local runtime |
| `docker-stop-sigterm` | `docker run -i … claude`, then `docker stop` | `tini` forwards SIGTERM; tasks stopped, exit 143 |

### Added in S3 design (Claude Code 2.1.327, haiku, host login)

| File | How it was produced | Shows |
|---|---|---|
| `manual-compact` | One turn, then `/compact` as a user message, then `/compact keep only the remembered word` | A manual compact **is a turn**: `status{compacting}`, `status{compact_result:"success"}`, `system/init`, `compact_boundary{trigger:"manual", pre_tokens, post_tokens}`, the synthetic summary user message, a replayed `<local-command-stdout>Compacted </local-command-stdout>` user line (`isReplay:true`), then `result{num_turns:0, is_error:false}` with no `origin`. The second compact fails: `status{compact_result:"failed", compact_error:"Not enough messages to compact."}`, `system/init`, a synthetic assistant message (`model:"<synthetic>"`, `local_command_source`) with that text, `result{num_turns:0, is_error:false}`. (The scenario then waited for a second `compact_boundary` that never came; the timeline shows the step timeout and the stdin close.) |
| `interrupt-while-idle` | One turn, `control_request{interrupt}` 2 s after its `result`, then a new message | A stray interrupt on an idle process gets `control_response{success, still_queued:[]}` and nothing else; the next message runs normally and the session keeps its memory |

These two were run with the host's Claude login (not an empty config dir), so host hook events were removed and the host's plugins, skills, MCP servers, commands and `mcp__*` tools were emptied from `system/init` before committing (on top of `scrub.mjs`). The steps are in `spikes/scenarios/manual-compact.json` and `interrupt-while-idle.json`.

The compaction scenario's steps embed a large `.d.ts` file and are not committed; the timeline shows
what was sent.

### Added in S4 design (Claude Code 2.1.327, haiku, `CLAUDE_CODE_OAUTH_TOKEN`, fresh `CLAUDE_CONFIG_DIR`)

Produced with a small shell driver (one stream-json user line on stdin, `env -i` with only `PATH`, `HOME`, `USER`, `TERM`, `CLAUDE_CONFIG_DIR` and the token), scrubbed with `spikes/scrub.mjs`. A tiny stdio MCP server answered `initialize`/`tools/list`/`tools/call` with a `canary` tool.

| File | How it was produced | Shows |
|---|---|---|
| `mcp-project-without-enable-all` | Workdir `.mcp.json` with one stdio server, **no** `enableAllProjectMcpServers`; asked to call its tool | `system/init.mcp_servers: [{name:"proj", status:"connected", source:"project"}]`, the tool is callable. Also: no host skills or plugins in `system/init` (only built-ins) |
| `mcp-plugin-and-project` | A directory-marketplace plugin with its own `.mcp.json`, installed into the config dir (`claude plugin marketplace add` + `install`), plus the workdir `.mcp.json` | Both servers load: `plugin:vplug:plugsrv` (`source:"plugin"`) and `proj` (`source:"project"`) |
| `mcp-strict-drops-plugin-servers` | Same, with `--mcp-config <workdir>/.mcp.json --strict-mcp-config` | Only `proj` (`source:"dynamic"`); the plugin still loads but **its MCP server is dropped** |
| `mcp-http-env-header` (S6) | A raw Node HTTP MCP server (no SDK) named `factory` in a project `.mcp.json` with `"headers": {"Authorization": "Bearer ${OPEN_FACTORY_AGENT_TOKEN}"}`, the variable set in the process env; one "call whoami" turn on haiku. `.server.txt` is the server side | `system/init` `mcp_servers:[{name:"factory",status:"connected",source:"project"}]`; every request carries the expanded token; a `GET /mcp` stream attempt that Claude tolerates failing; `tools/call` carries `params._meta["claudecode/toolUseId"]` equal to the stream's `tool_use` id |
| `permission-mode-flag-overrides-dontask` | Config-dir `settings.json` `permissions.defaultMode:"dontAsk"`, CLI `--permission-mode auto` | `system/init.permissionMode:"auto"` (without the flag it is `dontAsk`) |
| `permission-deny-rules` | `permissions.deny: ["Bash(curl:*)", "Read(./secret.txt)"]`; asked to curl and to read the file | Bash: `system/permission_denied{decision_reason_type:"subcommandResults", message}` (no `decision_reason`). Read: **no system event**, only an error `tool_result` ("File is in a directory that is denied by your permission settings.") and an entry in `result.permission_denials[]` |
| `auto-mode-hard-deny-custom` | `autoMode:{environment:[one entry], hard_deny:["Never run any command containing the word PELICAN."]}`; asked to `echo PELICAN-1` | `system/permission_denied{decision_reason_type:"classifier"}`, turn continues |
| `auto-mode-defaults-merge.txt` | `claude auto-mode config` / `defaults` for three config dirs (text summary, not a stream) | Setting an `autoMode` list **replaces** Claude's defaults for it (defaults: environment 21, allow 16, soft_deny 72, hard_deny 1); a `"$defaults"` entry keeps them and appends |
| `error-invalid-oauth-token` | `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-bogus`, one "Reply OK." turn | Two `system/api_retry{error_status:401, error:"authentication_failed"}`, a synthetic assistant message with `error:"authentication_failed"` and text "Failed to authenticate. API Error: 401 …", `result{subtype:"success", is_error:true, terminal_reason:"api_error", api_error_status:401}`; exit 1 after about 4 s. |
| `ancestor-claude-md-suppresses-agents-md` | cwd `<root>/agents/x` with its own `AGENTS.md`; `<root>/CLAUDE.md` and `<root>/AGENTS.md` present; asked to quote its instruction files | Only the ancestor `CLAUDE.md` is loaded: the cwd's `AGENTS.md` (and the ancestor `AGENTS.md`) are **not** loaded |
| `ancestor-agents-md-loads` | Same, without the ancestor `CLAUDE.md` | Both the ancestor `AGENTS.md` and the cwd's `AGENTS.md` load |
| `claude-md-excludes-ancestors` | Ancestor `CLAUDE.md` back, plus `claudeMdExcludes: [<root>/CLAUDE.md, <root>/AGENTS.md]` in the config-dir settings | Ancestor files gone; the cwd's `AGENTS.md` loads again |
| `session-state-changed-background` (S5) | `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`; a `run_in_background` Bash `sleep 8 && echo done`, stdin kept open, closed after 40 s | `system/session_state_changed{state:"running"}` before each `system/init` and `{state:"idle"}` right after each `result`: it went **`idle` at 3.4 s while the background task was still live** (it ended at 11 s), then `running` again for the notification turn, emitted just after the empty `background_tasks_changed`. So it is a turn signal, not a busy signal (#24). The mapper drops it. |
| `rate-limit-event-rejected` (S5, **synthetic, unverified**) | Built from the Agent SDK's documented shape: `rate-limit-event-allowed` with its `rate_limit_event` replaced by `status:"rejected"`, then `result{is_error:true, terminal_reason:"api_error", api_error_status:429}`. | Replace with a real trace when one is captured (#43). |

Not captured as traces, checked by hand: a plugin installed in the config dir but absent from `enabledPlugins` does not load (nor its MCP server); `claude plugin marketplace add` / `install` need no credential, re-running them exits 0, and an unknown plugin exits 1 with "Plugin … not found in marketplace …"; `plugins/installed_plugins.json` records absolute `installPath`s. A successful verification-style "Reply OK." turn on haiku costs about $0.002 and takes 3–5 s.

**S5 implementation gate (Claude Code 2.1.327, haiku, `CLAUDE_CODE_OAUTH_TOKEN`).** V6/V7 re-run with a **git-sourced** marketplace (`anthropics/claude-plugins-official`, added as `owner/repo`; a `file://` URL is rejected by `claude plugin marketplace add` with "Invalid marketplace source format", and a local bare repo path is read as a directory). The plugin (`frontend-design`) was installed into a factory-owned config dir with the plugin env (exactly `PATH`, host `HOME`, `CLAUDE_CONFIG_DIR`, empty cwd). `installPath` lies inside that dir's `plugins/cache/…`. Result: the plugin loads through the symlinked `plugins` dir locally (`system/init.plugins` lists it, the Skill call succeeds) and read-only in Docker (`open-factory-base:dev`, `no-new-privileges`, `plugins-config/plugins` mounted `:ro`, fresh agent config, `plugins/store` absent): same init, same result, exit 0, and the plugins dir file count unchanged (815 before, 815 after). Repeated 7 times (fresh config, store present or absent, config created by a host run first): plugin loaded every time. One earlier read-only run, made right after a host run and before any other container run, did not list the plugin (only built-ins) and the model said the skill was unavailable; it did not reproduce in the 7 repeats. A read-write mount loads and writes only `plugins/store/<builtin>.json` (a builtin plugin's state), which is not needed for user plugins. The S5 start path must therefore treat a missing plugin in `system/init` as a visible start problem, not assume success.

### Verified in S6 implementation

`@modelcontextprotocol/server` 2.4.0 (exact pin) served Claude Code 2.1.327 (haiku, `--permission-mode auto`) statelessly through `createMcpHandler(factory, { legacy: "stateless", responseMode: "json" })` and `handler.fetch(request, { authInfo })` behind a plain Node HTTP server, with a project `.mcp.json` `http` server and `Authorization: Bearer ${OPEN_FACTORY_AGENT_TOKEN}`. The `whoami` tool call succeeded and returned the agent id from `authInfo`.

- Era that served `tools/call`: `modern` (`ctx.era` in the factory callback).
- Context paths that worked in the tool handler (second argument): `tctx.mcpReq._meta["claudecode/toolUseId"]` (a `toolu_…` id) and `tctx.http.authInfo.clientId` (from the `authInfo` passed to `handler.fetch`).
- No `Origin` header was sent on any request (every request logged `origin= -`).
- `system/init` lists the server as `pending` (init is emitted before the connection completes); the tool call still succeeded.
- `responseMode: "json"` drops mid-call notifications (the SDK warns at startup).
