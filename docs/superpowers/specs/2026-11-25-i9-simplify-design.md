# I9 Simplify: Technical Design

Task: a v0.0.2 cleanup pass after I1–I8 merged to `main`. Mostly removals and UI fixes, plus one delivery bug and one model change (a human can be a manager). Decisions: ADR 0028 (pre-release, no compatibility). Amends ADR 0004 (reporting line), ADR 0008 (warm/hibernate, the cap), ADR 0024 (skills and plugins: plugins removed), DESIGN.md "Overlays" and "Empty states".

Every decision below was settled with the owner in a grilling session on 2026-11-25 (Q1–Q40; Q13 revised by the owner). The UI decisions were then reviewed through three lenses (impeccable with taste-skill's general rules; Emil Kowalski's design-engineering and Apple design; break-ui), and Q33–Q40 settled what the reviews changed. Nothing here keeps old shapes alive: schema changes ship as the generated migration only; **reset local data** if a migration refuses a non-empty table (the new `reports_to` check will).

## 1. Goal

Make the product smaller and more honest:

1. **Plugins removed** everywhere. They're too early, and their shape across harnesses (Codex, others) is unknown.
2. **No image building.** Open Factory runs images; it never builds them. Runtime, image and permission mode become visible fields in the template form.
3. **A calmer template form**: Permissions and Max live spawns go; MCP servers edit in a dialog.
4. **Factory settings** lose the concurrency cap and move to one JSONB column.
5. **A manager is a specific agent or a specific human.** No agent reports to "the humans".
6. **Model and effort** are visible and overridable where an agent is created and edited, and shown in its details.
7. **Member updates are delivered like messages**, fixing updates stuck "pending" until a human writes.
8. **UI fixes**: Inbox empty line, Slack-style chat messages, adding a credential without a drawer-in-a-drawer.

## 2. Acceptance criteria

1. No route, table, schema, MCP tool field, env var, CLI command, UI surface or doc describes plugins or marketplaces as a feature. The factory has no plugin handling at all: plugin keys a human writes into a template's `settings.json` (`enabledPlugins`, `extraKnownMarketplaces`, …) pass through to Claude Code like any other key, unvalidated, unstripped and unsupported. The Skills area shows skills only.
2. `open-factory images` does not exist; `/api/images*` returns 404; there is no Images tab or Build button. A template's `image:` is any Docker reference, used as-is; with none, `FACTORY_DEFAULT_IMAGE`. An image missing locally is pulled once; a missing image that can't be pulled fails the start with "Image `<ref>` isn't available locally and couldn't be pulled."
3. The template form has a **Runtime** section first: Runtime (Docker | Local), Image, Permission mode (Auto | Bypass). Notes say when each applies: Runtime "Applies to new agents"; Image and Permission mode "Applies at each agent's next start". Image's note names the default ("Empty uses `<FACTORY_DEFAULT_IMAGE>`"; no placeholder). When the factory disallows Local, the Local segment is `aria-disabled` (still focusable) and the field note says "Disabled on this factory: set `FACTORY_ALLOW_LOCAL_RUNTIME` on the server", always visible. Picking Local while Bypass is selected switches Permission mode to Auto with the note "Set to Auto: Bypass needs Docker"; Bypass is then disabled. On Local, Image stays in place, disabled, noted "Not used by Local agents" (nothing below moves). A stored value that has become invalid (hand-written `local` on a factory that refuses it) stays selected with its error note, never silently flipped. Saving writes `template.yaml` keeping comments.
4. The template form has no Permissions section and no Max live spawns. `max_live_spawns` is refused by the template and overlay schemas; `FACTORY_MAX_SPAWNS_PER_HOUR` is not read. An agent with a non-empty `can_spawn` always has the spawn tools and is never refused for a count.
5. "+ Add server" sits on the MCP servers heading line (in agent mode, on the "This agent" label row) and opens a modal dialog (a bottom drawer below `md`); a server's name is a button that opens the same dialog to edit it. Each row keeps its summary line (`npx …`, `mcp.linear.app`) and its issue note; Remove is a sibling button, not nested; template rows in agent mode and raw-only rows aren't editable buttons. At the server limit, Add is `aria-disabled` with its reason beside it. The dialog's primary is "Add server" or "Apply changes"; dismissing it (Esc, scrim, Cancel) never asks and keeps the draft per server for the page's life; on close, focus lands on the added or edited row. "Add secret" inside it expands inline under the value field.
6. Settings → Factory shows Default warm window and Member-update debounce (and the read-only local-runtime line). No concurrency cap anywhere: no "N of M running" (the agents list says "N running"), no "slots in use", no `freed_slot` hibernation, no `max` in the agents response or the `supervisor` frame. Starting an agent never waits for another to hibernate.
7. `factory_settings` is one row with `settings jsonb`; a missing key reads as its default; PATCH validates and merges.
8. Every persistent agent reports to exactly one agent or one human (DB check). New agent defaults the manager to the signed-in human. The Manager picker has two labelled groups: "People" first, with "You (Or Levi · @or)" at the top, then "Agents" in tree order; filtering matches name and handle and ignores a leading `@`; disabled users are left out; Edit leaves out the agent and its descendants. If the users list fails, agents stay pickable. Ephemeral agents still report to their spawner agent.
9. A human manager gets their reports' member updates and errored notices in their own Inbox, grouped per report while unread; other humans don't. Member updates never raise a desktop notification.
10. Disabling a user who manages agents is refused with 409 `manages_agents` listing them.
11. `create_agent` requires `reports_to: "@handle"` (agent or human); `update_agent` accepts it. An unknown or disabled handle is refused.
12. New agent (under More options) and Edit agent (replacing its read-only model line) show Model and Effort side by side from `sm`. Each inherit option names its own value: "Template's (opus)", "Template's (high)", "Template's (Claude Code default)"; before a template is picked they're disabled with "Choose a template first". Saving an override restarts a running agent at its turn end with `--resume` (existing config-change path).
13. Agent details → Runtime shows two rows, `Model` and `Effort`, as stored (alias or id), each marked "(agent)" only when overridden, "Claude Code default" when unset, and "· after this turn" while a restart is pending. Docker agents show `Image`: the running image, plus a muted "Next start: `<ref>`" when the config now resolves to another; long refs middle-truncate with a copy button.
14. A member update reaches its manager agent after the debounce in every state: idle (a turn starts), mid-turn (taken in at the next tool boundary), hibernated (woken), errored (one attempt starts, as a human message does). An idle-written batch taken in by an origin-tagged turn (cron, `/loop`, task notification, subagent hand-back) leaves the agent idle: the next update is delivered, the warm window hibernates it, its status is not "working".
15. At every width, "Nothing in your inbox.", "Couldn't load the inbox." (icon in the dot column), "Couldn't load earlier messages." and the mark-all-read outcome line up with the rows' text (they share the rows' grid).
16. In the Chat view every message group (yours, agents', humans') is left-aligned with a 20px avatar, name and time, the body unboxed. Consecutive messages from the same sender within 5 minutes with nothing between share one speaker line, each message's time shown on hover or focus. Humans have a neutral initials avatar (never an agent hue), used everywhere a human appears. "Sending…" and "Waiting for Ada's current step · Cancel" replace the time in the speaker line and become the time on delivery, with no layout shift; a rejected message gets one error-toned line "Not delivered: <reason>", with no Retry. Urgent, attachments, Also-to and the clamp survive. The raw Session view keeps its cards.
17. "Add credential" in New agent and Edit agent is a disclosure (`aria-expanded`) that expands the add-credential form inline under the Credential field, behind a 1px left rule (no box). Enter submits only the credential; Escape collapses only it (the sheet stays) and returns focus to the trigger; its buttons are secondary, so "Create agent" stays the one primary; "Create agent" while it's open and dirty focuses it with "Add the credential or cancel it first." On success the new credential is selected, focus returns to the Credential field and its note reads "Added <name>." Closing the sheet mid sign-in keeps name and method in the draft (never the token). The same inline pattern serves Add project and Add secret in the sheets and Add secret in the MCP dialog; New template stays the one stacked sheet.

## 3. Delivery

One PR, branch `v002-simplify`, worktree `.worktrees/v002-simplify`, from `origin/main`. Implemented task by task with per-task review and targeted tests (`pnpm test:related` / `pnpm test:fast`); the full `pnpm test` before push.

**UI work** (§4.2, §4.3, §4.6, §4.7, §4.9) is designed and reviewed against: the local `impeccable` skill; Emil Kowalski's skills (`emil-design-eng`, `break-ui`, `apple-design`, from github.com/emilkowalski/skills); and the general rules of taste-skill (github.com/Leonxlnx/taste-skill): one system (one button pair, one card style, at most two boxes deep), buttons as verb + object, no filler copy, 44px targets on mobile, nothing moves on scroll, accessibility. Taste-skill's page plans, photo rules and gate scripts target marketing sites and don't apply. Every UI change is checked in a real browser at 1440, 1024 and 390, light and dark.

## 4. Design

### 4.1 Plugins removed

Delete, don't hide:

- **DB**: the `marketplaces` table (`packages/db/src/schema/library.ts`). `skill_sources` stays.
- **Shared**: marketplace/plugin constants and helpers in `library.ts` (`MARKETPLACE_PATTERN`, `RESERVED_MARKETPLACES`, `OFFICIAL_MARKETPLACES`, `PLUGIN_REF_PATTERN`, `checkPinRef`, `pinOf`, `pinRefFor`, `declarationFor`, `effectivePlugins`, the `/api/library` marketplace and plugin schemas); `PLUGIN_ENV_NAMES`; `AGENT_EDITABLE` plugin paths and policy rule 5 (`agent-policy.ts`); `pluginCount`; `init.plugins` and `plugin_not_loaded` (`events.ts`); plugin change lines; `PLUGIN_SETTINGS_KEYS` and the plugin entries in `RESERVED_SETTINGS_KEYS`; the overlay's `extraKnownMarketplaces` refusal. No handling of any kind remains: not validated, not refused, not stripped (`workspace/settings.ts` stops removing plugin keys), not policed for agents.
- **Server**: `library/marketplaces-service.ts`, `plugins-index.ts`, `plugin-contents.ts`, `plugin-sources.ts`, `plugin-pinnable.ts`, `plugin-settings.ts`, `plugin-usage.ts`, `host-plugins.ts`; the plugin and marketplace routes in `routes/library.ts`; `validatePlugins`; `pluginStart` and its mounts, env (`CLAUDE_CODE_PLUGIN_CACHE_DIR`, `FORCE_AUTOUPDATE_PLUGINS`, `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`), the diagnostic `plugin-settings.json`, `agentPluginsDir`; expected/loaded plugin checks in `start.ts`/`agent-runtime.ts`/`runtimes.ts`; `Effective.library.plugins`; plugins in `get_agent`/`list_library`; `"plugins"` in `FORM_OWNED_KEYS`.
- **Claude version floor**: `assertPluginFloor`, `checkImageClaudeVersion` and `MIN_CLAUDE_VERSION` existed for plugins and go. The base image keeps its pinned version (`images/base/claude-code-version`).
- **Harness**: `--settings` carried only the plugin JSON; `settingsJson` and the flag go. `init.plugins` mapping goes.
- **Web**: `skills.plugins`, `skills.marketplaces` routes; `features/skills` plugin/marketplace files and peeks; `plugins-field.tsx`, `plugin-pin.tsx`, `latest-badge.tsx` (if plugin-only); the "Skills and plugins" heading becomes "Skills"; "plugins: N" on the template field; the `plugin_not_loaded` timeline row; the "(plugin)" command source tag. `DISABLE_AUTOUPDATER` stays if it guards Claude Code itself.
- **Scripts/docs**: `scripts/g1/`; ADR 0024 gets a "Plugins removed (I9)" amendment saying why (unclear across harnesses) and when to revisit (a second harness). Product docs that describe plugins are updated.

### 4.2 Runtime, image, permission mode in the template form

- `resolveImage(templateImage, defaultImage)` becomes `templateImage ?? defaultImage`. `USER_IMAGE_NAME` stops meaning "build me": a bare name is a local Docker tag.
- Delete `apps/server/src/images/builder.ts`, `context.ts`, the user-image statuses in `status.ts`, `routes/images.ts`, `apps/cli/src/commands/images.ts`, the Images tab (`templates.images.tsx`, `images-section.tsx`, `image-status.tsx`, `build-log.tsx`) and the template editor's image line with Build. Validation no longer errors on "user image not built".
- Pull policy: present locally → use it; else pull (the Supervisor's existing `pulling` step); pull failure → start error (§2.2).
- Form: new `runtime-section.tsx` first in `config-form.tsx`, template mode only. Fields map to `template.runtime`, `template.image`, `template.permission_mode`; add them to `FORM_OWNED_KEYS`. Rules from §2.3 run client-side and in `validate.ts` (bypass + local is already an error). `SegmentedControl` gains a per-option `aria-disabled` (focusable, described by the field note). The Local reason reuses the wording of Agent details' "disabled on this factory" line; `FACTORY_ALLOW_LOCAL_RUNTIME` is mono and may wrap anywhere at 390px.
- `agents.runtime` stays fixed at creation (owner: moving an agent out of its sandbox must not be a side effect of editing a template). The image re-resolves every start, as today. No per-agent image override.
- The agent DTO carries `image: { running: string | null; next: string }`: `running` is the image of the live process (null when not running), `next` the reference the effective config resolves to now. The "Docker" fallback label goes; pulling stays visible through status.

### 4.3 Template form: fewer sections, MCP dialog

- Delete `permissions-section.tsx` and its field map entries. `settings.json` `permissions.*` and `autoMode.*` keep passing through untouched (Raw tab); the factory's additions (inherited deny rules, `SendMessage`/`ListAgents` deny, factory trust notes, `defaultMode` from permission mode) stay.
- `max_live_spawns` leaves `templateYamlSchema`, `overlayTemplateSchema`, config merge, the form, `may-spawn.ts` (spawn tools when `canSpawn` is non-empty), `spawn-service.ts` (both counts), `config.ts` (`maxSpawnsPerHour`, `FACTORY_MAX_SPAWNS_PER_HOUR`) and the CLAUDE.md limits line.
- New `components/ui/dialog.tsx`, built on `ConfirmDialog`'s pattern: `useLatchedMobile(open)` picks dialog or Vaul drawer once per opening; `useStampedRef`/`data-instant` when opened from the keyboard. Anchored at a fixed top (~12svh, transform-origin top centre) so it never jumps as fields come and go; enters from 96% over 150ms (scale `motion-safe` only), leaves with a 100ms fade; max height with a scrolling body and fixed footer (ghost Cancel, then primary; on the drawer, full-width stacked, action first). Focus on open: Name for a new server, the first invalid field (else Name) for an edit; `onCloseAutoFocus` lands on the row, which gets the arrival tint. Width ~560–640px; env/header pairs lay out by container width.
- The MCP editor is inline today (`mcp-editor.tsx`); its content moves into the dialog, and add and edit share it. Each env/header value's Insert secret → Add secret expands inline instead of `openSheetForResult`. Remove the page's "an editor is open, refuse Save" plumbing (`onEditorOpenChange`); a modal makes it unreachable. Drop the duplicate "MCP servers" `FieldShell` legend under the section title.
- DESIGN.md "Overlays": add "A form opened from a page for one item (an MCP server) | Dialog" beside the destructive-confirmation row. Create flows stay sheets. A short prerequisite created from inside a sheet or dialog (credential, project, secret) expands inline (§4.9); New template, a large form, is the one stacked sheet that remains.

### 4.4 Factory settings

- Migration: drop `max_running_agents`, `default_warm_window_minutes`, `member_update_debounce_seconds`; add `settings jsonb not null default '{}'`. `updated_at`, `updated_by` and the singleton check stay.
- `packages/shared/src/settings.ts`: `factorySettingsValuesSchema` (`warmWindowMinutes` 1–1440 default 70, `memberUpdateDebounceSeconds` 0–86400 default 30), parsed on read so defaults fill missing keys; PATCH (strict, partial) merges into the stored object. `FACTORY_BOUNDS` loses the cap.
- `FactorySettings` drops `maxRunningAgents()`; `onChange` no longer calls `capChanged`.
- Supervisor: remove the cap check in `requestWake`/`pump`, `evict`/`pickVictim`/`askToHibernate`, `capChanged`, `max` in `publish()`; keep pulls, credential rate-limit pauses, the closing latch and single-start bookkeeping. `DEFAULT_MAX_RUNNING_AGENTS` and the `freed_slot` reason go. `running:{count,max}` → `running:{count}`; `ws.ts` supervisor frame loses `max`.
- Web: the cap field, "N of M running" and "Queued: all N slots are in use." go. The running count lives only on the agents list ("N running", hidden at 0). Debounce shows a "seconds" suffix and the note "0 delivers each update at once" with its range.
- ADR 0008 amended: no cap; idle agents hibernate only by warm window.

### 4.5 A manager is an agent or a human

- Schema (`agents`): `reports_to` (agent FK) stays; add `reports_to_user` (FK `users.id`, `onDelete: restrict`). Checks: ephemeral → `reports_to` set and `reports_to_user` null (replaces `agents_ephemeral_manager`); persistent → exactly one set.
- Shared DTO: `reportsTo: { kind: "agent" | "user"; handle: string }` (never null). Create/update bodies take `reportsTo: "@handle"`; the server resolves it through `handles` to an agent or an enabled user.
- Web: the Manager combobox per §2.8 (groups with `role="group"`; humans with the human avatar of §4.9; the name truncates first, the handle middle-truncates). No "No manager" option; New agent preselects the signed-in human. `renderMissingManager` covers a disabled human too. "left: now reports to the humans" and similar copy name the human. The combobox filter strips a leading `@`.
- Router (`messaging/router.ts` `forward`): manager agent → member update as today (§4.8); manager human → a `member_update` inbox item for that user only; `errored` goes to the direct manager only (agent or human), never to all humans. The Inbox groups unread member updates per report into one row ("3 updates from @ada"). Member updates never notify (I8 rule stands).
- Peers (`peer_joined`/`peer_left`): agents with the same manager, agent or human.
- `claude-md.ts`: "You report to @or (a human). Send them updates with `send_message`." replaces "No manager: you report directly to the humans."
- Users: disabling a user with any non-terminated agent reporting to them → 409 `manages_agents` with the agent handles; the UI lists them.
- MCP (`org-tools.ts`): `create_agent` requires `reports_to`; `update_agent` accepts it; refusal for unknown/disabled handles and for an ephemeral target.
- Docs: `concepts/reporting-line.md`, ADR 0004 amendment, `behavior/inbox.md`, `concepts/user.md` (also drop its stale `@humans`).

### 4.6 Model and effort

- New agent and Edit agent sheets gain `ModelField` and `EffortField` (they exist for the Configuration page and write `agents.config.template.model`/`effort`). They read `useConfigScope`/`useScalar`/`useFieldNote`, which the sheets don't provide: add a small adapter scope. Inherit is the default, copy per §2.12; the Configuration page uses the same phrasing. Changing the template keeps an override and updates the inherit label. Edit agent's Save does two writes (PATCH + config); if one fails, the outcome says which part was saved. The existing config-change path restarts a running agent at its turn end with `--resume`; nothing new on the server for that.
- Agent DTO gains `model: { value: string | null; source: "agent" | "template" | null }` and the same for `effort`, from the config resolver; `restartPending` already exists.
- Agent details → Runtime: `Model` and `Effort` rows (§2.13); `Image` row for Docker agents (§4.2), middle-truncated mono with a copy button.

### 4.7 Inbox empty line

Row text starts after `px-2`, the 0.75rem dot column and `gap-x-2` (`inbox-row.tsx:178`), 28px in. Render the empty line, `ErrorLine` (icon `size-3.5` in the dot column), "Couldn't load earlier messages." and the mark-all-read outcome on the same `grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 px-2` grid through one shared constant, at every width. Still one muted line (DESIGN.md).

### 4.8 Member updates delivered like messages (bug fix)

Root cause (read from code, not reproduced): member updates use a separate "held" lane written only when `!turnOpen() && heldDue()`. `turnOpen()` includes `awaiting`, which only a `turn_end` without `originKind` clears. When Claude takes an idle-written batch into a self-started turn (cron, `/loop`, task notification, subagent hand-back), `awaiting` sticks: no held timer arms, the agent reads "working", never hibernates, and only a human message (an ordinary queue item whose plain turn clears `awaiting`) releases the updates.

Fix:

1. **One lane.** Remove the held lane (`held`, `heldDue`, `heldDueAt`, `heldFiredFor`, `updateHeldTimer`, `heldActionable`, `dueAtTurnEnd`, the held branch of `flush`, `receiveHeld`/`deliverHeld`). The debounce is a per-manager timer from the oldest pending update; when it fires, every pending update for that manager enters the ordinary `queue` as one batch and goes through `deliver` (wake inline, written mid-turn at the next tool boundary, errored → one attempt). `member_updates` joins the wakes an errored agent accepts. Boot reconcile re-arms the timer from pending rows.
2. **`peer_joined`/`peer_left`** become passive notices that ride along with the next batch (as `config_changed` does).
3. **`awaiting` can't stick.** A batch taken in by any turn, with or without an origin, is settled at that turn's end. This also unblocks raw input, compact and hibernation, which share the barrier.
4. Queue UI: the "waiting for this turn to end" and "held until restarted" held lines go; queued updates show as queued items like messages.

Regression tests (fake Claude, real Postgres), each failing without the fix:
- an idle manager starts a turn with the update after the debounce;
- an idle-written batch taken in by an origin-tagged turn: the next update is delivered and the agent hibernates after the warm window;
- a mid-turn manager receives the update before its turn ends;
- a hibernated manager is woken; an errored manager starts one attempt.

`claude-md.ts` text "batched at your turn boundaries" becomes "batched every N seconds; they may arrive mid-turn".

### 4.9 UI fixes

- **Human avatar** (`speaker-line.tsx` `Speaker`, and everywhere a human appears): 20px initials on neutral steel, never an agent hue. Initials by grapheme (`Intl.Segmenter`), first and last word, skipping suffixes (Jr, III); a person glyph when no letters. DESIGN.md "humans have no avatar" is replaced.
- **Chat** (`features/chat/chat-row.tsx`): human messages render like agent messages (`SpeakerLine`, unboxed `Markdown`, `ROW_GUTTER` with the ⋯ menu in the gutter, a `steel-hover` row fill on fine pointers so the ⋯ belongs to its row). Grouping per §2.16 (4px between bodies in a group; hover/focus time in the leading edge). Status in the speaker line's time slot (`SpeakerLine` already supports `status`); the swap uses the note-swap fade (150 in / 100 out, opacity only). Rejected: one error-toned line (icon + text, not colour alone), no Retry. Status text is tied to the message with `aria-describedby` and announced in the chat's polite region. Keep urgent, attachments (chips, the 1 MB preview rule), Also-to, the 40-line/4,000-char clamp, the muted body while sending. The deep-link tint moves from the card to the row. `MessageBlock` keeps its card for the Session timeline and queue.
- **Inline prerequisites**: `FormFrame` gains an `"embedded"` frame: a `<div role="group" aria-label>` (never a nested `<form>`), Enter handled on its own fields with `stopPropagation`, outline submit + ghost Cancel, behind a 1px left rule. `SheetContent`'s `onEscapeKeyDown` (and the Vaul drawer's) prevents the close and collapses the expansion when focus is inside it; Esc does nothing while a code exchange is in flight. On open, scroll the whole expansion into view (`block: "nearest"`) and focus Name. On success, write the new item into its query cache in the same `flushSync` as selecting it (as the template flow does), then focus the field. Applies to Add credential, Add project, Add secret (New/Edit agent) and Add secret (MCP dialog). `openChildSheet` remains only for New template. First-run step 1 keeps its top-level Add credential sheet.
- DESIGN.md: chat messages are unboxed for everyone and grouped; humans have an initials avatar; short prerequisites expand inline; Live rows: a pending message's status lives in its time slot.

## 5. Docs to update

ADR 0004, 0008, 0024 (amendments); DESIGN.md (Overlays, Empty states, chat); product docs: `concepts/reporting-line.md`, `concepts/user.md`, `concepts/agent-template.md`, `behavior/inbox.md`, `architecture/{workspace,permissions,factory-mcp,data-model}.md`; roadmap `v0.0.2/index.md` gets an I9 line.

## 6. Out of scope

Live model switching (Claude Code's stream-json control messages are undocumented; restart-and-resume gives the same result). Per-agent image override. Changing an existing agent's runtime. Any other harness.
