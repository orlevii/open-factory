# Test suite review (2026-11-23)

Scope: every test file in the repo (server, web, shared, db, harness, CLI, e2e and smoke scripts). Goal: remove only tests that clearly give no protection, fold overlaps, strengthen weak tests of important behaviour. No production code was changed.

Method:
1. Nine parallel read-only reviewers, one per area, each classed every test as KEEP / REMOVE / CONSOLIDATE / REWRITE / FLAG after reading the production code.
2. The lead challenged each REMOVE list.
3. Per-area implementers applied the accepted items, running only the changed files, biome and tsc.
4. A cross-area pass (server-cross, web-cross) handled folds whose survivor lives in another area.
5. An independent diff audit (`eaa5191..HEAD`) looked for lost assertions.
6. The lead restored what the audit found missing (commit 8d6a9e7).
7. Testing standards were added to AGENTS.md (f1b12ce).

Never removed: tests of security boundaries (auth, redaction, path safety, mounts, secrets), races and locks, data integrity, error paths, and regression guards. When unsure, a test stays and is flagged. A folded test only goes once every assertion that guards behaviour lives in the survivor.

Net effect: 184 files changed, 1409 insertions, 3048 deletions. After the first pass: tests 5330 to 5143 (-187), files 461 to 459 (deleted: `routes/auth.names.test.ts`, `test/radio-group.test.tsx`). After Or's decisions: 5070 tests in 458 files (`components/ui/button.test.tsx` also went).

## Totals

Test counts count `it`/`test` calls; a `.each` counts as 1. Removed / consolidated / rewritten / flagged are entry counts taken from the implementer logs (a log entry can cover more than one test), so they are approximate. Cross-area items are counted under the area of the file that lost the test. Net test drop is the exact before/after difference.

| Area | Files before/after | Tests before/after | Removed | Consolidated | Rewritten | Flagged |
|---|---|---|---|---|---|---|
| server-agents | 46 / 46 | 585 / 572 | 1 | 14 | 5 | 3 |
| server-routes | 41 / 40 | 426 / 410 | 3 | 14 | 18 | 5 |
| server-domain | 42 / 42 | 440 / 434 | 0 | 9 | 10 | 4 |
| server-runtime | 50 / 50 | 477 / 464 | 1 | 15 | 12 | 4 |
| web-session | 49 / 49 | 762 / 730 | 2 | 10 | 9 | 5 |
| web-features-a | 36 / 36 | 497 / 474 | 4 | 17 | 11 | 8 |
| web-features-b | 41 / 41 | 473 / 455 | 1 | 12 | 13 | 8 |
| web-app | 67 / 66 | 821 / 741 | 17 | 32 | 19 | 12 |
| components, packages, e2e | 89 / 88 | 849 / 790 | 10 | 14 | 4 | 16 |
| Total | 461 / 458 | 5330 / 5070 | 39 | 137 | 101 | 65 |

The after column includes Or's decisions below (compatibility leftovers and CSS-class tests removed). The removed / consolidated / rewritten / flagged columns are the first pass only; the CSS pass removed about 69 more tests and trimmed class assertions from about 185.

The e2e and smoke scripts were reviewed and not changed: `scripts/smoke-cli.sh` runs in `ci.yml`, `images/base/test/smoke.sh` runs in `base-image-build.yml`, and the harness fake-claude and scenarios are all used.

## Decisions after review (Or)

1. **Compatibility leftovers deleted, with their tests** (ADR 0028; production change authorised):
   - Envelope `parts` is required (`packages/shared/src/messaging.ts`, `packages/harness/src/types.ts`). Every envelope comes from `groupEnvelopes`, which always sets parts; the one hand-built envelope (`apps/server/src/credentials/verify.ts`) now carries its part. `features/session/update-group.tsx` and `timeline.tsx` read `e.parts` directly. Deleted: `messaging.test.tsx` "a pre-S6 member_update without parts…", shared `messaging.test.ts` "a pre-S6 message_in row (no parts) still parses".
   - Attachment `bytes` is required (`messageAttachmentSchema`); `message-block.tsx` drops the unknown-size guard. The unknown-size case left "an image over 1 MB… previews only when asked".
   - The `?archived=only` alias on `/agents` is gone (`routes/_app/agents.index.tsx`). Deleted: agents-tree "an old ?archived=only bookmark…", agents-list "an old /agents?archived=only&justArchived=x URL…". The API tests that refuse `?archived=` stay (they test the current contract).
   - `routes/_app/schedules.$key.tsx` ("the old page URL") is deleted and `routeTree.gen.ts` regenerated. Nothing in the app, server or CLI linked to `/schedules/<key>`; schedules open as the Edit schedule sheet. Deleted: edit-schedule-sheet "the old page URL opens the sheet…"; test routers and `form-urls.test.ts` updated.
   - Shared "old rows" tests: `events.test.ts` lost its old-rows assertion. `messageId`/`blockIndex` and `tool_result.meta` stay optional for a current reason (the harness emits no key when a stream message has no id; tools without facts carry no meta); only the "old rows" wording went.
   - Fixtures across web, shared and harness tests now build envelopes with parts (`envelope()` helper in `apps/web/src/test/session-fixtures.ts`).
2. **CSS-class tests removed.** Every web test that only asserted classes or styling was deleted (about 69, including the 25 flagged class contracts and `components/ui/button.test.tsx`), and class assertions were dropped from about 185 mixed tests, keeping their role, name, text, focus, aria and state checks. Tests renamed where the old name described styling. AGENTS.md now says: don't assert CSS classes or styling; test behaviour and accessible output.
3. **project-service terminated-grantee test.** Termination deletes an agent's grants in the same transaction (`event-store.ts` `terminateRows`), so a terminated grantee with a grant row cannot exist, and the test half could not fail. Giving the terminated agent a grant row to make it fail showed the `isNull(terminatedAt)` filter is dead code: the FK would still block the delete. The terminated half was deleted; the test is now "a live spawned grantee blocks removal and is named with its spawner". `settings-routes.test.ts` keeps the route-level case.
4. **Accepted losses:** the `verify.ts` source-text check and the three real-database config-change tests stay removed.

Other compatibility leftovers of the same kind, not in scope of the decision: the legacy form-URL redirects (`agents.new`, `tasks.new`, `schedules.new`, `templates.new`, `agents.$slug_.edit` via `features/sheets/redirect.ts`).

## server-agents

Paths under `apps/server/src/agents/` unless noted.

### Removed
- `notices.test.ts`, "the self-compact continue notice has fixed texts": restates two literals; `send-command.test.ts` asserts both end to end.

### Consolidated
- `agent-runtime.delivery.test.ts`, "the hold is released after 10 s if no result arrives": into "the 10 s fallback after %s appends interrupt_unconfirmed, then sends the held messages" (now a test.each, same 9 999 / 10 000 ms boundary).
- `agent-runtime.lifecycle.test.ts`, "message_in always precedes its reply...": into "starts on demand, writes one envelope turn..." (the full event order already asserts it).
- `agent-runtime.lifecycle.test.ts`, "reload picks up a renamed agent" and "reload picks up archiving": into "reload re-reads the row: a rename shows in summaries and archiving refuses sends" (both assertions kept).
- `agent-runtime.raw.test.ts`, "raw text queued during a turn is written only after turn_end...": into "held while a turn is open, written raw on its own..." (rawInput is text-agnostic).
- `agent-runtime.warm.test.ts`, "doesn't hibernate before the warm window ends": into "hibernates after the warm window when fully idle, not a second before".
- `agent-runtime.warm.test.ts`, "a message sent during the stop grace wakes the agent after the exit": into `agent-runtime.primitives.test.ts` "a message sent during a hibernate's stop grace is not written to the closing process" (moved the no delivery_failed and hibernated checks).
- `agent-service.test.ts`, test.each row "reserved slug": covered by "create with a reserved slug is refused before any claim".
- `agent-service.test.ts`, "create race on one slug...": into "two concurrent creates of one slug..." (added the AGENTS.md exists check).
- `agent-service.test.ts`, HTTP PATCH part of "a spawned agent can't be edited...": dropped; `routes/agents.test.ts` owns HTTP (server-cross).
- `config-changes.test.ts`, "before: null writes no event or notice but still restarts...": into `config-changes.flow.test.ts` "before: null writes no event or notice but still runs the restart check".
- `config-changes.test.ts`, "a spawner whose secrets changed restarts its live children": into the flow test "a spawner whose secrets or deny rules changed...".
- `config-changes.test.ts`, "nextImage is refreshed for a loaded Docker runtime": into flow "nextImage is refreshed with the image the new config resolves to" and `runtimes.config.test.ts`. The audit notes the real-runtime wiring of these three is lost (accepted, see the ranked list).
- `start.test.ts`, "gate on: local starts as before": line 192 already asserts it.
- `start.test.ts`, "a persistent agent's start errors keep their advice and fix; a spawned one's drop the config fix": halves covered by "an invalid overlay is an AgentStartError with the config fix", config-resolver and the lifecycle test.each.

### Rewritten
- `agent-runtime.crons.test.ts`: "a deleted cron and a one-shot after its firing turn disappear" now "a deleted cron disappears at once; a one-shot disappears after its cron turn ends" (the one-shot must survive an ordinary turn end).
- `agent-runtime.lifecycle.test.ts`: "an exit mid-turn clears the turn's start time" now a test.each over a stop and an unexpected exit.
- `agent-runtime.warm.test.ts`: "lastActivityAt moves on start, delivery and turn end" gained the delivery step (t0+5 s).
- `agent-runtime.terminate.test.ts`: "a stuck terminated agent records stop_escalated once..." now asserts at least one escalation, then that two sweeps add none (the review's `=== 1` was wrong: the baseline is 2).
- `start.test.ts`: "gate off: a docker agent is never gated" now asserts the exact "Docker runtime isn't configured" rejection.

### Retained
The runtime tests drive the real `AgentRuntime` over real Postgres with the fake driver: turn stamping on every close path, member-update debouncing, cancel/restore authorization, apply-restart waiting rules, config_changed notice lifecycle, the terminate latch and every termination race, the Docker start path against the fake daemon, and the overlay never writing a secret to any row.

### Flagged for review
- `event-store.messages.test.ts`, "a message row can be cancelled and carries a client id": kept as is.
- `runtime-spec.test.ts`, "two agents with different credentials...": kept as is.
- `agent-runtime.passive.test.ts`, "a second notice of the type replaces the first": overlaps `event-store.test.ts` "createNotice replaces a pending notice..." but the runtime replace path for config_changed vs crons_stopped was not verified, so kept (low confidence).

## server-routes

Paths under `apps/server/src/`.

### Removed
- `routes/agents.input.test.ts`, "the old commands POST is gone": deleted-route 404 housekeeping.
- `routes/messages.test.ts`, "the old per-agent route is gone": same.
- `field-messages.test.ts`, "verify.ts messages come from FIELD_MSG": source-grep lint; `credentials/verify.test.ts` asserts the values (the lint itself is an accepted loss).

### Consolidated
- `routes/agents.test.ts`, "start failure is that recipient's result with the fix text and the message stays queued": into `routes/messages.test.ts` "start_failed keeps that recipient's row pending" (exact reason, errored detail, queued body).
- `routes/agents.test.ts`, "a human message to a terminated agent is refused and writes nothing": into messages "one refused recipient beside sent ones is a 202 with mixed results" (codes terminated / not_found, one row written).
- `routes/messages.test.ts`, "a refused recipient carries its code": into the same mixed-results test.
- `routes/messages.test.ts`, "a retry with the same clientMessageId returns every row's result...": into `routes/agents.test.ts` "the same id twice..." plus a new two-recipient test on its own app.
- `routes/agents.test.ts`, "a sent upload previews for any signed-in human; its delete is refused": into `routes/uploads.test.ts` "DELETE by the uploader while unsent..." (now sends with `attachments: [id]`).
- `routes/auth.names.test.ts` (4 tests, file deleted): into `auth/auth.test.ts` (reserved-handle test.each gained "system" and "all").
- `routes/claude-sign-in.test.ts`, "replace of an api_key credential is 400 signInOAuthOnly": into the AC8 test.
- `routes/claude-sign-in.test.ts`, "name errors keep the attempt and the code unspent": into the AC5 test.
- `routes/inbox.test.ts`, "spec 5.1: a live agent token is refused...": into test.each "%s %s: a live agent token gets 401" (added GET /api/inbox and GET /api/messages/x rows, body check on all rows).
- `routes/templates.test.ts`, "unauthenticated -> 401" and `routes/templates.config.test.ts` "both routes need a signed-in user": one test.each in templates.test.
- `routes/usage.test.ts`, "GET /api/credentials carries rateLimit, null with no data": into the observed-rate-limit test.
- `app.test.ts`, "the OAuth token is redacted at every realistic depth": into `logging.test.ts` "the new redact paths hide sentinels at every shape" (CLAUDE_CODE_OAUTH_TOKEN added at x., env., spec.env.).
- `config.test.ts`, "the cap and the debounce are no longer config": into `app.test.ts` S10 Q6 test (the key-absence check is an accepted loss).
- `routes/uploads.test.ts`, "jpeg, gif, webp and UTF-8 text are accepted by content": trimmed to jpeg + md; `uploads/sniff.test.ts` covers every type. Route rows for gif, webp and data.json are an accepted loss.
- (server-cross) `routes/uploads.test.ts` info/exclude test trimmed to one upload; `uploads/git-exclude.test.ts` owns the rest.
- (server-cross) `routes/schedules.test.ts` target_ended and list tests trimmed to status/code and query wiring; `scheduling/schedule-service.edit.test.ts` owns messages and order.
- (server-cross) `routes/agents.input.test.ts` mid-turn and errored tests trimmed to 202 plus wiring (renamed); `agent-runtime.raw.test.ts` owns write-after-turn-end.

### Rewritten
- `routes/agents.test.ts`: "compact is accepted and queued; validation errors are 400" now "...; a focus over the limit is 400 and queues nothing".
- `routes/agents.config.test.ts`: "an empty overlay..." asserts `merged` equals the template doc; "local_skill_names never leaves the server" gained a positive control.
- `routes/claude-sign-in-ends.test.ts` "sign-out ends the user's attempt...": asserts the attempt exists before and is gone after.
- `routes/credentials.test.ts` "create, list, replace, verify, delete": a distinctive replaced secret must appear in no response.
- `routes/images.test.ts` "POST build ... pull on by default" and "pull:false passes it to Docker": now observe the route's own default via a gated fake build.
- `routes/uploads.test.ts` "GET sends nosniff ...": also CSP `default-src 'none'; sandbox` and `cache-control: private, no-store`; "over real HTTP: a chunked body crossing 20 MiB...": asserts `connection: close`, `vi.waitFor` instead of a 50 ms sleep.
- `routes/inbox.test.ts` "unread-count byAgent...": exact count.
- `routes/templates.test.ts` "validate returns issues; delete removes the folder" now "validate reports a YAML syntax error with its file and line and writes nothing; delete removes the folder".
- `routes/templates.config.test.ts` "a failed write leaves no temp files and still re-indexes": also checks the hash GET config returns matches the file on disk.
- `routes/user-admin.test.ts` "disable and enable publish users_changed after commit": reads `disabledAt` at each frame.
- `config.test.ts` "empty means not set": compares with the unset resolution.
- (server-cross) `routes/messages.test.ts`: gained "human REST send resolves only agents" and "hand-off throws for one recipient" (moved from `messaging/router.test.ts`) and an `item.body` assertion on the two-recipient 202.

### Retained
Auth ordering, list/detail/events paging, 409 mapping per route, path-traversal slug 400s, the workspace pin lock race, the bounded ended list and its index plan, clientMessageId dedupe races, attachment ownership/claim races and limits, the config optimistic-concurrency 409 and parallel-save race, secret redaction, Restart and reset-session matrices, bootstrap and invite races, session deletion on disable, and the WebSocket auth/origin/replay/resync boundary.

### Flagged for review
- `routes/templates.config.test.ts` (near line 256), "template.yaml is as it was after a failed write": not added because it fails today (production defect, see below). Add it when `writeConfig` is fixed.
- `routes/agents.test.ts`, "the stored list keeps only well-formed entries, at most 500, and a plain version": a store test in a route file that mutates shared state; kept.
- `auth/auth.test.ts` mutex spy (near line 340): kept.
- `config.test.ts` `localRuntimeAllowed` (near line 89): kept.
- `routes/settings-routes.test.ts`, terminated-grantee removal (near line 105): kept; the intended survivor in `project-service.test.ts` cannot fail (see Flagged ranking).

## server-domain

Paths under `apps/server/src/`.

### Removed
None.

### Consolidated
- `credentials/credential-service.test.ts`, "remove: an FK violation from a racing grant maps to 409 credential_in_use": into "#30: a live user inserted between the check and the delete is a 409 (the 23514 path)" (added exact message and `archivedUsedBy: []`).
- `credentials/sign-in/host-pty.test.ts`, "argv is the fixed script, the configured bin and the literal setup-token": identical argv assertion already in "spawns python3 with the exact argv, ...".
- `templates/validate.test.ts`, table row `defaultMode`: "a settings.json defaultMode is an error" survives.
- `images/builder.test.ts`, "pull defaults through as true": into "a build tags the user image ... passing pull through" (now also a pull:true build).
- `workspace/claude-md.test.ts`: repeated determinism lines dropped from four tests; one "same inputs give byte-identical output; no timestamps" test now loops over four variants.
- `workspace/mounts.test.ts`, "a granted project inside FACTORY_HOME is refused even when declared" and "refuses a home ancestor and a Docker socket even when they are declared inputs": rows of the "refuses %s" table assert the same messages.
- `workspace/plugins.test.ts`, "failure carries redacted output; budget enforced": failure half dropped; renamed "the install budget is enforced".
- `workspace/safe-fs.test.ts`, "writeFile refuses a symlinked parent": into "...the refusal names the path and is a WorkspaceError" (added the `UnsafePathError` check).

### Rewritten
- `credentials/credential-service.test.ts`: "insertVerified never calls the verifier" now also checks the value is sealed under `credentials:${id}`, absent from the summary, and a duplicate name is 409 credential_exists.
- `credentials/verify.test.ts`: "no session / timeout -> unreachable" renamed "a missing claude binary -> unreachable"; the never-answers test asserts the exact result and elapsed under 5 s.
- `credentials/sign-in/pty-bridge.test.ts`: reads the source and checks the template has no `${` and no extra backtick.
- `secrets/secret-service.test.ts`: the failed-restart test checks the sealed row and one warn with the slug only.
- `templates/template-index.test.ts`: "content hash covers skills/ and files/" edits a skill file and checks the hash changes; the failed-index test uses a real unreadable folder (chmod 000, needs a non-root user).
- `images/builder.test.ts`: the tar sent to Docker is compared with the files the label's hash covers.
- `uploads/sniff.test.ts`: dropped the constant-equals-itself line.
- `uploads/store.test.ts`: refusal of an escaping stored name asserts the specific message and that nothing was written.

### Retained
Security boundaries and state machines: symlink and hardlink refusal, mount policy, redaction, the vault, env allow-lists, the sign-in attempt state machine (cap, TTL, name race, error text never echoed), workspace escape repros (spec 11.4 and 11.7), uploads path safety, and the template scan.

### Flagged for review
- `credentials/sign-in/pty-bridge.test.ts` Python-source substring test: kept.
- `projects/project-service.test.ts` terminated-grantee test: cannot fail (see ranking).
- `templates/template-index.test.ts`, "a slow older scan cannot regress last_valid after a newer scan won": both writes happen before either read, so the race probably never occurs; kept as a consistency test.
- `workspace/claude-md.test.ts` exact-sentence prompt locks (near lines 42, 102, 111): kept.

## server-runtime

Paths under `apps/server/src/`.

### Removed
- `principals.test.ts`: deleted (server-cross); `handle.test.ts` and `names.test.ts` cover reserved handles and slugs.

### Consolidated
- `mcp/bind-hosts.test.ts`, "a non-loopback override address contributes its interface network": into "an override address allows its interface's network, not a /32" (inCidr checks moved).
- `mcp/listener.test.ts`, "a source outside the allowed ranges is closed": subset of "accepts a source inside ... refuses one outside".
- `mcp/tools/schedule-tools.test.ts`: the 20-limit loop (21 round trips) dropped; the service tests cover it.
- `mcp/tools/send-command.test.ts`, "a closing tag in a raw command is neutralised too": into "arguments are neutralised and the line is written as typed".
- `mcp/tools/task-tools.test.ts`, "list_tasks carries the more note ...": into "list_tasks: defaults, filters and the more note"; the base-list equality was replaced by `names("qa")` (server-cross).
- `messaging/router.test.ts`, "rejections are tool errors with one sentence": into `send-message.test.ts` "every recipient refused is a tool error ..." (archived case and nothing-written check moved).
- `messaging/router.test.ts`, "AC 5 ...": into "one inbox item per human recipient; inbox_changed ..." (state = delivered).
- `messaging/router.test.ts`, "`@humans` isn't a handle ...": into "a channel and @humans are refused with their sentences".
- `messaging/router.test.ts`, "human REST send resolves only agents", "a retry with the same clientMessageId..." (client-id retry), "hand-off throws for one recipient", "REST 202 one result per recipient": moved into `routes/messages.test.ts` or covered there (server-cross; three router tests deleted, the client-id one kept in router).
- `runtime/docker/containers.test.ts`, "hardened create options" and "create options: labels, image, ...": into "pinned create options and spec hash" (a full `toEqual` on the options).
- `tasks/task-service.comment.test.ts`, "@humans isn't a handle: the comment posts ...": into "a user mentioned alongside @humans ...".

### Rewritten
- `mcp/tools/send-message.test.ts`: "the description speaks of handles and lists, never @humans" now "the tool never mentions @humans".
- `mcp/listener.test.ts`: "an explicit all-addresses setting accepts any caller and warns exactly once" now "a 0.0.0.0/0 allowed range accepts the loopback caller".
- `mcp/tools/send-command.test.ts`: "a direct report: the note follows its state ..." renamed to the two states it tests.
- `runtime/docker/containers.test.ts`: "a running container with the same spec is reused without a start" asserts no start op.
- `messaging/router.test.ts`: "deliverHeld never throws, even for a row with no agent recipient" now "deliverHeld: a recipient that fails to load is logged, never thrown or unhandled".
- `scheduling/schedule-service.edit.test.ts`: "restore recomputes ..., and ignores the agent limit" split in two; the limit setup now creates exactly 19 and asserts schedule_limit.
- `tasks/task-store.test.ts`: lockAgents EXPLAIN runs on the real SQL object; the comments/events test asserts strictly increasing times.
- `tasks/bodies.test.ts`: tautology dropped from "a forged closing tag is left as is here, for groupEnvelopes to escape" (escaping is tested in `packages/harness/src/envelope.test.ts`).

### Retained
Redaction of sign-in transcripts, target authorization and `/compact` focus neutralising, the router (AC flows, caller identity, archive/terminate races, R4 inbox rules), lock-order races in scheduling, the Docker networking check (`linux-reach`, wired in CI), spawn grant intersection and limits, terminate authorization, credential pause windows, and task lock races.

### Flagged for review
- `messaging/handle-writers.test.ts` (lines 24, 36): regex source scans that can miss writers.
- `supervisor/reconcile.test.ts` (line 684): EXPLAIN on hand-copied SQL, planner dependent.
- `runtime/docker/containers.test.ts` (near line 142): intentional pins (LAUNCHER_VERSION, hash digest).
- `runtime/docker/docker.int.test.ts`: runs in no CI job (see Follow-ups).

## web-session

Paths under `apps/web/src/features/session/`.

### Removed
- `activity-line.test.tsx`, "the line stops at the rows' right gutter": one static class constant.
- `subagent-card.test.tsx`, "the body is indented with a neutral rule guide, no fill and no box": static classes only.

### Consolidated
- `activity.test.ts`, "thinking counts only while a thinking block is open": into "live inputs outrank rows (PR4 shape)..." (the `{ tokens: 0 }` case moved).
- `messaging.test.tsx`, "a task_assigned envelope is a Factory message block...": into "a task_assigned notice is a quiet line..." (added the `/tasks/T-1` href).
- `messaging.test.tsx`, "an outgoing card reads 'Name -> Recipient' with the agent's name": covered by speaker-line and outgoing-message tests.
- `speaker-line.test.tsx`, "several recipients: the first two handles and a count...": into `outgoing-message.test.tsx` "a send to ten people..." (added "All humans" absence).
- `row-menu.test.tsx`, "200 rows mount 200 plain triggers and no menu root": into `timeline-perf.test.tsx` "200 rows at rest mount no menu root..." (exact copy-link count restored after the audit).
- `rows.test.ts`, "runDisplayPasses keeps every row it doesn't merge": into `display-passes.test.ts`.
- `timeline-item.test.tsx`, "itemPropsEqual: the live flag is a change": into `timeline-perf.test.tsx` "itemPropsEqual: unrelated keys...".
- `tools/bash.test.tsx`, "the stderr plate is named by its label": into "expanded: stderr that ends the content gets its own plate with a label".
- `tools/diff.test.tsx`, "partial: show raw output keeps the 'Diff truncated' marker...": into "partial: Diff truncated - show raw output" (renamed).
- (web-cross) `lifecycle.test.tsx`, "the header has no Stop...": into `test/session-view.test.tsx` header test.
- (web-cross) `messaging.test.tsx`, "?message= for a delivered message loads the window around its recipient event": into `test/session-view.test.tsx` "?message= resolves the message before asking for the events window".

### Rewritten
- `compact-popover.test.tsx`, "a failed compact shows its message in an alert...": structure asserts replaced by "the alert is inside the dialog".
- `composer.test.tsx`: draft test remounts and reads back; phone test asserts the note line is absent after unmount.
- `rows.test.ts`, "a tool row carries when it was called and when its result arrived": distinct timestamps.
- `session-state.test.ts`: window-mode tests assert `maxSeenSeq` and state identity.
- `messaging.test.tsx`, "?message= opens the recipient's event window, or says why it can't": renamed "?message= for an unknown message falls back to the latest with a note".
- `outgoing-message`, `queue-items`, `speaker-line` chip helper: selector `[data-agent-avatar]` instead of an inline width style.
- `tools/bash.test.tsx`: "Show input is a disclosure button: aria-expanded flips when it is clicked".

### Retained
Dedupe and ordering of session events, batching equals single frames, epochs and hand-offs, Cancel/Undo races, the Sending/landed lifecycle, untrusted markdown rendered as code and mermaid never invoked, ReDoS linear-time guards, frame batching under StrictMode, and live state surviving a socket drop.

### Flagged for review
- `queue-items.test.tsx`, "queued bodies clamp at three lines": kept; the only check that QueueItems passes `brief` to MessageBlock.
- `messaging.test.tsx`, "a pre-S6 member_update without parts renders its body as one part": guards a compat branch (see defects).
- Layout class guards (200% text wrap, "the log clips sideways overflow"): classes only, kept as regression guards.
- Timing thresholds (`output.test.ts` 50 ms, `search.test.tsx` 100 ms, `bash.test.tsx` 500 ms): can flake under load.
- Unused composer helpers `_accepted202` and `_sleep` left in `composer.test.tsx`.

## web-features-a

Paths under `apps/web/src/features/`.

### Removed
- `config/fields.test.ts`, "every field has a path": type-enforced.
- `config/messages.test.ts`, "the spec's copy, verbatim" and "the sections' copy, verbatim": constants equal to their literals.
- `agents/derive-slug.test.tsx`, "reserved and human handles count as taken": duplicate of the "-2" suffix test.

### Consolidated
- `config/messages.test.ts`: the two 40-character tests into one test.each.
- `config/config-form.test.tsx`, "every mapped field renders a note target...": into "every field's issue lands on its note...".
- `inbox/inbox-pane.test.tsx`: class line and a `[data-live]` check dropped from two tests.
- `chat/chat-state.test.ts`, "an optimistic entry and its server row are one key": into "your send is its server row's key...".
- `chat/turn-line.test.tsx`, "a long name leaves the duration and the link whole": into "the working line is the thread's last row..." (added `min-w-0`).
- `chat/use-chat.test.tsx`, "a 51st entry leaves the other 50 entry objects identical": covered by chat-state and chat-perf.
- `chat/chat-composer.test.tsx`, "the /command note shows only for a known command once the list has loaded": into "a leading /word is a note only for a command the loaded list knows"; "a stored recipients list that isn't string[]...": into "stored recipients: ..." (added the non-string case).
- `agents/colour-field.test.tsx`, "an avatar version replaces the group with the line": into `edit-agent-sheet.test.tsx` "an agent whose template has an avatar.svg gets the line, not the group".
- `agents/new-agent-sheet.test.tsx`, "the address follows the display name; a taken one gets a suffix": into `address-line.test.tsx` "a taken address shows its suffix".
- `inbox/inbox-read.test.tsx`, "unread rows have an ink dot...": into `inbox-list.test.tsx` "unread rows have an ink dot, medium weight and an 'Unread, ' name; read rows are muted and have none".
- (web-cross) `agents/new-agent-sheet.test.tsx`, "the Agents header opens New agent", "the Agents empty state opens New agent", "the template editor's Create agent opens New agent...": into `test/agents-tree.test.tsx` and `test/templates.test.tsx`.
- (web-cross) `agents/agent-header.test.tsx`, "the header does not remount across a switch": into `test/agent-routes.test.tsx`.
- (web-cross) `palette/rank.test.ts`, "Go to has unique ids...": into `test/command-palette.test.tsx` "Go to includes Usage..."; the command id and path test was restored in `rank.test.ts` after the audit.
- (web-cross) `palette/rank.test.ts`, "Actions never offer Mark all read": into command-palette "Actions: no 'Mark all read'...".
- `agents/address-line.test.tsx`, "Change is a skip control...": behaviour test now in `new-agent-sheet.test.tsx` ("Change is a skip control: pressing it doesn't validate the Display name being left").

### Rewritten
- `config/messages.test.ts`: "the page's copy, verbatim" now "the page's interpolated lines (spec 12.4)" with `restartPendingLine("")`.
- `config/model-field.test.tsx`: the server-issue test passes a real issue; agent-mode options compare against `MODEL_ALIASES`/`MODEL_IDS`.
- `config/config-list.test.tsx`: dropped min-height classes.
- `inbox/inbox-list.test.tsx`: "a message row's context line..." uses `[data-agent-avatar]`.
- `inbox/inbox-read.test.tsx`: "middle-click and Enter open too..." checks the optimistic flip and the rollback.
- `chat/chat-composer.test.tsx`: "typing clears the chip's selection" asserts `data-selected` is gone right after typing.
- `agents/agent-combobox.test.tsx`: `[data-agent-avatar]`.
- `agents/edit-agent-sheet.test.tsx`: "a saved colour invalidates the inbox list..." checks `isInvalidated` before and after.
- `agents/new-agent-sheet.test.tsx`: "projects: the template's set is checked..." asserts the template grant is checked on open.

### Retained
Setup-in-sheet states, slug and address error paths, double submit, stale-draft notes, focus on open, recipient handling and the 10-recipient cap, chat message ordering and perf contracts, optimistic send as one node, config form tolerance for wrong types and unknown keys, and ranking tiers.

### Flagged for review
- `config/api.test.ts` (staleTime), `config/use-config-draft.test.tsx` (no-effect grep), `inbox/inbox-pane.test.tsx` (strip classes; read-from overlap with `test/read-from.test.tsx`, 1.3 s real sleep), `inbox/inbox-list.test.tsx` (`formatInboxTime` unit test misplaced), `inbox/inbox-read.test.tsx` (collapsed-rail dot), `chat/chat-composer.test.tsx` ("To:" truncate), `agents/colour-field.test.tsx` (ring-offset): kept as is.

## web-features-b

Paths under `apps/web/src/features/`.

### Removed
- `usage/format.test.ts`, "rate limit windows": snapshot of a constant; `settings/rate-limit-line.test.tsx` covers the mapping.

### Consolidated
- `schedules/new-schedule-sheet.test.tsx`, "the list shows no inline Created line": into "success closes, clears the draft and toasts Created with Open...".
- `settings/credentials-section.test.tsx`, "a sign-in attempt change does not re-render...": tail trimmed (covered by "a create attempt appearing after load does not open the inline form").
- `settings/forms/forms.test.tsx`, "credential and project: a duplicate-name code...": project half dropped, renamed "credential: ..."; "project: a server fields.hostPath lands under Path and focuses it": into "project: a relative path shows the start message on blur; a server hostPath error focuses Path" (the audit found the server message no longer distinct; restored).
- `sheets/form-footer.test.tsx`, "the footer's Close and the header's X both carry data-skip-validate": covered by the behavioural test.each.
- `tasks/task-detail.test.tsx`, "comment composer: Enter posts once, Shift+Enter adds a line": into `tasks/comment-composer.test.tsx` "Enter posts (U1 rule) once and Shift+Enter adds a line; Send is the labelled primary".
- `tasks/task-detail.test.tsx`, usage pair: renamed the first to "the usage line and its lower-bound hint show when the task has usage".
- `tasks/task-form.test.tsx`, "a dependency error after submit opens More options itself": covered by "bad keys on submit with More options folded by the user..."; "a stale assignee says the agent has ended": `aria-invalid` moved into "a stale assignee blocks the submit until another is picked; Unassigned goes through".
- `templates/code-editor.test.tsx`, "on desktop diagnostics get the lint gutter": covered by "crossing the phone breakpoint keeps the diagnostic marks".
- (web-cross) `tasks/comment-composer.test.tsx`, "the Write/Preview toggle sits in the composer's toolbar": into `components/composer/composer.test.tsx` "preview: a Write/Preview toggle in the toolbar...".
- (web-cross) `tasks/task-detail.test.tsx`, "comment composer: Enter during IME composition does not post": into the shared composer IME tests.
- (web-cross) `usage/format.test.ts`, "formatTokens gains M": cases moved to `session/format.test.ts` "tokens".

### Rewritten
- `schedules/describe-cron.test.ts` "presets": constant snapshot dropped.
- `schedules/edit-schedule-sheet.test.tsx`: "a double click on Delete sends one DELETE" (second clause removed from the name).
- `schedules/schedule-form.test.tsx`: zone select asserts its accessible name carries the detected zone.
- `schedules/schedule-list.test.tsx`: load error moved to a new "a failed first load shows the load error with Retry, and Retry loads the list" (a refetch failure keeps the stale list, so the review's suggestion was not used).
- `settings/forms/add-credential-form.test.tsx`: dropped the constant check.
- `sheets/drafts.test.ts`: "clearDraft removes one key and leaves the others".
- `sheets/form-footer.test.tsx`: Discard added as a third case of the skip-validate test.each.
- `tasks/comment-composer.test.tsx`: dropped the retired sessionStorage key assertion.
- `tasks/task-detail.test.tsx`: "composer: with nothing typed during the post the draft clears" checks the stored draft; "?comment=<id> ..." dropped position classes.
- `tasks/task-form.test.tsx`: "Close dismisses the sheet without a dialog and keeps the draft" spies `window.confirm` and reopens the draft.
- `tasks/task-list.test.tsx`: creator filter asserts the full ordered list.
- `tasks/link-editor.test.tsx`: full kind, target, title, remove order.

### Retained
Cron sentences and error copy, first-invalid focus order, zone typeahead, validation timing on leave, dependency lookup races, single POST on double Enter, link row validation, Discard semantics, the 64 KB body limit, and unsafe markup never injected into task titles.

### Flagged for review
- `schedules/edit-schedule-sheet.test.tsx`: footer classes test; "the old page URL opens the sheet over the list..." (route `schedules.$key.tsx` is labelled "old page URL", a compat question, see defects).
- Zone offset cache, "sign-in again" registry snapshot, `tasks/task-detail.test.tsx` data-variant tests (outline Edit, ghost Cancel), raw-source regexes, `.prose-of-detail`, `tasks/task-list.test.tsx` layout classes: kept.

## web-app

Paths under `apps/web/src/` (`test/` is `apps/web/src/test/`).

### Removed
- `test/session-view.test.tsx`, "no strip: 'Reports to' no longer renders under the header": guards a deleted feature; selector can never match.
- `test/session-view.test.tsx`, "a resume error no longer names the interim reset script": deleted-copy check. The audit found the positive half (a resume error shows in the timeline) was lost; restored as a new assertion.
- `test/agents-tree.test.tsx`, "row starts with AgentChip (avatar, name, @slug)": existence only.
- `test/agents-tree.test.tsx`, "the tree asks for the rolling window": cannot fail on its own.
- `test/settings.test.tsx`, "/settings/secrets?addSecret=GH_TOKEN opens the add form with the name": strict subset of another test.
- `test/templates.test.tsx`, "CodeMirror: template.yaml renders in the editor once the lazy chunk resolves": covered elsewhere.
- `test/route-states.test.tsx`, "the expandable quiet line and compaction marker render a rotating chevron": icon class only.
- `test/task-peek.test.tsx`, "the shortcuts sheet says Space selects or peeks": static label.
- `test/row-nav.test.tsx`, "the current row carries the class the selected style hangs on": asserts the fixture's own markup.
- `test/empty-states.test.tsx`, "/ opens the Inbox, empty": duplicate of a test.each row and a shell test.
- `test/use-mobile.test.ts`, "queries the rem-based breakpoint": constant against itself (the exact `48rem` pin is an accepted loss).
- `test/radio-group.test.tsx`: both tests, file deleted; they test Radix and a vendored wrapper's classes.
- `test/ui-contract.test.ts`, "NativeSelect is gone": migration leftover.
- `lib/form-messages.test.ts`, "the sign-in other-panel line is the spec's text (I3 6.3)": constant equals its literal.
- `lib/factory-bot.test.ts`, "only fill changed against the 8-colour seeding (same face parts)": the inline golden pins it.
- `lib/drafts.test.ts`, "keys are versioned per agent and per task": restates two helpers.

### Consolidated
- `test/session-view.test.tsx`: five fix-link tests into test.each "an error with fix %s links to %s" (6 rows).
- `test/agent-menu.test.tsx`: "archive blocked by live spawned agents toasts the server's advice..." into test.each "a failed archive (%s) toasts the server's message, naming the agent"; composer.test "compact: Escape closes the popover and focus returns to the trigger" into agent-menu "Escape from the compact popover..." (no POST).
- `test/agents-tree.test.tsx`: "runtime badge: Unsandboxed for local, nothing for docker" into "'Unsandboxed' only for local runtime; Docker never shown"; the two explanation-line tests into one test.each over /agents and ended-only; `test/agents-list.test.tsx` "an empty list says so and offers to create the first agent" into the agents-tree empty-state test.each.
- `test/settings.test.tsx`: "Replace token and Update value validate on blur of a changed field" and "Update value validates on blur...": one test.each.
- `test/settings-factory.test.tsx`: allowed local runtime reads Allowed + read-only runtime row: one test.each.
- `test/sign-up.test.tsx`: "a 403 invite_invalid on submit shows the invalid line at form level" into "the gate's real 403 body (nested error) maps to the invalid line"; "a 403 invite_required after loading as bootstrap..." (flat shape) into the nested-shape test; "without an invite the state URL has no query string" into the bootstrap test.
- `test/usage-page.test.tsx`, "/usage is the Usage page: a heading, the range control, and no Settings sub-nav": into "Usage: range, Daily chart...".
- `test/templates.test.tsx`: "Delete confirms and lands on the list" into "...'Deleted x.' shows once..."; "Reload says it discards edits..." and "the changed-on-disk block takes focus on its Reload button": into "CodeMirror: a reload replaces the doc..."; list header 200% text test merged into "list header (class contract...)".
- `test/timeline-anchor.test.tsx`: "at the bottom, a width change keeps it pinned" and "captureAnchor takes a fresh anchor for a toggle that follows no scroll": into stricter survivors.
- `test/command-palette.test.tsx`: "off an agent page neither view action is offered" into "Actions: no 'Mark all read'; 'Agent details' and the view actions only on agent pages".
- `test/confirm-dialog.test.tsx`: "desktop: while pending the action shows the pending label and a spinner, and Esc does nothing" into "while pending the action keeps focus, and Escape and Cancel are ignored".
- `test/global-shortcuts.test.tsx`: "g then t within a second goes to Tasks; after a second it does not" (timeout covered by `lib/shortcuts.test`).
- `test/field-shell.test.tsx`: "FieldShell legend renders a fieldset". `test/inline-outcome.test.tsx`: "error text appears in an already-mounted alert region" into "success renders inside the status region, error inside the alert region". `test/empty-states.test.tsx`: "the sidebar links every section in order" (shell test has the nav order). `test/ui-contract.test.ts`: "${f} uses the one base-layer focus ring" (superset scan survives). `lib/ws.test.ts`: reconnect/backoff and send/onOpen pairs merged.
- (web-cross) `test/session-view.test.tsx`, "the Stop button uses the stop glyph": into `features/session/composer.test.tsx` "Stop is outline...".
- (web-cross) `test/agent-details.test.tsx`, "Now: a terminated agent shows when it ended and offers Pin": into `features/session/terminate.test.tsx`.
- (web-cross) `test/settings.test.tsx`, "add credential: an unverifiable check..." and "add secret: 409 secret_name_reserved...": into `features/settings/forms/forms.test.tsx` (credential path differs: API key radio vs pasted token, same form code).
- (web-cross) `test/templates.test.tsx`, "new template: a taken name...", "...a name the routes use is reserved", "...blur validates the name; submit validates everything", and the MarkdownEditor no-writeSurface test: into `features/templates/new-template-form.test.tsx` and `components/markdown/markdown-editor.test.tsx` (the combined bad-name plus missing-display-name submit is an accepted loss).
- (web-cross) `test/inbox-pane-content.test.tsx`, "the mention reply is the shared composer...": into `features/tasks/comment-composer.test.tsx`; `test/inbox-pane.test.tsx`, "a message row's context line hides the recipient...": into `features/inbox/inbox-list.test.tsx`.
- (web-cross) `test/route-states.test.tsx`, "ResourceNotFound shows a given detail": into `features/tasks/task-detail.test.tsx`.
- (web-cross) `test/composer.test.tsx`: "Send is disabled for whitespace...", "slash text goes to /input", "IME composition Enter does not send", "Stop: not offered", "Stop: when the turn closes under a focused Stop": into `components/composer/composer.test.tsx` and `features/session/composer.test.tsx`. "compact: an error shows inside the popover and it stays open" was folded, then restored (see Flagged ranking).

### Rewritten
- `test/session-view.test.tsx`, "a stale list status turning into the loaded one is not announced": checks the polite sr-only status region is empty (audit: it takes the first such element).
- `test/agent-menu.test.tsx`, "Edit and Compact are left out for a spawned agent; ..." now "Edit is left out for a spawned agent; Stop crons... is offered with live crons" plus a no-crons test (a live spawned agent does offer Compact, so that claim was dropped).
- `test/sidebar-tree.test.tsx`: renamed to the expanded case.
- `test/agent-details.test.tsx`: "Now: the queued and rate-limited details" now "Now: an agent pulling its image says so"; the usage test covers zero turns.
- `test/agent-details-modes.test.tsx`: overlay test clicks Stop and asserts one interrupt POST.
- `test/agent-routes.test.tsx`: session scroll position restored after a switch.
- `test/settings.test.tsx`: Section select test asserts navigation, no class regexes.
- `test/agent-usage.test.tsx`: class check dropped.
- `test/templates.test.tsx`: keyboard hint shows on focus and hides on blur.
- `test/template-config-tab.test.tsx`: Discard with only an MCP editor open asserts no Undo.
- `test/agent-config-page.test.tsx`: server issue lands on its row and a second 400 replaces it; "save outcome: a running agent restarts when idle".
- `test/shell.test.tsx`: dropped data-attribute and class checks.
- `test/read-from.test.tsx`: "a hover preload of a session with unread messages never calls read-from".
- `test/ws-hub.test.tsx`: non-specific listener spy dropped.
- `test/route-states.test.tsx`: AppPending positioning.
- `lib/breakpoints.test.tsx`: unrelated assertion dropped. `lib/factory-bot.test.ts`: "every part stays an integer in its range, over many slugs".

### Retained
Live append and subscribe seq, deep-link windowing, reconnect and resync recovery, pill counts, roving tabindex, queued and sending reconciliation, the auth boundary (disabled account, 502, redirect), read-marking concurrency rules (one post, throttle, no retry), palette stale-row races, config Undo and 409 rebase, and focus return.

### Flagged for review
- `test/confirm-dialog.test.tsx`, "pendingLabel is required": proposed for removal, kept. Its `@ts-expect-error` is checked by typecheck; the runtime assertion only keeps the element used (lead decision).
- `test/composer.test.tsx`, "compact: an error shows inside the popover and it stays open": restored by the lead (see ranking).
- `test/agents-tree.test.tsx` "an old ?archived=only bookmark..." and `test/agents-list.test.tsx` (?archived alias, line 340): compat alias under ADR 0028; kept pending a product decision.
- `test/session-view.test.tsx`, "an unknown agent shows the not-found state": pins the generic "Page not found." while other routes say "Agent not found.".
- Class-contract tests kept: session-view (lines 638, 991), sidebar-tree (271), agents-tree (357), agent-details (292), settings (251, 1046), usage-page (150), templates (143, 976), template-config-tab (99), agent-config-page (108), agents-list (188), ui-contract (301, 308, 333, 346; loosening not applied), `settings-users` (353), `shell` (138), field-shell "FormField keeps its API".

## components, packages, e2e

### Removed
- `packages/shared/src/host.test.ts`, "the relative-path message": constant equals its literal.
- `packages/shared/src/agents.test.ts`, "agent summary carries turnStartedAt and compacting": field existence; typecheck guards it.
- `packages/shared/src/messaging.test.ts`, "a looked-up message can be cancelled": enum contains a value.
- `packages/shared/src/ws.test.ts`, "liveKey joins ...": restates a template string.
- `packages/shared/src/config.test.ts`, "keeps messages short and lists the choices": covered by "keeps every message at 40 characters".
- `packages/db/src/schema.s10.test.ts`, "credentials rate-limit columns are nullable" and "users.disabled_at is nullable": column existence.
- `packages/harness/src/envelope.test.ts`, "scheduled rendering is deterministic": same input twice.
- `apps/web/src/components/agent-chip.test.tsx`, "the slug reserves no minimum width ...": negative check of one class.
- `apps/web/src/components/ui/button.test.tsx`, "the secondary variant is gone": no runtime assertion.
- `apps/web/src/components/ui/segmented-links.test.tsx`, "the SegmentedControl look ...": restated classes.

### Consolidated
- `shared/claude-sign-in.test.ts`, "sign-in messages %s <= 40 chars": into `messages.test.ts` "every field message is at most 40 characters".
- `shared/schemas.test.ts`, "the limits are 80 and 254": into the 80/81 and 254/255 boundary tests.
- `shared/messaging.test.ts`, "all and system are reserved handles; OPEN_FACTORY_ secrets...": into `handle.test.ts` and `names.test.ts`.
- `shared/events.test.ts`: "factory is a reserved handle" into `handle.test.ts`; "S4 additions", "message_in accepts system notices...", "S7 events parse; old rows still parse", "S10 harness events", "interrupt_unconfirmed is a factory event": into the samples table in "accepts every harness and factory event type" (round-trip `toEqual`, stricter).
- `shared/config.test.ts`: "exports the limits and names" dropped; describe "modelSchema" moved to `models.test.ts`.
- `shared/commands.test.ts`: "the reason names the command as typed" into "/%s has its exact reason"; "a known multi-line command is flagged" into the multiline `.each`.
- `db/schema.schedules.test.ts` "every S3-S8 shape ..." and `schema.tasks.test.ts` "every pre-S8 shape ...": into `schema.messages.test.ts` "every valid sender/recipient shape passes (chat, member, system, task and scheduled)". The audit found the `peer_left` insert missing; restored.
- `harness/args.test.ts`, "args include --include-partial-messages": into "auto mode" and "bypass uses ..."; `harness/process.test.ts` "args: fixed flags..." absorbed.
- `harness/envelope.test.ts`, "envelope carries kind=system": into "other kinds carry from_kind and no to".
- `components/agent-avatar.test.tsx`: "no badge hole at rest: %s" and "badge hole for %s" into three tests that imply both.
- `components/ui/button.test.tsx`: six disabled-style tests into one test.each over variants.
- `components/page-header.test.tsx`: "a static title has no title attribute" into "a static title never shrinks and has no title attribute".
- `shared/config-merge.test.ts`: repeated `mergeConfig(base, {})` line dropped.

### Rewritten
- `shared/claude-sign-in.test.ts`: "inbox has the credential kind and link" now "a credential inbox item needs a named credential link; unknown link kinds are refused".
- `shared/agents.test.ts`: "send body: clientMessageId is an optional UUID (the idempotency key)".
- `shared/schedules.test.ts`: "the crons_stopped reasons, the scheduled wake reason and the frame" (refusal of an unknown `background_work_lost` reason).
- `components/ui/segmented-control.test.tsx`: "the track grows to a touch target; segments keep a border so selection never shifts".

### Retained
Shared schema boundaries (limits, reserved handles, event round trips), db CHECK constraints and FK shapes, harness process and envelope contracts, CLI tests, and component tests of behaviour (truncation, touch targets, sr-only, reduced motion, selection stability).

### Flagged for review
- `db/migrate.test.ts` (line 37): hard-codes the first two journal entries.
- `db/schema.s10.test.ts` (line 52): index DDL text.
- `web/.../mapper.test.ts` (line 1050): opaque digest snapshot.
- `web/components/select.test.tsx` (line 32); `markdown.test.tsx` (lines 159, 166, 323).
- `stream-tail.test.ts` (line 169) and the harness "a half link in a long run of brackets is linear (M1)": wall-clock thresholds.
- `composer` (lines 78, 88), overlay timing, toaster, sheet (2), drawer (2): class or timing contracts, kept.

## Flagged for review (ranked)

1. `templates/template-index.ts` `writeConfig`: multi-file save is not atomic. The planned assertion "template.yaml is as it was after a failed write" fails today, so it was not added (see defects).
2. `test/composer.test.tsx`, "compact: an error shows inside the popover and it stays open": web-cross folded it; the lead restored it. The survivor (compact-popover unit test) cannot assert the popover stays open with the typed value, because `open` is a fixed prop there.
3. `test/confirm-dialog.test.tsx`, "pendingLabel is required": kept on purpose. The guard is type-level (`@ts-expect-error`, checked by typecheck); the runtime part is thin.
4. Compat leftovers: resolved, deleted with their tests (see Decisions).
5. `project-service.test.ts` terminated-grantee half: resolved, deleted; the filter it named is dead code (see Decisions).
6. Tests the review found unable to fail were removed (`row-nav` selected-class, `agents-tree` rolling-window) or rewritten (`read-from` preload with unread messages, `ws-hub` listener spy); `confirm-dialog` "pendingLabel is required" stays as a type-level guard (item 3).
7. Audit restores (commit 8d6a9e7): `schema.messages` `peer_left` insert, "resume error shows in the timeline" (session-view), a distinct server hostPath message (forms.test), the Go-to command id and path test (`palette/rank.test.ts`), the exact copy-link count (`timeline-perf`/`row-menu`).
8. Accepted audit losses (low severity, all with other coverage): `verify.ts` source lint; three real-database config-change tests (fake-world equivalents in `config-changes.flow.test.ts` lines 197, 228, 276 and `runtimes.config.test.ts` stay); the cap and debounce config tombstone (`app.test.ts` covers a set value having no effect); gif, webp and data.json upload route rows (`sniff.test` covers them); bad name and missing display name submitted together; the exact `48rem` pin.
9. `session-view.test.tsx`, "a stale list status turning into the loaded one is not announced": takes the first polite sr-only status element; passes vacuously if another renders first.
10. Class-contract tests: resolved, removed (see Decisions).
11. Agent-menu premise: the review said a spawned agent has no Compact; a live spawned agent in the session does offer it. The test was narrowed instead.
12. `terminate.test.ts` escalation count: the review said `stop_escalated` is recorded once; the real baseline is 2. The test asserts "the sweeps add none".
13. `template-index.test.ts` unreadable-folder test needs a non-root user (chmod 000 is ignored as root).
14. `builder.test.ts` tar test detects tar/label divergence but not a second walk (no production hook).
15. `template-index.test.ts` "a slow older scan cannot regress last_valid...": does not reproduce its race.

## Suspected production defects (not fixed)

- `apps/server/src/templates/template-index.ts` (`writeConfig`, lines about 515-535): multi-file saves rename temp files one after another. If a later rename fails, template.yaml is already replaced and the route returns 500. That contradicts the comment "a failed write leaves the template as it was". A test assertion exposed it (effort low is written before the settings.json rename fails).
- `apps/server/src/routes/inbox.ts` (lines 152-153): POST `/api/inbox/:id/read` publishes `inbox_changed` even when the item was already read; read-all, undo and read-from publish only on a change. A spurious refetch frame.
- `apps/server/src/auth/auth.ts` (lines 22-27, low confidence): `isDisabled` returns false for an unknown user id, while `UserAdminService.isDisabled` treats an unknown user as disabled. Harmless while users cannot be deleted.
- `apps/server/src/users/invites.ts` (lines 86-89, low confidence): `restore` reads the creator's disabled state in a separate SELECT before the UPDATE; a racing disable can leave `revokedAt` null. `check` and `listPending` still refuse the invite.
- `apps/server/src/uploads/sniff.ts` (line 16): `IMAGE_TOO_LARGE` ("Image is too large (max 8000 px a side).") is also the reason for the 50 MP cap, so an 8000 by 8000 PNG is refused with a message that says it is within limits.
- `apps/server/src/workspace/links.ts` (line 52) and `templates/validate.ts` (line 99): a regular file in `skills/` gets "skills/README.md must be a folder, not a link." (misleading). `links.test.ts` (line 204) locks the wording in. The skills-folder rule is implemented twice.
- Duplicate keyed mutex: `workspace/lock.ts` `KeyedMutex` and `templates/key-lock.ts` `KeyLock` have the same semantics. Merge and keep one test file.
- Duplicated config Discard, Undo and MCP-editor save lock in `features/config/config-page.tsx` and `features/templates/template-config-tab.tsx`; `hooks/use-mobile.ts` duplicates `lib/breakpoints.ts` `useMedia`.
- Compat leftovers against ADR 0028: deleted in this branch (see Decisions). The legacy form-URL redirects in `features/sheets/redirect.ts` remain.
- Agent not-found copy is inconsistent: a cold load of an unknown slug shows "Page not found." (`routes/_app/agents.$slug.tsx` throws `notFound()` with no `notFoundComponent`), while the cached path, usage and config routes show "Agent not found.".
- `apps/server/src/projects/project-service.ts` `grants()` `isNull(terminatedAt)` filter is dead code: termination deletes grant rows in the same transaction (and if a terminated agent ever kept one, the FK would still block the delete).
- `images/builder.test.ts` "pull defaults through as true" never exercised the default (it passed `pull: true`); the route-level test now covers the default.

## Follow-ups

- Slow tests with real sleeps: `read-from.test.tsx` (line 152, about 3.6 s), `inbox/inbox-pane.test.tsx` (lines 218 about 760 ms, 290 about 1.3 s), `chat/chat-perf.test.tsx` (line 111, about 2.1 s), `inbox/inbox-list.test.tsx` (line 471, 300 ms). Use fake timers.
- Flaky wall-clock thresholds: `output.test.ts` (50 ms, three tests), `search.test.tsx` (100 ms), `bash.test.tsx` (500 ms), `stream-tail.test.ts` (line 169, 100 ms), harness M1 linear-time test. Compare 64k against 128k input or widen the bound.
- `apps/server/src/runtime/docker/docker.int.test.ts` is gated by `FACTORY_DOCKER_TESTS=1` and runs in no CI job.
- Smoke scripts: root `smoke:*` scripts (`apps/server/scripts/smoke-*.ts`) are manual only; `smoke-harness` and `smoke-workspace` may be superseded and read the token from the env. Only `scripts/smoke-cli.sh` and `images/base/test/smoke.sh` run in CI.
- `credentials/credential-service.test.ts` tests depend on each other's state in order (the "work" credential carries across tests); they break when run alone or reordered.
- `db/migrate.test.ts` (line 37) hard-codes the first two journal entries; it breaks if migrations are squashed.
- Coverage gaps found and not closed: `MAX_FOCUS_CHARS` refusal on `/input` (`routes/agents.ts` line 403; `/compact` now covered); the 408 `upload_stalled` mapping (`routes/uploads.ts` line 104); `SecretService.put` concurrent-insert 23505 branch; `templateUsageLine(0, 0, false)` has no test.
- Dead code in tests: `void real;` in `scheduling` tests (line 251); unused `_accepted202` and `_sleep` in `features/session/composer.test.tsx`; dead header counter removed with agent-header test.
