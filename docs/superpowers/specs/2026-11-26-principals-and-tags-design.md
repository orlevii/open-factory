# Principals and Tags: Technical Design

Task: make handles changeable, display-only labels, the way Slack does. Every agent and human becomes a **principal** with a stable id. Text stores **tags** (`<@ref>`) instead of handles, and every reader renders the principal's current handle. In the chat composer, `@` only tags; it no longer adds a recipient. Decisions: ADR 0028 (pre-release, no compatibility). Replaces the namespace parts of ADR 0021 (handles and recipients); the new decision is ADR 0029.

Every decision below was settled with the owner in a brainstorming session on 2026-11-26. Nothing here keeps old shapes alive. Schema changes ship as the generated migration only, so **reset local data**.

## 1. Goal

1. **A rename changes one row.** An agent's or human's handle can change at any time. Every message, comment, description, envelope and chip already written shows the new handle, and nothing is rewritten.
2. **Freed handles can be reused.** After `@dev` becomes `@builder`, someone else can be `@dev`. Old text still points at `@builder`, because it stores the principal, not the name.
3. **`@` tags; it doesn't send.** Writing to `@ceo-agent` "I've informed @cmo-agent on the marketing campaign" reaches only `@ceo-agent`. Recipients are added with their own control.
4. **One identity table** for agents and humans. Every agent-or-human column pair collapses into one principal reference.

## 2. Acceptance criteria

1. A `principals` table holds every agent and human: `id` (UUID), `kind` (`agent` | `human`), `handle` (unique), `ref` (unique). `agents.id` and `users.id` are foreign keys to `principals.id`. The `handles` table, `agents.slug` and `users.handle` don't exist.
2. User ids are UUIDs (better-auth `generateId`).
3. A principal's `ref` is 8 chars of lowercase Crockford base32 (`0-9a-hjkmnp-tv-z`), derived from its UUID's random bytes and stored on `principals`. Two principals never share a ref or a handle; the database enforces both.
4. Each agent-or-human column pair is one principal FK (§4.1 lists them). `agents.terminated_by` is a principal FK; null means the factory (idle timeout).
5. Text fields that can hold tags (message bodies and parts, task titles, task bodies, task comments, schedule bodies, agent descriptions) store tags only as `<@ref>`. No stored text holds a `<@ref|label>`.
6. A human renames any agent (Edit agent sheet) and edits their own display name and handle (Edit profile sheet, from the sidebar user menu). A taken handle gets a 409 field error, and a reserved or malformed one gets a 400 field error. A rename emits `principal_updated` on the app's live stream, every chip on screen shows the new handle without a refetch, and a toast "@dev is now @builder" offers Undo.
7. In every tag-holding web composer (chat, task comment, task title, task body, agent description, schedule body), `@` opens the "Tag someone" picker of live principals. Picking inserts `@handle` as an atomic tag that is serialised to `<@ref>` on submit. A tag has a visible fill in the box. It never adds a recipient. Typed `@name` that wasn't picked stays plain text. The session composer stays raw, with no `@`.
8. The chat composer adds recipients only with its **Add recipient** toolbar control: live agents, not the chat's agent or ones already added, at most 10 in all.
9. Agents read every principal as `<@ref|handle>`, with the current handle: in envelope attributes (`from`, `to`, `re_from`, `by`, `about`), bodies, quoted reports, the `AGENTS.md` org block, `list_peers` (a `tag` field per entry) and every tool result that names a principal.
10. Every MCP tool argument that names a principal accepts `<@ref|…>`, `<@ref>` or a bare ref, and also a plain handle, with a warning.
11. An agent's factory-tool write with a tag whose ref matches nobody is refused, and nothing is written: `<@k7x2m9qd> isn't anyone in this factory; list_peers shows each agent and human with their tag.` A plain `@name` matching a current handle is stored as a tag, and the tool result says `Plain tag detected: @cmo-agent was resolved to <@k7x2m9qd|cmo-agent>. Tag as <@ref|handle>.` A plain `@name` matching nobody stays text, with no warning.
12. A human's REST write with an unknown ref gets a 400 field error, and nothing is written. Plain `@name` from a human is never resolved.
13. A tag in a message, schedule body or description notifies nobody. A tag in a task comment reaches the tagged principal, as mentions do today (cap 50).
14. An agent's workdir is `~/open-factory/agents/<ref>/` and its container is `open-factory-<ref>`. A renamed agent keeps its workdir and resumes its Claude session.
15. REST routes address agents by ref (`/api/agents/:ref/…`), and the web routes do too (`/agents/:ref`). The Auto avatar colour is seeded from the id, so a rename keeps the colour.

## 3. Delivery

One PR, branch `principals-and-tags`, worktree `.worktrees/principals-and-tags`, from `origin/main`. It touches most of the server, so the plan orders the work bottom-up (schema → shared `tags` → server write paths → agent rendering → REST → web), with each layer's targeted tests green before the next. The work is implemented task by task, with per-task review and targeted tests (`pnpm test:related` / `pnpm test:fast`), and the full `pnpm test` runs before push.

**UI work** (§4.5) is designed and reviewed against the local `impeccable` skill and Emil Kowalski's skills. The owner verifies the UI in a browser after implementation.

## 4. Design

### 4.1 Data model

```
principals(
  id          text primary key        -- UUID, shared with agents.id / users.id
  kind        text not null           -- 'agent' | 'human' (check)
  handle      text not null unique    -- current handle; mutable
  ref         text not null unique    -- 8-char Crockford base32 (§4.2)
  created_at  timestamptz not null default now()
)
```

- `agents.id` and `users.id` reference `principals.id`. A principal row is inserted in the same transaction as its subtype row. On a `ref` unique violation, the creator draws a new UUID and retries, up to 5 times, then fails with a 500.
- **Users:** better-auth's adapter runs without transactions, and today's handle claim runs in request middleware outside the user insert. So sign-up (`handleSignUp`, already under `signUpMutex`) validates the handle, creates the principal itself, and then runs better-auth. Its `advanced.database.generateId` hands the user the principal's id, and the principal is deleted if sign-up fails. The handle is no longer a better-auth field: `users.handle` is dropped, `getUser` reads the handle and ref from `principals`, and the web reads the signed-in user from `GET /api/me`.
- **Handles:** one schema for agents and humans, `handleSchema`: lowercase letters, digits and dashes, starting and ending with a letter or digit, 2–40 chars, with today's reserved words plus `unknown`, which is how a dangling tag renders (`humans`, `me`, `scheduler`, `factory`, `all`, `system`, `unknown`). `slugSchema` is deleted. Sign-up's handle input allows 40 characters. Every principal keeps its handle, terminated and archived agents included, until it's renamed. A rename frees the old handle at once. The unique index decides every race; there's no app-side pre-check beyond giving a better error.
- **Names** stay on the subtype tables: `agents.display_name`, and better-auth's `users.name`.

**Collapsed pairs.** Each becomes one column referencing `principals.id`:

| Table | Today | Becomes |
|---|---|---|
| `agents` | `reports_to` + `reports_to_user` | `reports_to` (exactly one manager stays a not-null rule for persistent agents) |
| `agents` | `terminated_by` (text) | `terminated_by` (null = factory) |
| messages | `from_user_id` + `from_agent_id` | `from_id` (null = factory) |
| message recipients | `to_agent_id` + `to_user_id` | `to_id` |
| message / chat authors | `author_agent_id` + `author_user_id` | `author_id` |
| `tasks` | `created_by_agent_id` + `created_by_user_id` | `created_by_id` |
| task comments | `author_agent_id` + `author_user_id` | `author_id` |
| task events | `actor_agent_id` + `actor_user_id` | `actor_id` |
| `schedules` | `created_by_agent_id` + `created_by_user_id` | `created_by_id` |
| `schedules` | `body_author_agent_id` + `body_author_user_id` | `body_author_id` |

The plan confirms the exact tables by reading `packages/db/src/schema/`, and any other pair found there collapses the same way. Columns that can only hold an agent (`tasks.assignee_agent_id`, `schedules.target_agent_id`, `subject_agent_id`, `agent_id` foreign keys) keep their FK to `agents`. Code that branches on "agent or user column" reads one column and the principal's `kind`.

**Other stored principal references** move to ids or tags too:
- `messages.recipients` (a text[] of `@handle`) → `recipient_ids` (principal ids)
- `messages.re[].from` holds `<@ref>`, or the reserved `@scheduler` / `@factory`
- `skill_sources.added_by` (text) → `added_by_id` → principals
- session-event payloads that name who did something (`spawned`, control events) hold `<@ref>`

### 4.2 Refs

- `ref = crockfordBase32(uuidBytes.slice(-5))`, which is 40 bits and exactly 8 chars. The tail bytes are random for a v4 UUID. The function lives in `packages/shared/src/ref.ts`.
- Alphabet `0123456789abcdefghjkmnpqrstvwxyz` (Crockford, lowercase).
- **Input normalisation** (`normaliseRef`): lowercase; `i` and `l` → `1`; `o` → `0`. Every lookup by ref goes through it, so a near-miss copy still resolves. A string that isn't 8 chars of the alphabet after normalising isn't a ref.

### 4.3 Tags: format and the shared module

**Format.**

- Stored: `<@k7x2m9qd>`. Shown to agents: `<@k7x2m9qd|cmo-agent>`.
- Accepted on write: `<@ref>` or `<@ref|anything>`. The label is ignored and stripped.
- Not parsed and not rendered inside inline code or code blocks.
- An escaped `\<@…>` or `\@name` is left alone.
- `<@…>` is neither an HTML tag nor an autolink in CommonMark, so it reaches the markdown tree as text.

**`packages/shared/src/tags.ts`** replaces `mentions.ts` (`extractMentions`). It keeps its micromark+GFM walk over source slices.

- `scanTags(text)` → the tokens (ref, source span) and the plain `@name` candidates (name, span) found outside code, with today's boundary rules. Pure.
- `applyTags(text, scan, lookup, { resolvePlain })` → `{ text, refs, warnings, unknownRefs }`. It rewrites every token to `<@ref>`. With `resolvePlain`, a plain `@name` that exactly matches a current handle (case-insensitive) becomes `<@ref>` and adds a warning. `lookup` is the result of one batched query the caller makes between scan and apply (refs → principals, names → principals).
- `renderTags(text, lookup, style)`:
  - `"agent"` → `<@ref|handle>`
  - `"plain"` → `@handle`
  - An unknown ref renders as `<@ref|unknown>` / `@unknown` and doesn't throw. Principals are never deleted, so this is defensive only.

A server helper, `principals.resolveText(db, text, { writer })`, wraps scan → one query → apply. Every write of a tag-holding field goes through it.

| Writer | Unknown ref in a tag | Plain `@name` matching a handle |
|---|---|---|
| Agent (MCP tools) | Refused as a whole; nothing written; error per §2.11 | Stored as a tag; warning in the tool result |
| Human (REST) | 400 field error; nothing written | Left as text |

**What a tag does.** In messages, schedules and descriptions it only renders. In a task comment, `refs` drive who is reached (replacing the names from `extractMentions`), with today's cap of 50 and today's `notReached` reporting.

### 4.4 Agents and the server

**Envelopes** (`packages/harness/src/envelope.ts`) write principals as tags in attributes, unescaped: `from="<@k7x2m9qd|ceo-agent>"`, `to="<@…|a> <@…|b>"`, `re_from`, `by`, `about`. A tag only contains `[0-9a-z@|<>-]` from validated refs and handles, so it can't open a `factory-message` tag. `@factory` and `@scheduler` stay reserved words, not principals. `from_kind` stays. Bodies are rendered with `renderTags(…, "agent")` at delivery, so every new delivery carries current handles.

**Rendered for agents with `"agent"` style:**

- envelope bodies and quoted reports
- the `AGENTS.md` org block (manager, peers, reports)
- `list_peers`, which adds a `tag` per entry next to handle, name, kind and relation
- task, comment and schedule reads
- `terminated_by` and `description_by` in tool results
- spawn results

**Text the factory writes** names principals by tag, so it never goes stale: peer joined/left bodies, forwarded facts, restart notices, the loop-guard notice and task message bodies store `<@ref>` (`@factory` and `@scheduler` stay words). Code that reads such a body back parses its tags.

**Sanitising.** `inline()` (which strips `<` and `>` from descriptions and titles) and the envelope's `attr()` keep only the two exact tag shapes, `<@ref>` and `<@ref|handle>`, defined once in `tags.ts`. Everything else is stripped or escaped as today.

**Principal arguments.** `send_message.to`, `terminate_agent`, `restart_agent`, `update_agent` (its target), `send_command`, task assignee and schedule target each accept a tag, a bare ref or a plain handle. One resolver handles all of them. A plain handle adds the §2.11 warning to the result, and an unknown ref is refused. `spawn_agent` takes the new agent's handle and returns its tag. `update_agent` gets no handle argument; only humans rename.

**Instructions** (`apps/server/src/workspace/claude-md.ts`). A short section replaces the current mention lines:

- Tag agents and people as `<@ref|handle>` in factory tools (messages, tasks, schedules, descriptions).
- `list_peers` shows each one's tag.
- The ref is what counts; a label can be out of date.
- Tags only work in factory tools. In anything that leaves the factory (PRs, commits, files, GitHub, other MCP servers), write plain names.

**Renames and agents.** There is no rename event to agents. Refs in old context still resolve, every new delivery carries current labels, and the org block is current from the next start. A stale *plain* `@old` resolves to whoever holds `old` now, and the warning shows the agent exactly who that is.

**Durable keys off the handle:**

- workdir `~/open-factory/agents/<ref>/`, so Claude's cwd-derived session path survives a rename
- containers `open-factory-<ref>` (today `open-factory-<slug>-<id8>`)
- the agent's git identity: name = its handle at start, email = `<ref>@open-factory.local`
- per-agent event channels keyed by agent id; WebSocket messages name the agent by ref
- REST `/api/agents/:ref/…` (lookup through `normaliseRef` and the `ref` index)
- message and recipient REST bodies take refs
- the avatar seed is the id
- the loop guard stays id-based

**Rename endpoints:**

- `PATCH /api/agents/:ref` with `{ handle }`
- the existing user update (`name`, `handle`), with the handle written to `principals.handle`

Both emit `principal_updated { id, ref, kind, handle, name, state }`. Create, a name change, archive, unarchive, terminate and disable also emit it, so a newly spawned agent's tags resolve without a reload.

### 4.5 Web

UI work follows DESIGN.md, the `impeccable` skill and Emil Kowalski's skills (emil-design-eng, break-ui, apple-design). The owner reviewed this section's UX on 2026-11-26.

**Principals cache.**

- `GET /api/principals` returns every principal: `{ id, ref, kind, handle, name, state }` plus avatar fields, where `state` is `live` | `archived` | `terminated` | `disabled`. It is cached once, and `principal_updated` patches the cache.
- **Handles in other responses** (agent lists, chat entries, task and schedule creators, inbox rows) stay as fields. `principal_updated` arrives over the app's existing WebSocket (`/api/ws`). Its handler patches the principals cache and invalidates one listed set of queries that show handles (`HANDLE_QUERY_KEYS`, kept next to the handler). Queries on screen refetch once; the rest refetch when next used. The same set is invalidated when the WebSocket reconnects, so a missed frame is never stale. No polling, no stale-time timer.
- A ref missing from the loaded cache triggers one batched refetch (`GET /api/principals?refs=…`, coalesced per frame).
- Until the cache has loaded and the refetch has answered, a chip renders `@…` with a steel plate in the avatar slot, at its final size and with no shimmer. It shows `@unknown` only when the server confirms no principal has that ref.

**Tag chip** (a remark plugin in the shared `Markdown` component turns `<@ref>` and `<@ref|label>` text nodes into `Tag`; the label is ignored):

- **Look:** inline, Geist medium (not mono), `steel-deep` fill (night: `night-selected`), 4px radius, 1px horizontal padding. Never Signal orange.
- **Avatar:** `min(1em, 16px)`, kept on one line with the `@` and the handle's first segment (`nowrap`). A long handle may break at its hyphens.
- **Agent chip:** a link to the agent's **Chat** (`/agents/:ref/chat`), the same target as `AgentChip` and the sidebar.
- **Human chip:** not a link, not focusable, no hover fill.
- **Hover:** only under `(hover: hover) and (pointer: fine)`. `steel-hover` fill, 150ms, colour only. No underline.
- **Focus:** the standard 2px Signal ring.
- **Tooltip** on hover and focus:
  - "Ada Lovelace · Agent" or "Sam Lee · Person"
  - when ended: "Ada Lovelace · Terminated", "· Archived" or "· Disabled"
  - DESIGN.md timing: 400ms the first time, then neighbours open instantly within the 300ms skip window.
- **Accessible name:** the visible `@handle` first, then sr-only `, Ada Lovelace` and, when not live, `, terminated` / `, archived` / `, disabled`. The avatar is `aria-hidden`.
- **Ended principals:** `ink-muted` text and the avatar at 50% opacity; the state is also in the tooltip and the sr-only text, never colour alone.
- **Unknown ref:** a muted, non-interactive chip with no avatar, reading "@unknown"; its tooltip and sr-only text say "No one in this factory has this tag".
- **Inside a link, button or heading link:** `Tag interactive={false}`, which keeps the look but has no link and no focus. There are never links inside links.
- **A rename:** the text swaps instantly, with no transition and no highlight.
- **Mono tool input and output rows** stay raw text, never chips. A separate `Markdown` switch (`tags={false}`) does this; `untrusted` doesn't (the schedule sheet renders its body `untrusted` and shows chips).

**Plain-text surfaces** (task-list rows, inbox previews, notifications, the document `<title>`, the agent description line in sheet headers) use `renderTags(…, "plain")` with the cache, and re-render on `principal_updated`.

**Composer.** It stays a textarea, with atomic tag ranges `{ start, end, ref }`. The surfaces are the chat, task comment, task title (single line `Input`), task body, agent description (a plain `Textarea`) and schedule body. One hook (`useTagField`) owns the range behaviour below; the composer and every other field use it. The **session composer stays raw**, with no `@`, as DESIGN.md has it.

- **Picking:** picking from the `@` menu replaces the typed `@query` with `@handle ` and records a range. Edits before a range shift it. A rename while a tag sits in an open composer leaves the typed text as is; the range keeps its ref.
- **Highlighter:** a mirror layer behind the textarea paints each range with the chip's fill. It reuses `caret-menu.tsx`'s mirror properties, with the same font, padding and wrap, kept in sync with the textarea's scroll. The textarea's own text stays on top, so the caret, IME, spellcheck and native selection are untouched. Untagged `@text` has no fill.
- **Caret:** a collapsed caret never rests inside a range. After a click it moves to the nearer edge. After ← or → it moves to the far edge in the direction of travel.
- **Selections:** an edge that falls inside a range snaps outward, so selections hold whole tags.
- **Deleting:** Backspace at a tag's end, or Delete at its start, removes the whole tag and its trailing space. A range drops only when an IME composition started inside it, and the text then stays plain; the highlighter shows it.
- **Undo:** the hook owns undo. It keeps a stack of `{ text, ranges, selection }` snapshots (typing coalesced into one step per word or 500ms pause; a pick or a whole-tag delete is its own step). On `beforeinput` `historyUndo` / `historyRedo`, and on ⌘Z / ⌘⇧Z / Ctrl+Y, it prevents the browser default and restores a snapshot. No `execCommand`.
  - ⌘Z right after a pick brings back `@query` with the menu closed.
  - ⌘Z after a whole-tag delete brings the tag back, still atomic.
  - ⌘⇧Z and Ctrl+Y redo.
- **Copy and paste:**
  - Copying or cutting from a composer, or copying from a `Markdown` container holding chips, writes `text/plain` as `@handle` and `text/html` with `<span data-of-tag="<ref>">@handle</span>`.
  - A composer paste turns `data-of-tag` spans into ranges. A raw `<@ref>` or `<@ref|label>` in pasted plain text also becomes a range.
  - Paste never opens a menu.
- **Submit and drafts:** submit serialises ranges to `<@ref>`. Drafts store the serialised text. Loading a draft, or editing existing text (a task title or body, an agent description), hydrates tokens back into `@handle` ranges.
- **MarkdownEditor fields** (task body, schedule body) have no `@` toolbar button; the menu opens by typing. Their Preview tab serialises the ranges and renders chips.

**The `@` menu now that it only tags.**

- **Labels:** the toolbar `@` button and the listbox are both labelled **"Tag someone"**. Items stay as they are: name as the label, `@handle` as the detail, and the avatar.
- **Candidates:** live principals only, ranked as today (`rankMentions`), and items carry the ref. Ended principals are never offered; their tags only appear in older text.
- **Menu note per surface, stating the consequence:**
  - Chat: **"A tag doesn't send · Esc keeps it as text"**
  - Task comment: **"A tag notifies them · Esc keeps it as text"**
  - Task title, task body, description, schedule body: **"Esc keeps it as text"**
- **Esc** is unchanged: it closes the menu, the `@query` stays plain text, and typing on doesn't reopen it.
- **No match:** the menu closes, as today. The lack of a highlighter fill says it isn't a tag.

**Chat recipients.** `recipient-source.ts`, `AT_LABEL` and `MENU_NOTE` are deleted, and the chat composer uses the shared mention source.

- **Placement:**
  - On fine pointers, a ghost toolbar button **"Add recipient"** sits left of `@`, with the `UserPlus` icon and its label.
  - Below `md` it is a 40px icon with `aria-label="Add recipient"`. The mobile toolbar order is add recipient, `@`, attach.
  - Once the "To:" row shows, a ghost **Add** also sits at the end of its chips.
- **Picker:** the Multi-pick Combobox pattern.
  - Live agents only, leaving out the chat's agent and ones already added.
  - It stays open after each pick, and a picked row is marked "Added".
  - Each addition is announced through the existing "Also sending to @x" live region.
  - Footer: **"Only live agents get messages · Up to 10 per message"**.
- **When it's held** (still focusable, `aria-disabled`, with the reason in the note slot when pressed):
  - at 10 recipients: "A message goes to at most 10 agents."
  - with files attached: "Files go to one agent at a time"
- **Kept:** removable recipient chips, and Backspace in an empty box selects, then removes, the last chip.

**Renaming an agent** (Edit agent sheet):

- Under Display name sits `AddressLine`: "Handle **@cmo-agent** · Change". Change opens the field.
- The create form's "Slug" becomes "Handle".
- **Help text (create and edit):** "How agents and people tag this agent, like @team-lead. Lowercase letters, numbers and hyphens."
- **Extra help on edit:** "Everything already written shows the new handle. The old one is free for anyone."
- **No restart:** a handle change doesn't show the "restarts its reports" note.

**Editing your profile:**

- **"Edit profile"** in the sidebar user menu opens a right sheet with **Name** (display name) and **Handle**.
- **Handle help text:** "How agents and people tag you, like @alice."
- **Sign-up:** the handle input allows 40 characters, and its help text reads "How agents and people tag you, like @alice. You can change it later."

**Validation and feedback (both sheets):**

- **Timing:** on blur when changed, then on every keystroke while an error shows (DESIGN.md Validation).
- **Taken handle:** checked on blur against the principals cache. The server's 409 stays the backstop and maps to the same message.
- **Error copy:**
  - "Another agent or person has this handle"
  - "Reserved for the factory"
  - "Use 2 to 40 characters"
  - "Use lowercase letters, numbers and hyphens"
  - "Start and end with a letter or number"
  - Name: "Enter a name" (empty) and "Use up to 80 characters"
- **After a handle save:** the sheet closes and a toast reads **"@dev is now @builder"** with **Undo**.
  - Undo PATCHes the old handle back.
  - On 409, the toast becomes "Couldn't undo: @dev was taken".
- A name change saves without a toast beyond the sheet's normal confirmation.
- Chips, speaker lines, page headers, breadcrumbs and the document title update live.

**Routes.**

- Web routes use the ref (`/agents/k7x2m9qd`). Inbox links, task links and the chat list carry refs.
- Links never change on a rename.
- An unresolvable ref shows "No agent at this link".

### 4.6 Edge cases

- **Tags to ended principals:** a tag of a terminated, archived or disabled principal only exists in older text, or when an agent writes one. It renders muted. Sending to one keeps today's refusals.
- **Caps:** messages have no tag cap; the 64 KB body limit applies. Task comments reach at most 50 tagged principals.
- **An agent's own session output** may contain tags. The raw Session view renders them as chips through the same `Markdown` component.
- **A rename that races a send** can't misroute: the send resolved refs, not names.
- **Reserved words** are refused as handles at the schema, so `@factory`, `@scheduler` and `@unknown` never resolve as a plain tag.

### 4.7 Testing

Each test is named for the behaviour it protects, at the cheapest level that can fail for it (AGENTS.md).

- **`shared/ref` unit:**
  - a ref is 8 chars of the alphabet for any UUID
  - `normaliseRef` maps case and `i/l/o`
  - non-refs are rejected
- **`shared/tags` unit** (`test.each` over inputs):
  - tokens in code spans and blocks are left alone, and so are escapes
  - labels are stripped on apply
  - plain `@name` resolves only on an exact current-handle match, and only with `resolvePlain`
  - unknown refs are reported
  - `renderTags` gives both styles, with `unknown`
- **DB:**
  - two principals can't share a handle, or a ref
  - a rename frees a handle for a new principal
  - an agent or user can't exist without its principal
  - a persistent agent must have a manager
- **Routes:**
  - rename → 200 and `principal_updated`; taken → 409; reserved → 400
  - a user's name change → 200 and `principal_updated`
  - `/api/agents/:ref` resolves after a rename
  - a chat message with a tag reaches only its recipients
  - an unknown ref in a body → 400, and no row
  - sign-up creates a user and its principal with a UUID id
  - creating an agent emits `principal_updated`
- **MCP tools:**
  - `send_message` with plain `@name` stores `<@ref>` and returns the warning
  - an unknown ref → error, and nothing sent
  - `to` accepts a tag, a bare ref and a handle
  - a task comment's tag reaches the tagged principal
  - `list_peers` returns tags
- **Envelope:** after a rename, a new delivery shows the new handle in `from` and in a body tag.
- **Workspace:** an agent renamed between two starts uses the same workdir and resumes its session (fake Claude).
- **Web composer:**
  - picking from `@` in chat inserts a tag and adds no recipient
  - a click inside a tag puts the caret at its edge
  - Backspace at a tag's end removes it whole
  - undo after deleting a tag restores it as a tag
  - pasting copied tags keeps them as tags
  - submit sends `<@ref>`, and a draft hydrates back to `@handle`
- **Web recipients:**
  - Add recipient adds one and announces it
  - Add recipient is `aria-disabled` with its reason at 10 recipients and while files are attached
- **Web chips:**
  - a chip shows the new handle after `principal_updated`
  - a ref missing from the cache shows `@…` then the handle, never `@unknown`
  - a terminated agent's chip says "terminated" to a screen reader
  - a tag inside a task-list row link renders as plain text, not a nested link
- **Web profile and rename:**
  - Edit profile saves a new name and handle
  - a taken handle shows "Another agent or person has this handle"
  - Undo on the rename toast restores the old handle

## 5. Docs to update

- **ADR 0029, "Principals and tags"**, new. It records §1's decisions and that the namespace parts of ADR 0021 (the `handles` table, immutable slugs) are replaced. ADR 0021's `@` sigil, list recipients and no `@humans` stand.
- **Decisions index:** add an ADR 0029 line.
- **Product docs:**
  - `concepts/agent.md`: handles are changeable, and freed handles can be reused
  - `concepts/user.md`: handle and display name are editable in Edit profile
  - `concepts/message.md`: tags, `@` doesn't add recipients, envelope attributes
  - `concepts/task.md`: comment tags reach
  - `architecture/` pages naming `handles`, slugs, workdir paths or container names
- **DESIGN.md:**
  - Forms: Edit shows the handle as a line with Change; only the template can't change.
  - Composers: `@` tags and never adds a recipient; the Add recipient control and its picker; the highlighter.
  - A new Tag chip entry (look, states, tooltip, accessible name).
  - The user menu's Edit profile.

## 6. Out of scope

- A rich-text composer.
- `@` in the session composer.
- Ended principals in the `@` picker.
- A `/@handle` URL.
- Agents renaming agents (`update_agent` handle).
- Rename notifications to agents.
- Tags that notify outside task comments.
- Channels (`#`).
- Handle history or redirects from old handles.
