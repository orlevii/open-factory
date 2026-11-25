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
| `mcp-plugin-and-project` | A directory-marketplace plugin with its own `.mcp.json`, declared through `--settings` (Claude Code installs it at start; the factory runs no `claude plugin` command), plus the workdir `.mcp.json` | Both servers load: `plugin:vplug:plugsrv` (`source:"plugin"`) and `proj` (`source:"project"`) |
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

Not captured as traces, checked by hand: a plugin installed in the config dir but absent from `enabledPlugins` does not load (nor its MCP server). The factory runs no `claude plugin` command: Claude Code installs the declared plugins itself at start, into `CLAUDE_CODE_PLUGIN_CACHE_DIR`, and `plugins/installed_plugins.json` there records absolute `installPath`s. A successful verification-style "Reply OK." turn on haiku costs about $0.002 and takes 3-5 s.

**S5 implementation gate (Claude Code 2.1.327, haiku, `CLAUDE_CODE_OAUTH_TOKEN`).** A plugin installed into a factory-owned plugins dir loaded locally and read-only in Docker (`open-factory-base:dev`, `no-new-privileges`), with the plugins dir file count unchanged. One earlier read-only run did not list the plugin and did not reproduce in 7 repeats, so the start treats a plugin missing from `system/init` as a visible problem (`plugin_not_loaded`), not as success. The current flow is in the I5 spec, §7.3: Claude Code installs at start and the factory only reads the result.

### Verified in S6 implementation

`@modelcontextprotocol/server` 2.4.0 (exact pin) served Claude Code 2.1.327 (haiku, `--permission-mode auto`) statelessly through `createMcpHandler(factory, { legacy: "stateless", responseMode: "json" })` and `handler.fetch(request, { authInfo })` behind a plain Node HTTP server, with a project `.mcp.json` `http` server and `Authorization: Bearer ${OPEN_FACTORY_AGENT_TOKEN}`. The `whoami` tool call succeeded and returned the agent id from `authInfo`.

- Era that served `tools/call`: `modern` (`ctx.era` in the factory callback).
- Context paths that worked in the tool handler (second argument): `tctx.mcpReq._meta["claudecode/toolUseId"]` (a `toolu_…` id) and `tctx.http.authInfo.clientId` (from the `authInfo` passed to `handler.fetch`).
- No `Origin` header was sent on any request (every request logged `origin= -`).
- `system/init` lists the server as `pending` (init is emitted before the connection completes); the tool call still succeeded, but only after a ~25 s wait. Correction (S6 live check): with protocol `2026-07-28` Claude POSTs `subscriptions/listen` after `server/discover` and waits for its acknowledgement before `tools/list`. The SDK serves that request as a never-ending SSE stream (whatever the `responseMode`) whose first event is `notifications/subscriptions/acknowledged`, so the HTTP layer must stream it. A server that buffers the body never delivers the ack, and Claude cancels `listen:0` after 25 s and lists the tools without it.
- `responseMode: "json"` drops mid-call notifications (the SDK warns at startup).

### Verified in S7 implementation

Live gate 1 (Claude Code 2.1.327, haiku, `--permission-mode auto`, `@modelcontextprotocol/server` stateless `createMcpHandler`, project `.mcp.json` `http` server with `Authorization: Bearer ${OPEN_FACTORY_AGENT_TOKEN}`): per-caller tool lists work. One server, two callers with different tokens: the lead's `system/init` listed `mcp__factory__list_peers` and `mcp__factory__spawn_agent`; the child's listed only `mcp__factory__list_peers`. The lead called `spawn_agent` and the enum argument arrived intact (`template: "developer"` from `z.enum(["tech-lead","developer"])`, plus `description` and `prompt`). The factory callback is awaited per request, and the caller was carried by `ctx.authInfo.clientId` in the factory (the `authInfo` passed to `handler.fetch`). No fallback is needed: Task 6 registers per-caller lists.

The HTTP layer must stream the response body (as S6 found for `subscriptions/listen`): a probe that buffered the whole body with `arrayBuffer()` left the server `connecting` and no `mcp__factory__*` tool was ever available to the model.

### Verified in S8 implementation

Live gate V1 (Claude Code 2.1.327, haiku, `--permission-mode auto`): a probe server registered the five task tools (`create_task`, `update_task`, `list_tasks`, `get_task`, `comment_task`) with the real shared Zod schemas and stub handlers. All five appeared in the model's tool calls and every input shape arrived intact: `depends_on` as an array of two strings, `links` as an array with one object, `assignee: null` on `update_task` (alongside `status: "done"`), and `status: ["done"]` on `list_tasks`. No flattening fallback is needed.

### Verified in S9 implementation

Live gate V1/V2 (Claude Code 2.1.327, haiku, `--permission-mode auto`, `CLAUDE_CODE_OAUTH_TOKEN` read at run time, fresh `CLAUDE_CONFIG_DIR`, S0's `drive.mjs` and the `cron-create-fire-delete` and `cron-oneshot` scenarios).

- **V1 (harness crons map as S0 recorded): confirmed.** The real mapper turns each trace into `cron_created` (`recurring` true or false), a `turn_end` with `originKind: "cron"` for the firing, and `cron_deleted` for the recurring cron after `CronDelete`; the one-shot gets no deletion event. `CronCreate`'s `tool_use_result` is `{id, humanSchedule, recurring, durable, nextFireAt}` (`nextFireAt` in epoch milliseconds, a float for the recurring one).
- **V2 (does a `durable: true` cron survive a resume): negative.** The model passed `durable: true` in the `CronCreate` input (checked in the `tool_use` block), but the tool's result reported `durable: false`, no `.claude/scheduled_tasks.json` (nor a `.claude` directory) was written in the working directory, and after stopping the process and resuming the session with `--resume` across the job's fire time (waited 200 s) no `DURABLEFIRED` turn, no `command_lifecycle` and no cron turn appeared. In this headless stream-json mode the flag is ignored, so no cron outlives its process and the durable-cron cleanup (spec §10.4's fallback) is not needed.

Live check `pnpm smoke:scheduling` (Docker agents on `open-factory-base:dev`, haiku, Claude Code 2.1.327), run in phases, all passing: the first slice (the three schedule tools listed by `system/init`, a human one-shot waking hibernated ceo with a `scheduled` envelope `schedule="S-1" by="@or"`, ceo acting on the body with `schedule_message` twice and no recreation of the fired one-shot, a spawned agent listing none of the three); phase a (a human `* * * * *` schedule, the 15-minute sentence for an agent's `*/5`, `cancel_schedule`); phase b (the server down more than a minute past a one-shot's time: one envelope with `late="true"`); phase c (`FACTORY_MAX_RUNNING_AGENTS=1`, since replaced by the max running agents factory setting; re-run in S10 with the setting and passing: dev stays queued while its schedule fires twice, one pending row with `firings=2`); phase d (`CronCreate` keeps ceo up past its 1-minute warm window, Stop crons hibernates it with `crons_stopped` by `@or`, the next batch starts with the passive notice). Two live details worth keeping: Claude Code refuses a standalone `sleep 170` (use a loop of short sleeps to keep an agent busy), and `CronCreate`'s result text says "Session-only (not written to disk, dies when Claude exits)".

### Verified in S10 implementation

Live gates V1, V2, V3 and V5 (Claude Code 2.1.327, Docker 29.9.3, dockerode 5.0.1, better-auth 1.7.25, haiku, `CLAUDE_CODE_OAUTH_TOKEN` read at run time).

- **V1 (dockerode `buildImage` with tar, `labels`, `pull`): confirmed, with one parser rule.** (a) `FROM ghcr.io/orlevii/open-factory/base:latest` + `RUN true`: stream ends `Successfully tagged of-gate:1`, and `.Config.Labels` carries `"io.open-factory.context-hash":"x"`. (b) `RUN false`: the failure arrives **in the stream** as `{"error":"The command '/bin/bash -o pipefail -c false' returned a non-zero code: 1","errorDetail":{"code":1,"message":"..."}}`; `modem.followProgress`'s completion callback got `err = null` and the promise resolved, so the parser must scan events for `error`/`errorDetail`. (c) `FROM open-factory-base:dev` with `pull: true`: stream event `{"error":"pull access denied for open-factory-base, repository does not exist or may require 'docker login'","errorDetail":{"message":"pull access denied for ..."}}` (also `err = null`); match on `pull access denied` for the `--no-pull` hint. (d) same with `pull: false`: succeeds, label present.
- **V2 (better-auth hooks and `additionalFields`): confirmed.** `user.create.before` throwing `APIError("FORBIDDEN", {code:"invite_required"})` returns 403 `{"code":"invite_required","message":"Invite required"}`. `session.create.before` throwing `APIError("FORBIDDEN", {code:"USER_DISABLED", message:"This account is disabled."})` returns 403 `{"code":"USER_DISABLED","message":"This account is disabled."}` on sign-in. A sign-up body containing `disabledAt` (`input: false`) is rejected: 400 `{"message":"disabledAt is not allowed to be set","code":"FIELD_NOT_ALLOWED"}`, nothing stored. `getSession` returns `user.disabledAt` (ISO string) once set; the key is absent while unset. A session created before the user was disabled stays valid (`getSession` 200), so disabling must also delete the user's sessions.
- **V3 (AsyncLocalStorage visible in `user.create.before`): confirmed.** Sign-up outside the store: 403 `invite_required`; inside `als.run({allowed:true}, ...)`: 200; two concurrent sign-ups, one inside and one outside: 200 and 403.
- **V5 (live `rate_limit_event`): differs in shape.** One event arrived on a haiku turn (`status: "allowed"`). `utilization` is **not** top-level on `rate_limit_info`; it is inside `unifiedWindows.<window>.utilization`. Keys: `status`, `resetsAt` (epoch seconds), `rateLimitType` (`five_hour`), `overageStatus`, `overageDisabledReason`, `isUsingOverage`, `unifiedWindows` (`five_hour` and `seven_day`, each `{utilization, resetsAt, status}`). Redacted line saved as `rate-limit-event-live-allowed.ndjson`:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795209600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":1795209600,"status":"allowed"},"seven_day":{"utilization":0.26,"resetsAt":1795590000,"status":"allowed"}}},"uuid":"REDACTED","session_id":"REDACTED"}
```

Live check `pnpm smoke:images` (Docker 29.9.3, Claude Code 2.1.327 in `open-factory-base:dev`, haiku, Docker agent on a user image, a throwaway database and `FACTORY_HOME`, only real routes over a real socket and the built CLI with a real bearer token), all passing. Redacted output (the evidence lines shortened):

```text
PASS 0. setup: prerequisites (CLI bundle, agent CLI bundle, local base image)
PASS 1. first user @or signs up without an invite (bootstrap) → 200
PASS 1. POST /api/credentials smoke (oauth_token, verified live) → 201
    imageStatus: {"kind":"user","name":"smoke","status":"not_built"}
PASS 1. template smoke-tpl (runtime docker, image smoke, haiku) is valid, image not_built
PASS 1. POST /api/agents smoke (template smoke-tpl) → 201
PASS 2. message smoke before the build → 202
PASS 2. the start fails: error event (source spawn)
PASS 2. the error has fix "image" and the exact "isn't built" message
    fix=image; message=Image `smoke` isn't built. Build it in Templates → Images, or run `open-factory images build smoke`.
PASS 2. no pull ran (no `pulling image` server log line)
PASS 3. @or signs in; bearer from the set-auth-token header
PASS 3. `open-factory images build smoke` (built CLI, bearer) exits 0
PASS 3. the build log streamed to stdout
    21 lines; first: Step 1/4 : FROM ghcr.io/orlevii/open-factory/base:latest; last 3: Successfully tagged open-factory-user/smoke:latest | Base image ghcr.io/orlevii/open-factory/base:latest: ghcr.io/orlevii/open-factory/base@sha256:d47a2f37… | Built smoke
PASS 3. docker image inspect open-factory-user/smoke:latest has io.open-factory.context-hash
PASS 3. GET /api/images → smoke built
PASS 4. POST /api/agents/smoke/restart → 202
PASS 4. message smoke after the build → 202
PASS 4. smoke's turn for that message ends
PASS 4. smoke answers
    answer: PELICAN
PASS 4. the container label io.open-factory.image = open-factory-user/smoke:latest
PASS 4. GET /api/agents/smoke/usage?days=7 → turns ≥ 1
    status 200; total {"costUsd":0.001877,"inputTokens":2,"outputTokens":7,"cacheWriteTokens":8787,"cacheReadTokens":11586,"turns":1}
PASS 4. the turn row has credential_id set (credential smoke)
PASS 4. GET /api/usage/credentials?days=7 shows smoke with a rateLimit (V5 in situ)
    rateLimit {"status":"allowed","type":"five_hour","utilization":0.01,"resetsAt":"2026-11-20T21:20:00.000Z","observedAt":"2026-11-20T20:13:59.853Z"}
PASS 5. touch images/smoke/new.txt → GET /api/images → out_of_date
PASS 6. `images build local --no-pull` (FROM open-factory-base:dev) exits 0
PASS 6. `images build local` without --no-pull exits 1 with the "couldn't be pulled" sentence
    exit 1; stderr: Build of local failed: Base image open-factory-base:dev couldn't be pulled. If it's local-only, run `open-factory images build local --no-pull`.
PASS 7. POST /api/invites → 201 with a link
PASS 7. sign-up without an invite → 403 invite_required
PASS 7. sign-up @sam with the invite → 200
PASS 7. reusing the invite → 403 invite_invalid
PASS 7. @sam signs in (bearer)
PASS 7. @sam's bearer works before disable (GET /api/me → 200)
PASS 7. @or disables @sam → 200
PASS 7. @sam's bearer after disable → 401

Smoke passed.
```

V5 in situ: the mapper's `utilization` (0.01) is the five-hour window's, matching the live `rate_limit_event`. Two live details worth keeping: a message sent while the image isn't built stays queued through the failed start and is delivered with the next message after the build and Restart (one batch, one turn), and the "no pull" check reads the server's `pulling image` log line (the Supervisor still marks the wake `pulling` for the moment the local image check takes).
