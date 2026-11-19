# S5 Supervisor and Docker: UI Design

- **Date:** 2026-11-19
- **Status:** draft, pending the impeccable review against DESIGN.md
- **Spec:** [`docs/superpowers/specs/2026-11-19-s5-supervisor-docker-design.md`](../specs/2026-11-19-s5-supervisor-docker-design.md)
- **Extends:** [S3 session UI](2026-11-18-s3-session-ui-design.md) and [S4 templates, agents and settings UI](2026-11-19-s4-templates-agents-settings-ui-design.md). Everything not mentioned here stays as they define it.
- **Design system:** `DESIGN.md` (Sawtooth): Colors → Semantic (`--status-*`), Shapes → The pitch, Components → Destructive actions, Status Is Never Colour Alone.

## 1. What changes

S5 makes the agent lifecycle visible: two new statuses (Queued, Rate-limited), what keeps an agent awake, why it hibernated, crash recovery, Restart and Start a new session, Factory notices, and the runtime (Docker, Unsandboxed, local runtime disabled). No new pages. Every piece of data comes from the spec's §8.2 status fields and §15 events.

## 2. Statuses

The S3 status slot (a fixed 12×12px slot plus a label) gains two statuses. All six:

| Status | Slot | Label | Token |
|---|---|---|---|
| `working` | the `.of-tooth` | Working | `--status-working` (signal) |
| `idle` | 6px dot | Idle | `--status-idle` |
| `queued` | 6px dot | Queued | `--status-queued` (info) |
| `rate_limited` | 6px dot | Rate-limited until 14:30 | `--status-rate-limited` (warning, ochre) |
| `errored` | 6px dot | Errored | `--status-errored` (crimson) |
| `hibernated` | 6px dot (unchanged from S3) | Hibernated | `--status-hibernated` |

- Every status has its label; colour never stands alone. `working` is the only status with the tooth, so "live" keeps one silhouette, and rate-limited (ochre, hue ~90) never reads as working (orange) even when the dot is too small to judge hue: the shape differs (tooth vs dot) as well as the colour.
- **Rate-limited label:** "Rate-limited until 14:30" (local time, `HH:mm`; tomorrow's date prefixed when not today: "until Thu 09:10"). On the fallback window (`rateLimitExact: false`): "Rate-limited, retrying at 14:30" so it never claims a reset time Claude didn't report. In the dense Agents list the label is "Rate-limited" and the time sits in the row's tooltip-free secondary text (§4).
- **Queued label:** "Queued", and in the session strip "Queued: waiting for a free slot (8 of 8 running)" (the counts come from `GET /api/agents` `running` and the live `supervisor` frame, spec §8.2).
- `document.title` keeps S3's "Status · Name · Open Factory".
- Token check, required in the impeccable review: `working` vs `rate_limited` and `rate_limited` vs `errored` side by side at the 6px dot size in both themes.

## 3. Session view

### 3.1 Header actions

S3's slot after Compact and Interrupt gets the recovery actions. They show only when they apply (no disabled clutter for a healthy agent):

- **Restart** (`RotateCcw`, ghost button), when `status = errored` and `errorKind ≠ resume_unrecoverable`. Click → `POST …/restart`; the button shows "Restarting…" until the status changes. No confirmation: nothing is lost that isn't already lost (forgiveness over confirmation). A failure shows as the next `error` row and the status stays Errored.
- **Start a new session** (`FilePlus2`, ghost button), when `status = errored` and `errorKind ∈ {resume, resume_unrecoverable}`. It opens the confirmation dialog (§3.4). For `resume_unrecoverable` it is the only recovery action; for `resume` it sits after Restart.
- Below `md` both become icon buttons with `aria-label`s and tooltips, like Compact and Interrupt.

### 3.2 Agent strip

S4's strip (slug · template · manager · credential · runtime) gains, in this order after the runtime, only when relevant:

- **Runtime:** "Docker · open-factory-base:dev" (the image name from the last `container` event, mono) replaces S4's plain "Docker". Local stays "Unsandboxed: runs directly on this machine". When the gate is off: a crimson-free, muted warning icon (`ShieldOff`) and "Local runtime disabled on this factory", and the "Why?" ghost button opens a popover: "An operator has to allow unsandboxed agents by setting FACTORY_ALLOW_LOCAL_RUNTIME=true. Until then this agent can't start."
- **Waiting on:** "Waiting on: pnpm test (background, 3m) · 2 scheduled jobs". Task descriptions are text (never markdown), each truncated to 40 characters with an ellipsis; more than two tasks collapse to "pnpm test (background, 3m) and 2 more". "3m" is computed client-side from `startedAt` and refreshed each minute. "N scheduled job(s)" counts live in-session crons (the pin). The segment appears only while the list or the count is non-empty.
- **Queued / rate-limited detail:** "Queued: waiting for a free slot (8 of 8 running)" or "Paused: credential work is rate-limited until 14:30. Messages wait until then." (the fallback wording on an inexact window).
- S4's "Restarts when idle to apply changes" segment stays. Its "Why?" popover copy changes to: "The agent finishes its current turn and background tasks, then restarts with the new settings. Its session is kept. Scheduled jobs it created in this session stop; it's told which, so it can recreate them."

### 3.3 Timeline

New rows, all **quiet one-liners** (S3's `QuietLine`: 13px muted text with a small icon, one line, no pids, container ids or exit signals in the default view):

| Event | Line |
|---|---|
| `hibernated` | "Hibernated after 70 minutes idle" · "Hibernated to free a slot" · "Hibernated to apply changes" · "Hibernated: server stopped" · "Hibernated: archived" |
| `process_started` (S3 line, wording refined) | "Woke up" (resumed) · "Started a new session" (not resumed) |
| `container` | "Container created (open-factory-base:dev)" · "Container re-created: image or mounts changed" · started: no line (it duplicates "Woke up") |
| `cleanup` | "Stopped 2 leftover processes" · "Restarted the container to clear leftover processes" |
| `stop_escalated` | "The process didn't stop in time, so it was killed" |
| `background_work_lost` | "Lost when the process stopped: pnpm test (background) · every 5 minutes (scheduled)" |
| `reconciled` | "Cleaned up after the server restarted" |
| `rate_limit_paused` | "Rate limit reached on credential work. Paused until 14:30." (fallback: "…Paused, retrying at 14:30.") |
| `rate_limit_reset` | "Rate limit on credential work reset" |
| `control{cmd:"restart"}` | "Restarted by @or" |
| `session_reset` (S3 line) | "New session started by @or. Earlier history stays above; the agent no longer remembers it." |

`exited` keeps S3's row; for an unexpected exit it reads "The process exited unexpectedly (code 137)" in crimson with its icon (the one non-quiet lifecycle line, because it explains the Errored status).

### 3.4 Start a new session dialog

The S4 `ConfirmDialog` (shadcn `alert-dialog`), Cancel focused, Esc closes:
- **Title:** "Start a new session for Team Lead?"
- **Body:** "Its current session can't be resumed: <lastError>. A new session starts with no memory of this conversation. The history stays visible here, and pending messages are sent as its first turn."
- **Confirm:** "Start new session" (destructive style per DESIGN.md: it's irreversible for the agent's memory).

### 3.5 Factory messages

`message_in` envelopes with `from="@factory"`, `kind="system"` render as S3's message block with the sender line "Factory" (Geist 13px ink, a `Factory` icon instead of a handle) and no Urgent label. Never orange (a delivered notice is not live). Queued ones use S3's dashed "Not delivered yet" block.

### 3.6 Composer and queue copy

- Errored with `resume_unrecoverable`: the composer stays enabled (messages queue) with the hint "Messages wait until a new session is started."
- Rate-limited: queued blocks read "Not delivered yet: rate-limited until 14:30".
- Queued (cap): "Not delivered yet: waiting for a free slot".

## 4. Agents list

The S4 row grid is unchanged: status slot and label, name, slug, template, badge. Additions:
- The status label is the short form ("Rate-limited", "Queued").
- A muted secondary line under the name, only when relevant and only one of: "Waiting on 2 tasks" · "2 scheduled jobs" · "until 14:30" (rate-limited) · "Local runtime disabled". It's plain text; the details live in the session strip (no interactive elements in the row link, S4 rule).
- The badge column: "Docker" or "Unsandboxed" as in S4.
- The page header's meta slot shows "3 of 8 running" (`running.count` of `running.max`, kept live by the `supervisor` frame), so a queued agent's wait is explainable from the list.

## 5. Templates and New agent

- The template list and editor show the validator's new warning on `runtime: local` when the gate is off ("The local runtime is disabled on this factory.").
- New agent: the S4 docker warning ("can't start yet") is removed; a local template with the gate off shows the same warning as the validator.

## 6. Accessibility

- Status changes keep S3's single visually hidden `role="status"` announcer: "Team Lead is queued", "Team Lead is rate-limited until 14:30", "Team Lead hibernated", "Team Lead errored".
- Restart and Start a new session are real buttons; the dialog traps focus and returns it to the button.
- The "Waiting on" segment is text, readable in order; truncated descriptions carry the full text in a `title` and in visually hidden text.
- All new copy in sentence case (PRODUCT.md).

## 7. Components

`apps/web/src/features/session/`: `StatusBadge` gains the two statuses and the rate-limited label rules; `AgentStrip` gains the runtime, waiting-on and paused segments; `RecoveryActions` (Restart, Start a new session); `NewSessionDialog` (on `ConfirmDialog`); `TimelineRow` gains the §3.3 rows; `MessageBlock` gains the Factory sender. `apps/web/src/routes/_app/agents.index.tsx` gains the secondary line and the running count.

## 8. Fixed strings

"Queued", "Rate-limited", "Rate-limited until 14:30", "Rate-limited, retrying at 14:30", "Queued: waiting for a free slot (8 of 8 running)", "Restart", "Restarting…", "Start a new session", "Start new session", "Waiting on:", "N scheduled job(s)", "Local runtime disabled on this factory", "Hibernated after 70 minutes idle", "Hibernated to free a slot", "Hibernated to apply changes", "Woke up", "Factory", "Messages wait until a new session is started.", and the §3.3 and §3.4 texts.
