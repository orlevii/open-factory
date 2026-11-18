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
