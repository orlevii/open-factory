# I6 Path help: Technical Design

- **Date:** 2026-11-23
- **Status:** draft for review. The owner-proxy (owner-i6) answered Q1–Q10. Low certainty, for Or: Q1 (only the factory machine's OS is shown, 3), Q2 (the machine note always shows, with the hostname, 3), Q10 (prefetch plus a fallback layout instead of a loading state, 3).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/roadmap/v0.0.2/i6-path-help.md` (the task), `scope.md`, `index.md` (delivery order I4 → I6 → I1 …), `i5-skills-and-plugins.md` (its local-folder skill and local marketplace fields adopt this helper), `docs/product/decisions/0028-pre-release-no-compatibility.md`, `docs/product/ui-review/decisions.md`.
- **Builds on:** `i4/field-errors` (stacked). I4 gives every field a reserved note line (`FieldNote`), the `useFieldErrors` hook with `data-skip-validate`, `FormOutcome`, and the error copy rules (at most 40 characters, one rule per message, never the user's input). I6 changes only what sits on top of them.
- **Decision log:** GitHub issue "I6: Path help — design". Q1–Q10 are the proxy's answers; D1–D8 are tech-lead decisions (§10).

> Web paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`.

## 1. Goal

Typing an absolute host path should be easy without a folder browser. Every host-path field gets a **How do I find this path?** button in its label row that opens a small popover with the steps for the factory machine's OS, the machine's name and what `~` means there. The server expands a leading `~` to the factory user's home before its existing folder check, so `~/code/web` is accepted and stored as the absolute (real) path.

Today only Settings → Projects has host-path fields (Add project, as a sheet or inline; Change path, inline in a project row). I6 builds the helper as one reusable field, `PathField`, plus one reusable server check, `resolveHostFolder`, which I5's local-folder skill and local marketplace fields adopt later. I6 does not build those I5 fields.

## 2. Acceptance criteria

Default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked manual.

1. **Helper on each field.** Add project (sheet and inline) and Change path render "How do I find this path?" at the right end of the Path label row (component tests).
2. **Keyboard.** Tab reaches the button; Enter or Space opens the popover and focus moves into it; Esc closes only the popover (an enclosing sheet or drawer stays open) and focus returns to the button (component test; manual in both browsers).
3. **Phones.** At 390×844 inside the Add project bottom drawer the popover opens fully on screen (8px clear of each edge), a tap outside it closes only the popover, and the button is at least 40px tall on touch (manual, Chromium and WebKit headless).
4. **Content.** With host info for `darwin` the popover shows the macOS steps and not the Linux ones; for any other platform the Linux steps only; it names the hostname and says what `~` means. Pending or failed host info shows the fallback layout (§5.3) with no error UI (component tests).
5. **`~` accepted.** `POST /api/projects` with `hostPath: "~/code/web"` (an existing folder under the factory user's home) stores the realpath, `/…/code/web`; `~` alone resolves to the home folder; `~other/x` and `code/web` fail with "Start with / or ~/." on `hostPath` (server tests). The web check accepts `~` and `~/…` and sends the value unexpanded (component test).
6. **No validation from the helper.** Typing into Path and then clicking or tabbing to the help button shows no error under Path (I4's `data-skip-validate`; component test).
7. **Host info is authenticated.** `GET /api/host` returns `{ platform, hostname, home }` to a signed-in user and 401 without a session (route test).

## 3. Scope

**In:** `GET /api/host` and `hostInfoSchema`; `expandHome` and `resolveHostFolder` as one server module used by `config.ts` and `ProjectService`; the shared path-shape check and its message; `PathField` and `PathHelp` in `components/`; `hostQueryOptions` and its prefetch; Add project and Change path moved onto `PathField`; new help and error copy; a DESIGN.md line (§9).

**Out:** a folder browser (deferred in scope.md); the I5 Library fields (they adopt `PathField` and `resolveHostFolder` when I5 lands); `~user` expansion; Windows paths (unsupported); the Docker mount checks in `workspace/mounts.ts`, which keep their own `os.userInfo().homedir` (a deliberate security choice that `$HOME` can't override; Q4).

**Breaking (ADR 0028):** the relative-path error changes from "Enter an absolute path." to "Start with / or ~/." on the server and in the web; the Projects help text changes; `checkPath` and `PATH_HELP` are deleted from `features/settings/forms/shared.tsx` (replaced by `checkHostPath` and per-field help). No aliases.

## 4. Inventory (today, on `i4/field-errors`)

| Piece | Where | Today |
|---|---|---|
| Server check | `apps/server/src/projects/project-service.ts:110` `resolveFolder` | `path.isAbsolute` else `FieldError("hostPath", "Enter an absolute path.")`; `realpath` + `isDirectory` else "No folder at …" (I4: "No folder at this path."); returns the realpath, which `create`/`update` store and compare. |
| `~` expansion | `apps/server/src/config.ts:114` `expandHome` (private) | `~` and `~/…` → `os.homedir()`, then `path.resolve`; used for `FACTORY_HOME` and `FACTORY_HOST_SKILLS_DIR`. |
| Home dir | `os.homedir()` of the server process | Same in both agent runtimes: the factory server always runs as a host process (Docker runs only agent containers, which receive host paths as mounts). If the factory itself runs in a container (README), the home and hostname are the container's, which is also where its paths resolve. `workspace/mounts.ts` reads `os.userInfo().homedir` on purpose and is untouched. |
| Callers | `routes/projects.ts` (POST, PATCH) → `ProjectService.create/update`; smoke scripts | No CLI command or MCP tool creates or edits projects. |
| Web check | `features/settings/forms/shared.tsx` `checkPath`, `PATH_HELP` | Empty → "Enter a path."; not starting with `/` → "Enter an absolute path."; help "Absolute path to a folder on this machine, usually a git repository." |
| Web fields | `features/settings/forms/add-project-form.tsx` (via `FormFrame`, sheet or inline; also stacked over New agent through `features/sheets/setup-sheets.tsx`), `features/settings/projects-section.tsx` `ChangePathForm` (via `InlineForm`) | `FormField` with mono input; I4 migrates both to `useFieldErrors` and `FormOutcome`. |
| Label-row slot | `components/field-shell.tsx` `action` | Used by Add credential and New template (ghost `size="sm"` `inForm` buttons). `FormField` does not expose it yet. |
| Popover | `components/ui/popover.tsx` | Radix, portalled, `w-72`, 100ms in / 75ms out, keyboard openings instant through `useStampedRef`. Used inside sheets already (comboboxes). |
| Prefetch points | `routes/_app/settings.projects.tsx` loader; `features/sheets/sheet-bodies.ts` `add-project.prefetch` | — |

## 5. Design

### 5.1 Server

**`apps/server/src/host-path.ts` (new)** — the one place host paths are interpreted:

```ts
export function expandHome(p: string, home = os.homedir()): string
// "~" → home; "~/x" → path.join(home, "x"); anything else unchanged. No path.resolve here.

export async function resolveHostFolder(field: string, input: string): Promise<string>
// 1. const p = expandHome(input.trim())
// 2. if (!path.isAbsolute(p)) throw new FieldError(field, HOST_PATH_START)
// 3. realpath + stat.isDirectory, else FieldError(field, "No folder at this path.")  (I4's constant)
// 4. return the realpath
```

- `config.ts` imports `expandHome` and keeps its `path.resolve(expandHome(...))` call for env values (they may be relative to the working directory, which host-path fields never are). Its private copy is deleted.
- `ProjectService.resolveFolder` is deleted; `create` and `update` call `resolveHostFolder("hostPath", b.hostPath)`. The stored value stays the realpath, so `~` is never stored (Q4). `update`'s "same folder" short-circuit compares realpaths, so `~/web` for a project already at `/Users/or/web` is a no-op, as before.
- `~user/…` is not expanded, so `path.isAbsolute` fails and it gets "Start with / or ~/." (Q4).
- The body schemas (`createProjectBodySchema`, `patchProjectBodySchema`) stay `z.string().trim().min(1)`: the shape check lives in `resolveHostFolder`, so every caller (I5 included) gets the same field error.

**`GET /api/host` (new, `apps/server/src/routes/host.ts`)** behind `requireUser` (`onRequest`), response `hostInfoSchema`:

```ts
{ platform: process.platform, hostname: os.hostname(), home: os.homedir() }
```

Not on `/api/status` (unauthenticated health check; hostname and home aren't public) nor on factory settings (editable settings, returned by every PATCH) (Q9).

### 5.2 Shared (`packages/shared/src/host.ts`, new)

```ts
export const hostInfoSchema = z.object({ platform: z.string(), hostname: z.string(), home: z.string() });
export type HostInfo = z.infer<typeof hostInfoSchema>;
export const HOST_PATH_START = "Start with / or ~/.";   // ≤ 40, in I4's copy-length test
export const isHostPathShape = (p: string) => p.startsWith("/") || p === "~" || p.startsWith("~/");
```

The server and the web use the same message constant, so the two checks can't drift (Q8). `platform` is a plain string, not an enum: the web branches only on `"darwin"`.

### 5.3 Web

**`hostQueryOptions` (`lib/host.ts`, new):** `queryKey: ["host"]`, `staleTime: Infinity`, `gcTime: Infinity`, `apiFetch("/api/host", { schema: hostInfoSchema })`. Prefetched without awaiting where a path field can mount (Q10): the `settings.projects` loader (`void qc.prefetchQuery(hostQueryOptions)`, beside the awaited projects fetch) and `sheet-bodies.ts`'s `add-project.prefetch` (a direct `qc.prefetchQuery(hostQueryOptions)`, not `warm`, whose 10-second staleness would refetch facts that never change). I5's Library route adds the same line. `PathHelp` also reads it with `useQuery`, so a field mounted anywhere else still fetches on its own.

**`checkHostPath(p)` (`components/path-field.tsx`):** `p.trim() === ""` → "Enter a path."; `!isHostPathShape(p.trim())` → `HOST_PATH_START`; else `undefined`. Forms put it in their `useFieldErrors` checks. The form sends `hostPath.trim()` unexpanded; only the server knows the home (Q4).

**`PathField` (`components/path-field.tsx`, new):** a `FormField` with the help button in its label row and the path input defaults.

```tsx
<PathField
  name="project-path" label="Path"
  help="A folder on the factory's machine, like ~/code/web."
  value={…} error={f.errors.hostPath}
  onChange={…} onBlur={(e) => f.blur("hostPath", e)}
/>
```

- Props: `FormField`'s props, with `help` required (each field writes its own; the component holds no Projects wording, Q8). It renders `FormField` with `action={<PathHelp />}`, `className="font-mono"`, `autoComplete="off"`, `autoCapitalize="none"`, `spellCheck={false}`.
- `FormField` gains an optional `action` prop passed through to `FieldShell` (I6's one change to it).

**`PathHelp` (`components/path-help.tsx`, new):**

- **Trigger:** `<PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" inForm data-skip-validate>How do I find this path?</Button></PopoverTrigger>` (Q5). Ghost like the other label-row actions; `inForm` makes it 40px tall on touch without an expander that would overlap the input. `data-skip-validate` keeps a half-typed path from turning red when the button takes focus (AC6). On a 390px drawer the label row holds "Path" and the button on one line.
- **Surface:** the existing `Popover` at every width (Q6). `PopoverContent` with `align="end"`, `collisionPadding={8}`, `className="w-80 max-w-[calc(100vw-1rem)]"`, `aria-labelledby` its first line. It has no focusable content, so Radix focuses the content element itself on open; Esc and an outside press close the popover through Radix's layer stack, which already keeps an enclosing sheet or Vaul drawer open; focus returns to the trigger. A keyboard opening is instant (the existing `useStampedRef` rule).
- **Content** (13px, the popover's existing `gap-2.5`; keys as `Kbd`, commands as inline code; no Copy buttons, Q7):
  - Header (muted): "Paths are on **{hostname}**, the factory's machine. `~` means `{home}`."
  - `platform === "darwin"`:
    - "In Finder, select the folder and press ⌥⌘C to copy its path."
    - "Or drag the folder into Terminal to paste its path."
    - "Or run `pwd` in the folder."
  - any other platform:
    - "Run `pwd` in the folder."
    - "In the file manager, press Ctrl+L and copy the location."
  - **Fallback** (host info pending or failed; Q10): the header is "Paths are on the factory's machine." with no `~` sentence, and both sections show under the small headings "macOS" and "Linux". No spinner, no error text, no retry button. The content mounts only while the popover is open, so a query in error (no data) is fetched again by `useQuery` on the next open; a success is never refetched (`staleTime: Infinity`).
- Keys use `Kbd` with literal glyphs, `keys={["⌥", "⌘", "C"]}` and `keys={["Ctrl", "L"]}`, never `"Mod"`, because the steps describe the factory's machine, not the viewer's keyboard (D5).

### 5.4 Forms

- **Add project** (`add-project-form.tsx`): the Path `FormField` becomes `PathField` with help "A folder on the factory's machine, like ~/code/web."; its check is `checkHostPath`.
- **Change path** (`projects-section.tsx` `ChangePathForm`): same field and help.
- `checkPath` and `PATH_HELP` are deleted from `features/settings/forms/shared.tsx`.
- A server 400 `fields.hostPath` keeps landing under Path through I4's `f.server`.

## 6. Data flow

Type `~/code/web` → blur: `checkHostPath` passes → submit → `POST /api/projects { hostPath: "~/code/web" }` → `resolveHostFolder` expands to `/Users/or/code/web`, realpaths it, checks it is a folder and is free → stored → the list shows `/Users/or/code/web`. `~nobody/x` → 400 `fields.hostPath: "Start with / or ~/."` → I4 shows it under Path and focuses it.

## 7. Testing

- **Server, `host-path.test.ts`:** `expandHome` for `~`, `~/x`, `~x`, `/a`, `a` with an injected home; `resolveHostFolder` with a temp home: `~/dir` → realpath, `~` → home realpath, `~other/x` and `rel` → `HOST_PATH_START`, a file or missing path → "No folder at this path.", field name carried in the error.
- **Server, `project-service.test.ts`:** create and update with `~/…` store the realpath; the existing tests' messages updated. Tests set `HOME` (or inject the home) to a temp dir; they never touch the real home.
- **Server, `routes/host.test.ts`:** 401 without a session; the shape with one.
- **Config:** `config.test.ts` keeps passing with the moved `expandHome`.
- **Shared:** `isHostPathShape` cases; `HOST_PATH_START` joins I4's ≤40 copy-length test.
- **Web, `path-help.test.tsx`:** darwin shows ⌥⌘C and not Ctrl+L; linux the reverse; hostname and home rendered; pending and failed show both sections and no `~` sentence; Enter opens and focuses the content; Esc closes and refocuses the trigger; inside an open `Sheet`, Esc closes only the popover.
- **Web, `path-field.test.tsx`:** the label row holds the button; `checkHostPath` cases; typing then tabbing to the button shows no error (with `useFieldErrors`).
- **Web, forms:** Add project and Change path send `~/code/web` unexpanded; the server's `HOST_PATH_START` lands under Path.
- **Manual (plan's last tasks):** the u4-evidence harness through its `run.sh` lock, fake Claude only, Chromium and WebKit headless: Add project as a sheet at 1440×900 and as a drawer at 390×844; open the popover by keyboard (Tab, Enter; screenshot; Esc; focus back on the button) and by tap (fully on screen, 8px clear; tap outside closes only the popover; the drawer stays); measure the trigger's height on touch (≥40px).

## 8. Risks

- **Container-hosted factory:** the hostname is a container id and the home the container user's. That is still where the path must exist, so the popover stays truthful, if unfriendly. Accepted.
- **Hostname as a secret:** shown only to signed-in users, who already see every host path in Settings → Projects.

## 9. DESIGN.md amendment

Components → Inputs, add: "A field that takes a path on the factory's machine has a ghost **How do I find this path?** button at the right of its label row. It opens a popover (at every width, also inside a drawer) with the steps to copy a folder's path on the factory machine's OS, the machine's name, and what `~` means there. Paths may start with `~/`; the factory stores the absolute path."

## 10. Decisions

Q1–Q10, with the proxy's answers and certainty, are in the decision issue. Tech-lead decisions:

- **D1** `resolveHostFolder(field, input)` in one server module rather than a `~` expansion inside `ProjectService`, because I5's two local-folder fields need the same expansion, shape check, realpath and messages under their own field names.
- **D2** The expansion happens server-side only, and the web sends the typed value, rather than the client expanding with the fetched home, because only the server's view of its home is authoritative and the client check then stays a shape check.
- **D3** `expandHome` does not `path.resolve`; `config.ts` resolves its env values itself, because a host-path field must reject a relative path rather than resolve it against the server's working directory.
- **D4** `FormField` gains `action` rather than `PathField` rendering `FieldShell` itself, so the input keeps one implementation (prefix, sizing, `aria` wiring).
- **D5** `PathHelp` fixes the Mac glyphs (⌥⌘C) rather than using `Kbd`'s `Mod` mapping, because the steps are for the factory's machine, not the viewer's keyboard.
- **D6** The popover content takes focus itself (Radix default with no focusable children) rather than adding a focusable element, so a screen reader lands on the text and Tab has nothing to trap.
- **D7** Host info is prefetched with `qc.prefetchQuery(hostQueryOptions)` directly, not through `sheet-bodies`' `warm`, because `warm` overrides `staleTime` to 10 seconds and would refetch facts that don't change while the server runs.
- **D8** `platform` is `z.string()` rather than an enum, because the web only branches on `darwin` and the server must never fail its own response schema on an unexpected platform.
