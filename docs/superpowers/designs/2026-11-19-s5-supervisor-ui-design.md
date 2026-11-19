# S5 Supervisor and Docker: UI Design

- **Date:** 2026-11-19
- **Status:** reviewed against DESIGN.md (impeccable review: findings applied; see the decision issue)
- **Spec:** [`docs/superpowers/specs/2026-11-19-s5-supervisor-docker-design.md`](../specs/2026-11-19-s5-supervisor-docker-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md) and [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth): Colors → Semantic (`--status-*`), Shapes → The pitch, Components → Destructive actions, Status Is Never Colour Alone.

## 1. What changes

S5 makes the agent lifecycle visible: two new statuses (Queued, Rate-limited), what keeps an agent awake, why it hibernated, crash recovery, Restart and Start a new session, Factory notices, and the runtime (Docker, Unsandboxed, local runtime disabled). No new pages. Every piece of data comes from the spec's §8.2 status fields and §15 events.

**Terms.** In-session crons (Claude's `CronCreate` / `/loop`) are called **crons** everywhere in S5 ("2 crons", product: "pinned by N crons"), never "scheduled jobs" or "reminders", so they can't be confused with the Schedules page. S4's "Why?" popover and success lines that say "Reminders it scheduled in this session are lost" change to "Its crons from this session stop" (§3.2).

**Credential names** are always set in mono (`work`), as in S4's strip.

## 2. Statuses

The S3 status slot (a fixed 12×12px slot plus a label) gains two statuses. All six:

| Status | Slot | Long label (session header, strip) | Short label (lists, tab title, header below `md`) | Token |
|---|---|---|---|---|
| `working` | the `.of-tooth`, **never a dot** | Working | Working | `--status-working` (signal) |
| `idle` | 6px dot | Idle | Idle | `--status-idle` |
| `queued` | 6px dot | Queued | Queued | `--status-queued` |
| `rate_limited` | 6px dot | Rate-limited until 14:30 · fallback: Rate-limited, retrying at 14:30 | Rate-limited | `--status-rate-limited` |
| `errored` | 6px dot | Errored | Errored | `--status-errored` |
| `hibernated` | 6px dot | Hibernated | Hibernated | `--status-hibernated` |

- **Distinguishability rests on shape plus label, not hue** (measured in the review): in light theme, `working` (#DD4202) and `rate_limited` (#9F7A00) are the same colour at almost the same lightness for people with deuteranopia (ΔE 1.0, brightness ratio 1.09); `queued` and `idle` are indistinguishable for tritanopes and in greyscale (brightness ratio ~1.05). So `working` **always** renders the tooth and never a dot, on every surface and variant (session header, Agents list, org tree, mobile rows), and every status always carries its text label. The tokens stay as they are (retuning the ochre doesn't separate it for deuteranopes and breaks other pairs). DESIGN.md's "checked side by side" note gets the measured result (listed for the lead in the spec §20).
- **Hibernated contrast:** the dot is 2.96:1 on the hover row in both themes (below 3:1 for non-text UI). S5 sets `--status-hibernated` to `oklch(0.6 0.01 255)` (light, ≈3.2:1 on hover) and `oklch(0.57 0.008 255)` (dark).
- **Time format** for rate-limit windows (up to 7 days): today `14:30`; within the next 6 days `Thu 09:10`; otherwise `27 Nov 09:10`. Local time.
- **Fallback window** (`rateLimitExact: false`): every string that would state a reset time says "retrying at …" instead of "until …" (strings in §8). It never claims a time Claude didn't report.
- `document.title` = "<short label> · Name · Open Factory".

## 3. Session view

### 3.1 Header actions

S3's actions slot. While **Errored**, the recovery actions **replace** Compact and Interrupt (nothing can be compacted or interrupted then), so the header never holds more than two actions:

- **Restart** (`RefreshCcw`, ghost button; not `RotateCw`/`RotateCcw`, which S4 uses for "restart pending"), when `status = errored`, `errorKind ≠ resume_unrecoverable` and `runtimeDisabled` is not set (a Restart that is certain to fail isn't offered; §3.2's disabled segment explains). Click → `POST …/restart`. While pending it reads "Restarting…" with `aria-disabled` (S3 Interrupt pattern). The pending state ends on the response **and** the next `agent_status` frame, or on the next `error` event, whichever comes first, so a failed Restart returns to "Restart". A `409 not_errored` is ignored silently. No confirmation (nothing is lost that isn't already lost).
- **Start a new session** (`FilePlus2`, ghost button), when `status = errored` and `errorKind ∈ {resume, resume_unrecoverable}`. Opens the dialog (§3.4).
- **Focus:** both buttons disappear when the status leaves Errored. After a successful Restart, or a confirmed dialog (`onCloseAutoFocus`), focus moves to the composer textarea. On Cancel, focus returns to the Start a new session button (it still exists).
- Below `md`: icon buttons with `aria-label`s and tooltips; the status uses the short label.

### 3.2 Agent strip

S4's strip (slug · template · manager · credential · runtime) gains, after the runtime and only when relevant:

- **Runtime:** "Docker (open-factory-base:dev)" (image from the status frame's `image`, mono), plain "Docker" before any start. Local stays "Unsandboxed: runs directly on this machine". With the local runtime disabled: a `ShieldOff` icon in `--muted-foreground` and "Local runtime disabled on this factory", plus a "Why?" ghost button (`aria-label` "Why is the local runtime disabled?") opening a popover: "An operator has to allow unsandboxed agents by setting `FACTORY_ALLOW_LOCAL_RUNTIME=true`. Until then this agent can't start."
- **Waiting on:** "Waiting on: pnpm test (background, 3m) · 2 crons". Descriptions are plain text (never markdown), truncated to 40 characters with an ellipsis; the visible truncated text is `aria-hidden` and the full text is visually hidden next to it (no `title` duplication). More than two tasks: "pnpm test (background, 3m) and 2 more". "3m" is computed client-side from `startedAt` and refreshed each minute. "1 cron" / "2 crons" (real plurals). Shown only while non-empty.
- **Paused / queued detail:** "Paused: credential `work` is rate-limited until 14:30. Messages wait until then." · fallback: "Paused: credential `work` is rate-limited, retrying at 14:30. Messages wait until then." · "Queued: all 8 slots are in use."
- S4's "Restarts when idle to apply changes" segment stays; its "Why?" button gets `aria-label` "Why does it restart?" and the popover copy becomes: "The agent finishes its current turn and background tasks, then restarts with the new settings. Its session is kept. Its crons from this session stop, and it's told which, so it can recreate them."
- **Live region:** S4's strip wraps its segments in `role="status"`. Waiting on, the paused/queued detail and the per-minute timer go **outside** that region (S3's announcer already reports status changes), so nothing is re-announced every minute.

### 3.3 Timeline

New rows are **quiet one-liners** (S3's `QuietLine`: 13px muted text with a small icon). The default view has no pids, container ids, exit codes or signals; where a detail exists it sits in the row's expandable detail, as S3 does for errors.

| Event | Line |
|---|---|
| `hibernated` | "Hibernated after 70 minutes idle" (minutes from the event's `idleMinutes`) · "Hibernated to free a slot" · "Hibernated to apply changes" · "Hibernated: the server stopped" · "Stopped: the agent was archived" |
| `process_started` (S3 line, refined by wake reason) | "Woke up" · "Resumed after a crash" (`crash_recovery`) · "Restarted" (`restart`) · "Resumed after the server restarted" (`boot` with a notice) · nothing right after a `session_reset` (that row already says it) · "Started a new session" (not resumed, otherwise) |
| `container` | "Container created (open-factory-base:dev)" · "Container re-created: image or mounts changed" · `started`: no line |
| `cleanup` | "Stopped 2 leftover processes" · "Restarted the container to clear leftover processes" |
| `stop_escalated` | "The process didn't stop in time, so it was killed" |
| `background_work_lost` | "Lost when the process stopped: pnpm test (background) · every 5 minutes (cron)" |
| `reconciled` | "Cleaned up after the server restarted" |
| `rate_limit_paused` | "Rate limit reached on credential `work`. Paused until 14:30." · fallback: "…Paused, retrying at 14:30." |
| `rate_limit_reset` | "Rate limit on credential `work` reset" |
| `rate_limited` (S3) | **Renders nothing** from S5 on: `rate_limit_paused` is the one line for that moment and follows the fallback rule. One spelling everywhere: "Rate-limited" as the adjective, "rate limit" as the noun. |
| `control{cmd:"restart"}` | "Restarted by @or" |
| `session_reset` (S3 line) | "New session started by @or. Earlier history stays above; the agent no longer remembers it." |
| `exited` (unexpected) | S3's row, now one quiet line with a crimson icon and ink text: "Stopped unexpectedly". The exit code and stderr tail stay in its expandable detail. No separate crimson `error` row is added for a crash, so one crash is shown in red once. |

### 3.4 Start a new session dialog

The S4 `ConfirmDialog` (shadcn `alert-dialog`), Cancel focused, Esc closes. S4's list of confirmation dialogs (the destructive, irreversible actions) gains this one; `ConfirmDialog`'s code comment ("For destructive deletes only") becomes "For destructive, irreversible actions only".

- **Title:** "Start a new session for @lead?"
- **Body (one sentence on the loss):** "@lead won't remember anything from its current session. The history stays visible here, its files are kept, and waiting messages become its first turn."
- **Detail:** the `lastError` as a muted mono line under the body ("No conversation found with session ID …").
- **Confirm:** "Start new session for @lead" (danger style).

Irreversible from the UI: the old session file stays on disk (spec §9.7), but the UI can't resume it.

### 3.5 Factory messages

`message_in` envelopes from `@factory` (`kind="system"`) render as S3's message block with this sender line: a `Factory` icon (`aria-hidden`) and the visible text "Factory" (Geist 13px ink) as the sender. No Urgent label, never orange. Notices are not announced by the live region (they aren't replies). Queued ones use S3's dashed "Not delivered yet" block.

### 3.6 Composer and queue copy

- Errored with `resume_unrecoverable`: composer enabled (messages queue), hint "Messages wait until a new session is started."
- Rate-limited: queued blocks read "Not delivered yet: rate-limited until 14:30" · fallback "Not delivered yet: rate-limited, retrying at 14:30".
- Queued (cap): "Not delivered yet: waiting for a free slot".

## 4. Agents list

The S4 row grid is unchanged (status slot and short label, name, slug, template, badge). Additions:
- **Inline note after the name** (not a second line, so the 44px rows never change height on live updates): muted 13px text, at most one, in this order of priority: "Local runtime disabled" · "retrying at 14:30" / "until 14:30" (rate-limited) · "Waiting on 2 tasks" · "2 crons". Plain text; no interactive elements in the row link (S4 rule). It truncates with an ellipsis before the name does.
- Badge column: "Docker" or "Unsandboxed" (S4).
- **Running count:** "3 of 8 running" as muted text in the header's meta slot **before** S4's Active/Archived radio pair, live from the `supervisor` frame. Hidden on the Archived view and below `md`.

## 5. Templates and New agent

- The template list and editor show the validator's warning on `runtime: local` while the gate is off ("The local runtime is disabled on this factory.").
- New agent: S4's docker warning ("can't start yet") is removed; a local template with the gate off shows the validator's warning.

## 6. Accessibility

- S3's single visually hidden `role="status"` announcer, for every status change: "Team Lead is working" · "is idle" · "is queued" · "is rate-limited until 14:30" (fallback: "is rate-limited, retrying at 14:30") · "errored" · "hibernated". Recovering from Errored announces the new status the same way.
- Restart and Start a new session are real buttons; focus per §3.1; the dialog traps focus.
- The two strip "Why?" buttons have distinct accessible names (§3.2).
- All new copy is sentence case (PRODUCT.md).

## 7. Components

`apps/web/src/features/session/`: `StatusBadge` (two statuses, long/short labels, the fallback rule, the tooth-only rule), `AgentStrip` (runtime, waiting-on, paused/queued segments outside the live region), `RecoveryActions` (Restart, Start a new session; replaces Compact/Interrupt while errored), `NewSessionDialog` (on `ConfirmDialog`), `TimelineRow` (§3.3 rows; `rate_limited` renders nothing), `MessageBlock` (Factory sender), `formatResetTime` (§2 format). `apps/web/src/routes/_app/agents.index.tsx`: the inline note and the running count. `apps/web/src/styles.css`: the two `--status-hibernated` values. `components/confirm-dialog.tsx`: the comment.

## 8. Fixed strings

"Queued", "Rate-limited", "Rate-limited until 14:30", "Rate-limited, retrying at 14:30", "Queued: all 8 slots are in use.", "Paused: credential `work` is rate-limited until 14:30. Messages wait until then.", "Paused: credential `work` is rate-limited, retrying at 14:30. Messages wait until then.", "Not delivered yet: rate-limited until 14:30", "Not delivered yet: rate-limited, retrying at 14:30", "Not delivered yet: waiting for a free slot", "until 14:30", "retrying at 14:30", "Restart", "Restarting…", "Start a new session", "Start new session for @lead", "Waiting on:", "1 cron", "2 crons", "Waiting on 2 tasks", "Local runtime disabled on this factory", "Local runtime disabled", "3 of 8 running", "Factory", "Messages wait until a new session is started.", "Stopped unexpectedly", and the §3.3 and §3.4 texts.
