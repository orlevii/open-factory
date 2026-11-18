# S4 Templates, agents and settings: UI Design

- **Date:** 2026-11-19
- **Author:** tech-lead-s4
- **Status:** draft for the impeccable review against DESIGN.md
- **Spec:** [`docs/superpowers/specs/2026-11-19-s4-templates-workspace-design.md`](../specs/2026-11-19-s4-templates-workspace-design.md)
- **Binding:** [`DESIGN.md`](../../../DESIGN.md) (Sawtooth) and [`PRODUCT.md`](../../../PRODUCT.md). Where this doc and DESIGN.md disagree, DESIGN.md wins.
- **Product behaviour:** `docs/product/behavior/administration.md` (Templates, Settings), `docs/product/behavior/agents-and-sessions.md` (Org tree, New agent).

These are administration screens: they are visited rarely compared with the session view, so they follow the existing patterns (page header, `FormField`, the S1 `MarkdownEditor` unit, the S3 agents list) instead of adding new visual language. Every piece of data here comes from the spec's §14 API.

## 1. Screens and routes

| Route | Screen | File (`apps/web/src/routes/_app/`) |
|---|---|---|
| `/templates` | Templates list | `templates.index.tsx` (replaces `templates.tsx`) |
| `/templates/new` | New template | `templates.new.tsx` |
| `/templates/$name` | Template page (editors) | `templates.$name.tsx` |
| `/agents` | Agents: org tree v0 | `agents.index.tsx` (extended) |
| `/agents/new?template=<name>` | New agent | `agents.new.tsx` |
| `/agents/$slug/edit` | Edit agent | `agents.$slug.edit.tsx` |
| `/agents/$slug` | Session view (S3, extended strip) | `agents.$slug.tsx` |
| `/settings` | Settings: Projects, Credentials, Secrets | `settings.tsx` (replaces the empty state) |

Feature code lives in `apps/web/src/features/{templates,agents,settings}/`. The sidebar items stay as they are; Templates stays active on all `/templates*` routes and Agents on all `/agents*` routes.

## 2. Shared patterns

- **Lists** follow the S3 Agents list: a plain `ul` inside the page body, 44px rows separated by 1px `rule` lines, the whole row one link, hover is the `steel-hover` fill (instant). No cards, no tables with heavy chrome.
- **Long forms** (New template, New agent, Edit agent, the Settings add forms) use `FormField` and validate **each field on blur, never while typing, and everything on submit** (DESIGN.md → Validation). Editing a field clears its error. After a failed submit, focus moves to the first invalid field. Server field errors (`400 validation_error` with `fields`) land under their fields; form-level errors sit in a `role="alert"` line directly above the submit button (S1 §4.3).
- **Submit buttons** are primary (graphite, never orange), named for their action ("Create agent", "Save changes", "Add credential"), with the S1 inline `Loader2` pending state and a pending label ("Creating…", "Verifying…").
- **Selects** (template, manager, credential): a native `<select>` styled as an input (32px, plate fill, `field-edge`), not a custom listbox. There are few options and a native control is the most accessible choice. No new dependency.
- **Inline outcomes instead of toasts** (DESIGN.md: no toasts for routine tasks). An action's result appears as one line in the place the action was taken: a muted line with a check icon for success, crimson with an icon for failure. "Undo" is a link-style ghost button inside that line.
- **Confirmation dialog** (only for the two destructive, irreversible actions: Delete template and Delete secret): add shadcn `alert-dialog`. A plate on a 20% black scrim (no blur). The title names the thing ("Delete template tech-lead?"), one sentence says exactly what is lost, and the buttons are "Cancel" (ghost, focused by default) and "Delete tech-lead" (danger, crimson). Escape cancels; focus returns to the trigger.
- **Identifiers** (slugs, template names, project names, secret names, env vars, paths) are Geist Mono 13px; everything else is Geist.

## 3. Templates

### 3.1 List (`/templates`)

Header actions: **New template** (ghost, `Plus`). One row per template:

```
tech-lead     Tech Lead     Owns delivery for the app; plans, delegates…     Docker   2 agents    1 warning
```

- The name in mono 13px ink, then the display name (14px ink), then the description (muted, truncated with an ellipsis), then the runtime as a plain label ("Docker", or "Local"), the agent count ("No agents", "1 agent", "2 agents") and the validation state at the right edge.
- **Validation state:** nothing when clean; otherwise a 14px icon plus plain words: "2 errors" (crimson `CircleAlert`, ink text) or "1 warning" (warning-coloured `TriangleAlert`, ink text). Errors win when both exist ("1 error, 2 warnings"). Never colour alone.
- Empty: "No templates yet. Create one, or add a folder under `~/open-factory/templates/`." (the path in mono; it shows the real `FACTORY_HOME` from `/api/status` if it differs).
- The list rescans on every visit (the server does it on `GET`), so on-disk edits show on the next view. There's no live push and no refresh button.

### 3.2 New template (`/templates/new`)

A short form: **Name** (mono, help: "Lowercase letters, numbers and hyphens. Also the folder name."), **Display name**, **Description** (textarea, optional). Submit: "Create template". On success it navigates to `/templates/$name`. A `409 template_exists` shows under Name: "A template named tech-lead already exists."

### 3.3 Template page (`/templates/$name`)

```
┌ PageHeader ─────────────────────────────────────────────────────────────────┐
│ ☰  Tech Lead  tech-lead                       [Create agent] [Delete…]    │
├ Summary strip (32px, muted 13px) ─────────────────────────────────────────┤
│ Docker · ~/open-factory/templates/tech-lead · 2 agents: @lead, @lead-2     │
├────────────────────────────────────────────────────────────────────────────┤
│ Issues panel (only when there are issues)                                  │
│ [template.yaml] [AGENTS.md] [settings.json] [mcp.json]   ← tabs            │
│ ┌ editor unit ──────────────────────────────────────────────────────────┐ │
│ │ mono textarea                                                         │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
│ issues for this file (line:col)                    [Discard] [Save]       │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Header:** the display name as h1, the name in mono through the `meta` slot. Actions: **Create agent** (ghost, links to `/agents/new?template=<name>`; with `aria-disabled` and the tooltip "Fix the errors first" while the template has errors) and **Delete…** (ghost with a crimson icon; opens the confirmation: "Delete template tech-lead?", "This deletes the folder ~/open-factory/templates/tech-lead. Agents created from it keep their own copies.", "Delete tech-lead").
- **Summary strip:** the runtime, the folder path (mono), and the agents created from it as links (`@slug`, mono).
- **Issues panel:** shown above the tabs only when the template has issues. One line per issue: an icon, the file in mono, `line:col` when known, and the message. Clicking an issue switches to that file's tab and moves the caret to that line. Errors are listed first. The panel heading reads "This template can't be used until the errors are fixed." when there are errors, otherwise "Warnings".
- **Tabs** (shadcn `Tabs`, the S1 MarkdownEditor bar style): `template.yaml`, `AGENTS.md`, `settings.json`, `mcp.json`, labels in mono. A tab whose file has errors shows a small crimson `CircleAlert` before the label, plus a visually hidden "(has errors)". An optional file that doesn't exist yet shows "Not created" in muted text inside the panel, with a "Create file" ghost button that starts it with `{}` or `{"mcpServers": {}}`. `AGENTS.md` keeps the Write and Preview pair (the S1 MarkdownEditor); the other three are a single mono textarea unit with the same border, focus ring and min-height (`min-h-80`, `resize-y`), `spellCheck={false}`, and Tab inserting two spaces (Escape, then Tab, leaves the field; the hint "Esc then Tab to leave the editor" appears under the unit while it is focused).
- **Validation:** on blur of the editor, `POST /validate` with the unsaved content. The file's issues render under the editor (`line:col`, message), crimson for errors and the warning colour for warnings, each with an icon. Typing never re-validates. Save also validates, and the result replaces the list.
- **Save and Discard:** per file. Save is primary and enabled only when the content differs from what was loaded. **Saving invalid content is allowed** (files are the source of truth). The button then reads "Save" as usual, and after saving the issues list stays visible with the line "Saved. Fix the errors before creating agents from this template." A `409 changed_on_disk` shows above the buttons: "This file changed on disk since you opened it." with "Reload" (discards your edits; the textarea is replaced) and "Overwrite" (saves with the new base hash). Discard restores the loaded content without a confirmation (nothing is lost on disk).
- **Unsaved changes:** a dot after the tab label (plus visually hidden "(unsaved)"). Leaving the page with unsaved edits uses the router's blocker with the browser's native prompt. That's the only guard: no custom dialog.

## 4. Agents

### 4.1 Org tree v0 (`/agents`)

Header actions: **New agent** (ghost, `Plus`). The S3 list keeps its row anatomy and gains indentation and two fields:

```
[▲] Working    Team Lead        lead           tech-lead                 Unsandboxed
[●] Idle         └ Developer    dev-1          developer                 Unsandboxed
[●] Hibernated Reviewer         reviewer       proxy-reviewer            Docker
```

- **Indentation:** 20px per depth level, applied to the display-name column only (the status column stays aligned). A 1px `rule` elbow (`└`) drawn with a CSS border before nested names. The tree is depth-first in server order (spec §6.6).
- **Columns:** status slot and label (S3), the display name, the slug (mono, muted), the template name (mono, muted), and at the right "Unsandboxed" (local runtime, S3's badge) or "Docker" (same outline style, no colour).
- **Restart pending:** when `restartPending`, a muted `RotateCw` icon after the status label, with the visually hidden text "restart pending". Its tooltip lives in the session strip, not here (no interactive elements inside the row link).
- **Archived filter:** a small segmented control in the header's left meta slot: "Active" and "Archived" (two toggle buttons, `aria-pressed`). Archived rows render the same way, with the status label "Archived" (no dot).
- **Archive outcome:** after archiving (from the Edit page, §4.3), the user lands back on `/agents` with an inline line at the top of the list: "Archived @reviewer. Undo". Undo calls unarchive and replaces the line with "Restored @reviewer." The line stays until the user navigates away.
- **Empty:** "No agents yet. Create one from a template." with "Create one" linking to `/agents/new` and "a template" to `/templates`. If there are no templates either: "No agents yet. Start by creating a template." When there's no credential: "No agents yet. Add a Claude credential in Settings first, then create one from a template."

### 4.2 New agent (`/agents/new`)

A single-column form, max width 36rem, in this order:

1. **Template**: a select of valid templates only (invalid ones are listed disabled with "(has errors)"). Preselected from `?template=`. Changing it fills in the display name, the description and the project grants from the template, unless the user already edited those fields. Under it, a muted summary of what the template brings: "Docker · model opus · skills: brainstorming, grilling · plugins: 1 · secrets: GH_TOKEN". A secret that isn't set shows as a warning line: "Secret GH_TOKEN isn't set. The agent won't start until you add it in Settings." with a link.
2. **Slug** (mono; help: "How others address this agent, like @team-lead. Lowercase letters, numbers and hyphens. Can't be changed later."; prefix `@`). Blur check against the rules. The `slug_taken` and `folder_exists` server errors show here.
3. **Display name**.
4. **Description** (textarea, 3 rows).
5. **Manager**: a select: "No manager (reports to the humans)" and then the non-archived agents in tree order, indented with leading spaces and showing `Display name (@slug)`.
6. **Credential**: a select of credentials by name, each with its kind ("work: OAuth token"). If none exist, the field is replaced by a line: "Add a Claude credential in Settings first." with a link, and submit is disabled.
7. **Projects**: a checkbox list of registered projects (name in mono, path muted). The template's projects are checked by default, and a muted note "From the template" sits next to the label. Once the user changes the set, the note becomes "Custom" and a "Use template default" ghost button appears. Projects the template lists but that aren't registered can't happen here (the template would be invalid).

Submit: "Create agent", pending "Creating…". Creation installs plugins and can take a while, so the pending state adds a muted line under the button after 3 s: "Installing plugins…" (shown only if the template has plugins). On success it navigates to the new agent's session view. A `502 plugin_install_failed` shows as the form error with the CLI output in a collapsed code block ("Show output").

### 4.3 Edit agent (`/agents/$slug/edit`)

The same form minus Template and Slug, which show as read-only text at the top ("Template tech-lead · @lead"). Submit: "Save changes". If the agent is running, the success line reads "Saved. The agent restarts when idle to apply the changes."

Below the form, separated by a `rule`, an **Agent actions** section with two rows, each with a one-line explanation and a ghost button:

- **Re-sync from template**: "Copies the template's AGENTS.md, skills, files and settings over this agent's copies and reinstalls its plugins. Files that differ are backed up first." The button is "Re-sync". Outcome line: "Re-synced. Previous files saved in .factory/resync/2026-11-19T10-22-31Z." (path in mono), or "Re-synced. Nothing differed." Disabled with a reason when the template is missing or invalid ("Template tech-lead has errors.").
- **Archive**: "Stops the agent and hides it. Its files and session are kept, and you can restore it." The button is "Archive @lead" (ghost with crimson text). No confirmation (it has an undo). Blocked state: the `has_reports` message as the outcome line, naming the reports as links.

For an archived agent the page shows a muted line at the top, "This agent is archived.", the form stays editable (so a credential or manager can be fixed), and the actions section shows **Restore** instead of Archive and Re-sync.

### 4.4 Session view additions (S3 view)

- **Agent strip:** `lead · tech-lead · reports to @cto · credential work · Unsandboxed: runs directly on this machine` (identifiers in mono, separators as middle dots, wrapping on narrow screens). "No manager" when there's none. For docker agents, "Docker" replaces the unsandboxed text.
- **Restart pending:** a strip segment with a `RotateCw` icon: "Restarts when idle to apply changes". Its tooltip: "The agent finishes its current work, then restarts with the new settings. Its session is kept. Scheduled reminders it created in this session are lost." The segment is a focusable `button` with no action, so the tooltip is keyboard-reachable.
- **Header:** an **Edit** ghost button (`Pencil`) before Compact links to `/agents/$slug/edit`.
- **Archived:** the composer is replaced by a muted line, "This agent is archived. Restore it to send messages." (with a link to the edit page), and Compact and Interrupt are hidden. The timeline stays fully readable.
- **Denials:** `permission_denied` rows whose `toolUseId` matches a tool call render inside that call's row as a line under the summary, "Denied by a permission rule" or "Denied: <reason>" with the warning icon, and the call's state label reads "Denied". Unpaired denials keep S3's standalone row.
- **Start failures** (missing secret, host skill, project or credential; docker): the S3 `error` row already shows the message. The messages name the fix (spec §16), and where one names a Settings section the row links to `/settings#secrets` and so on.

## 5. Settings (`/settings`)

One page with three sections in this order: **Credentials**, **Secrets**, **Projects**. Each section has an h2 (Archivo 15px), a one-line muted description, its list, and an "Add …" ghost button that reveals an inline add form under the list (no dialog). Section anchors: `#credentials`, `#secrets`, `#projects`. S10 adds sections later in the same pattern.

### 5.1 Credentials

Description: "Claude logins agents use. Each agent picks one." Rows:

```
work      OAuth token    Verified 2 hours ago        Used by @lead, @dev-1          [Verify] [Delete]
personal  API key        Last check failed: Claude rejected this token.   Not used   [Verify] [Delete]
```

- The name in mono, then the kind, the verification state (relative time with the absolute time as `title`; failures in crimson with an icon), and usage (agent links, mono) or "Not used". The actions are ghost buttons. **Verify** shows "Verifying…" inline. **Replace token** sits in a `⋯` menu with Delete. Replace reveals an inline single-field form ("New token", password input, "Verify and save").
- **Delete:** no dialog. A credential can be deleted only when no agent references it. Otherwise the button is `aria-disabled` with the tooltip "Used by @lead. Change their credential first." For unused credentials, Delete acts immediately and the row is replaced by "Deleted work." This has no undo: the value is gone, but re-adding it is the same act as adding it, and nothing breaks. (The review should confirm that dropping the confirmation here is right under DESIGN.md's "destructive and irreversible" rule: the data is irreversible, but nothing depends on it.)
- **Add credential** form: Name (mono), Kind (two radio options: "OAuth token (from `claude setup-token`)", "API key"), Token or Key (a password input, `autoComplete="off"`, with a show/hide toggle), and the submit "Verify and add" (pending "Verifying…", about 5 s). Errors land under the token field: "Claude rejected this token. Create a new one with `claude setup-token`." or "Couldn't reach Claude to verify. Try again."

### 5.2 Secrets

Description: "Environment variables agents receive when their template lists them. Values can't be viewed after saving." Rows: the name (mono), "Set" with the updated time, and usage ("Used by @lead" or "Not used by any agent"), then **Update** and **Delete…** buttons.

- **Update** reveals an inline single password field, "New value", with the submit "Save value". The success line reads "Saved. @lead restarts when idle to use it." when it has users.
- **Delete…** opens the confirmation: "Delete secret GH_TOKEN?", "Its value is erased. @lead and @dev-1 won't start until you add it again." (or "No agent uses it."), "Delete GH_TOKEN".
- **Add secret** form: Name (mono, uppercase enforced on input; help: "Uppercase letters, numbers and underscores, like GH_TOKEN."), Value (a password input). Submit "Add secret".

### 5.3 Projects

Description: "Folders on this machine that agents can be granted. Granted agents see them at ./projects/<name>." Rows: the name (mono), the host path (mono, muted, truncated in the middle with the full path as `title`), the granted agents or "Not granted", and an `⋯` menu with **Change path** and **Remove**.

- **Remove:** only when not granted to an active agent (otherwise `aria-disabled` with the tooltip "Granted to @lead. Remove the grant first."). It acts immediately with an inline "Removed app. Undo" (Undo re-adds the same name and path).
- **Change path:** an inline field, with the success line "Saved. Granted agents restart when idle to use the new path."
- **Add project** form: Name (mono), Path (mono; help: "Absolute path to a folder on this machine, usually a git repository."). The server rejects a missing or non-directory path: "No folder at /x."

## 6. Accessibility

- Every form control has a visible label; help and error text are tied with `aria-describedby` (the S1 `FormField` rule: the error replaces the help).
- The tabs are Radix tabs (arrow keys). The issues panel is a list of buttons. The issue counts in the list are text, not just icons.
- Inline outcome lines are `role="status"` (success) or `role="alert"` (failure) so they're announced; Undo is a real button.
- The tree indentation is visual. Each nested row also carries a visually hidden "reports to Team Lead" so the structure is announced.
- Confirmation dialogs: focus trapped, Cancel focused first, Escape closes, focus returns to the trigger.
- Everything in rem; colours from tokens; the 2px signal focus ring; no colour-only states.

## 7. Responsive

- Below `md`, list rows wrap into two lines (name line, then the metadata line). Header actions become icon buttons with `aria-label`s and tooltips. Forms are full width within the 16px gutter.
- The editor textareas keep `min-h-80`. On touch, Tab-inserts-spaces is off (there's no Tab key) and the hint is hidden.

## 8. Copy

Sentence case, calm and specific (PRODUCT.md). Fixed strings appear above in quotes. A few rules:
- Use "template", "agent", "credential", "secret" and "project" exactly (PRODUCT.md terms).
- Never mention roadmap IDs (S5) in the UI.
- Errors name the problem and the way out ("Change their manager first.").

## 9. Components to add

- `features/templates/`: `TemplateList`, `TemplateEditor` (tabs and per-file state), `CodeTextarea` (a mono textarea unit with Tab handling), `IssueList`.
- `features/agents/`: `AgentTree`, `AgentForm` (shared by New and Edit), `ProjectGrantPicker`, `AgentActions`.
- `features/settings/`: `CredentialsSection`, `SecretsSection`, `ProjectsSection`.
- `components/`: `InlineOutcome` (the status or alert line with an optional Undo), `ConfirmDialog` (shadcn `alert-dialog`), `NativeSelect`.
- shadcn addition: `alert-dialog`.
