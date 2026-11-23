# I5 Skills and plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Library of skills (host, local folder, GitHub pinned to a commit, template-local) and plugins (from factory-registered, pinned marketplaces). Plugins install once per version into a factory-owned Claude Code **seed** that agents only read (closes #56). Add a Skills page and Library pickers in the Configuration form.

**Architecture:**
- **Skill sources and marketplaces** are two DB tables. Host and template-local skills are discovered live by a `LibraryIndex`.
- **GitHub skills** are fetched by a hardened `runGit` into `state/library/github/<id>/<sha>/`, read-only.
- **Plugins** are installed by a hardened `StoreRunner` into `state/plugins/` (`CLAUDE_CODE_PLUGIN_CACHE_DIR`). Agents load them through `CLAUDE_CODE_PLUGIN_SEED_DIR`, and the plugin settings arrive through `--settings '<json>'`.
- **Every start** scrubs the agent-writable plugin and skill paths and refuses reserved settings keys.
- **Library changes** reuse I2's change flow, with `{doc, library}` on both sides.

**Tech Stack:** TypeScript pnpm monorepo, Fastify, Postgres with Drizzle, Zod in `packages/shared`, React + Vite + TanStack Router/Query, cmdk (existing), Vitest, Biome, and the host `git` and `claude` CLIs. **No new npm dependency.**

**Spec:** `docs/superpowers/specs/2026-11-23-i5-skills-and-plugins-design.md` (the authority for behaviour and copy). Decision log: issue #153. Follow-ups: #154–#162. Before each task, read the spec sections it cites.

## Global Constraints

- **Pre-release (ADR 0028).** No backward compatibility, no shims, no aliases, no data migration. Schema changes ship as generated Drizzle migrations only. Each PR deletes what it replaces and states its reset step (spec §12).
- **Supply chain.** Keep exact pins and the pnpm minimum release age. Add no dependency; the lockfile doesn't change.
- **Never run real `claude`, and never fetch from the network in tests or evidence.**
  - Tests use fake Claude (`packages/harness/testing/fake-claude.mjs`, extended in B2) and a fake `git` where the test says so.
  - GitHub fetches go to a local fixture repo through `FACTORY_GITHUB_URL=file://…`.
  - Never read `~/.open-factory-spike` or the real `~/.claude`. Tests point `FACTORY_HOST_CLAUDE_DIR` at a temp dir.
  - The one real run is Or's Gate G1 (Task B1).
- **No tokens in URLs or logs.**
  - Every `git` and `claude plugin` output passes through `redactOutput` (`apps/server/src/redact.ts`).
  - Inputs refuse userinfo, `?` and `#`.
  - Events carry only redacted text.
- **Hardened runners (spec §6.2, §7.2).**
  - An empty temp cwd.
  - Env exactly `PATH` and the host `HOME`, plus the listed variables.
  - Every `git` call prefixed with the `-c` flags verbatim from spec §6.2.
  - Arguments starting with a dash are refused.
  - Budgets: git 60 s per command and 180 s per operation; claude 120 s per command and 240 s per operation.
- **Limits (verbatim from the spec):**
  - GitHub checkout ≤ 50 MB;
  - JSON ≤ 256 KB, `marketplace.json` ≤ 1 MB, `SKILL.md` ≤ 64 KB, at most 2,000 files walked;
  - descriptions and subjects cut to 200 characters on grapheme boundaries;
  - Undo 30 s;
  - check-all 4 at a time;
  - previews swept after 1 h.
- **Patterns.** `HOST_SKILL_PATTERN` for every Library skill name. `MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, minus the reserved names. `PLUGIN_REF_PATTERN`: a name of at most 64 characters, then `@`, then a marketplace name.
- **I4 form rules.** `FieldShell`/`FieldNote`, `useFieldErrors`, `FormOutcome` and `field-stack`. Field and outcome messages are exported constants of at most 40 characters, never interpolated (spec §10.4 lists them). User-facing copy says "Skills", never "Library".
- **Database tests run only in CI.** Tests that use `createTestDb`/`makeTestApp` (`apps/server/src/test/helpers.ts`) need Postgres, and the local Postgres role is unavailable. Locally, run the pure unit tests and the web tests, plus `pnpm typecheck`; read CI for the DB suites.
- **React.** Every task that touches `apps/web` states: "Implementer and reviewer invoke `vercel-react-best-practices` and follow it." Next-only rules don't apply (this is React + Vite + TanStack).
- **React rules from the plan review** (binding for every web task; the branch reviews check each one):
  - **R-Q1. POSTs are mutations.**
    - These are `useMutation`, started from click handlers and kept in component state, never under the `["library"]` key: `update-preview` (B10), Check for updates per source (A12), Find skills and Find more skills (A12, A13), Install and Install in factory (B10).
    - Test: a `library_changed` frame while an update view is open doesn't call `update-preview` again.
  - **R-Q2. Query keys.** Pinned keys, arrays of primitives:
    - `["library","skills"]`, `["library","skill",group,name]`, `["library","source",id]`;
    - `["library","plugins"]`, `["library","plugin",key,from]`, `["library","marketplaces"]`;
    - file text as `["library-file", group|key, name, path, pin]`, outside the `["library"]` prefix, with `staleTime: Infinity` when pinned. It is fetched only while View file is open (`enabled: open`), prefetched on pointer-enter or focus of the toggle, and rendered with `UntrustedCode`, never CodeMirror.
    - `libraryQueryOptions` uses `staleTime: 0`, so a window focus refreshes the host and template-local lists (spec §9.5).
  - **R-Q3. Coalesced invalidation.** `lib/ws.ts` coalesces `library_changed` invalidation to at most one per 250 ms, as `features/agents/status-frames.ts` batches frames. Test: 10 frames in one tick give one list refetch.
  - **R-E1. One elapsed timer.** A single leaf `<Elapsed since />` ticks itself. It shows nothing for the first 10 s, then a 1 s tick, paused through `hooks/use-document-visible.ts`. Extract it from `features/session/activity-line.tsx` if that ticker fits. Rows and headers pass only `since`. Test: a tick doesn't re-render sibling rows.
  - **R-L1. Rows and `j`/`k`.** Rows are `memo` components with primitive props (`shown`, `name`, `state`, `since`) and stable handlers, as in `features/tasks/task-list.tsx`. `lib/row-nav.ts` `onRowKeyDown` is extended to `<button>` rows and source headers, never a per-list `j`/`k` handler.
  - **R-L2. Peek from the cached row.** The peek reads the row with `useQuery({...libraryQueryOptions, select})`, where `select` is defined at module level or in a `useCallback` keyed on group and name. The detail comes from its own query, and the view is derived during render (`detail ?? rowFields`, plus skeletons from `contentsSummary`). Never `initialData`, and never an effect.
  - **R-L3. Aborting Find.** The Find sheet keeps one `AbortController` in a ref:
    - a new Find aborts the previous one inside its click handler;
    - Close aborts in its handler;
    - an unmount cleanup aborts as well, and that cleanup is the only effect.
    
    The signal goes through the `mutationFn`. Tests: unmount aborts; a second Find drops the first response.
  - **R-L4. Arrival.** `useLibraryArrival()` sets the initial peek during render from router state, with a lazy `useState` keyed on `location.key`. An effect is used only to scroll and focus, with deps `[location.key, rowFound]`, guarded by a ref so it runs once per arrival. Test: a `library_changed` after arrival doesn't scroll again.
  - **R-L5. Holding a row in place.** A row moving groups (B10) keeps a `held` snapshot:
    - set in `onPointerEnter` and `onFocus`;
    - cleared in `onPointerLeave` and `onBlur`, checking `relatedTarget`;
    - then `view = held ?? data` during render.
    
    Reuse or extract `useHeldWhileSelected` from `features/session/agent-text.tsx`.
  - **R-C1. Multi Combobox.** The snapshot of what to leave out next time is taken in the `onOpenChange(true)` handler, never in an effect. Callers keep `added` stable (`useMemo` over the selected names). Picked options keep cmdk's `disabled` prop, so the highlight skips them.
  - **R-F1. Find results.** Ticks are a `Set<name>` updated with functional `setState`. The filtered rows, the toggle label and "None of these can be added" are derived during render. Old ticks merge with new names in the Find success handler. No `useDeferredValue`.
  - **R-H1. Hoisting.** No section component (Runs code, Files, Used by, Provenance, `renderOption`) is ever defined inside another component. Static skeleton rows are hoisted to module scope and sized from counts.
  - **R-B1. Routes and loaders.** Routes are code-split by `autoCodeSplitting: true` in `vite.config.ts`; never add `lazy()` by hand. The loader follows `routes/_app/settings.projects.tsx`: `void qc.prefetchQuery(hostQueryOptions)`, then `await Promise.allSettled([preload ? qc.ensureQueryData(lib) : qc.fetchQuery(lib)])`. The sidebar link relies on the router's `defaultPreload: "intent"`.
  - **R-P1. `content-visibility`.** Not used, because it can break `scrollIntoView({block:"center"})` on arrival. Add it only if the A16 evidence shows slow renders, and say so.
- **Heavy jobs.** At most one evidence pass or full suite at a time, under `/tmp/of-v002-heavy.lock`: `mkdir /tmp/of-v002-heavy.lock` (retry while it exists; write your pid inside), and remove it when done. Never write sleep or wait loops on other agents' processes.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never merge a PR.

## Branches

All work happens in the worktree `/Users/orlevi/projects/open-factory/.worktrees/spec-i5`.

- **Part A, `i5/1-library-skills`:** cut from `spec/i5-skills-and-plugins`, after merging in the latest I3 branch on origin (`i3/claude-sign-in` if it exists, else `spec/i3-claude-sign-in`).
- **Part B, `i5/2-plugins`:** cut from `i5/1-library-skills`. Its implementation (B2 onwards) **waits for Or's Gate G1 result** (Task B1).
- **Part C, `i5/3-polish-docs`:** cut from `i5/2-plugins`. Fold it into Part B if it is small.

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i5
git fetch origin
git merge --no-edit origin/i3/claude-sign-in 2>/dev/null || git merge --no-edit origin/spec/i3-claude-sign-in
git checkout -b i5/1-library-skills
```

Before each push, merge the latest lower branch again (never rebase).

**Commands:**
- one file: `pnpm vitest run <path>`;
- the whole suite: `pnpm test` (heavy; take the lock);
- `pnpm typecheck`, `pnpm lint`, `pnpm build`;
- migrations: `pnpm db:generate`.

## File map

**Shared (`packages/shared/src/`)**

| File | Purpose | Part |
|---|---|---|
| `library.ts` (new) | Patterns, reserved names, `OFFICIAL_MARKETPLACES`, input normalisers (`normalizeRepo`, `normalizeSubpath`, `checkBranchName`, `checkGitUrl`), schemas for every API in spec §9, `SkillGroup`, `SkillEntry`, `ROW_STATE_ORDER`, `cutGraphemes` | A (plugin schemas in B) |
| `settings-keys.ts` (new) | `RESERVED_SETTINGS_KEYS`, `reservedKeysIn(settings, factoryEnvNames)` | A |
| `config-changes.ts` (modify, from I2) | `describeChanges({doc, library}, {doc, library})`, the library lines, `summarizeChanges` counts | A (plugin lines in B) |
| `templates.ts` (modify) | `plugins` removed; `PLUGIN_REF_PATTERN` | B |
| `ws.ts` (modify) | `{ type: "library_changed" }` | A |
| `messages.ts` (modify) | I4 `MSG` constants from spec §10.4 | A |
| `index.ts` | exports | A, B |

**DB (`packages/db/src/schema/`)**

| File | Purpose | Part |
|---|---|---|
| `library.ts` (new) | `skillSources` (A), `marketplaces` (B), as spec §5.1 | A, B |

**Server (`apps/server/src/`)**

| File | Purpose | Part |
|---|---|---|
| `redact.ts` (new; moved from `workspace/plugins.ts`) | `redactOutput` | A |
| `config.ts` | `hostClaudeDir` replaces `hostSkillsDir`; `githubUrl` | A |
| `library/git.ts` (new) | `runGit`, `GIT_FLAGS`, `gitEnv` | A |
| `library/git-fetch.ts` (new) | `resolveRef`, `fetchCommit`, `checkoutSize`, `treeShas`, `installCheckout` | A |
| `library/skill-md.ts` (new) | `readSkillMd(dir)` → `{ name?, description?, hooks[] }` (O_NOFOLLOW, 64 KB) | A |
| `library/library-index.ts` (new) | `LibraryIndex.skills()`, `resolveSkill(name)`, `usedBy` | A |
| `library/forbidden.ts` (new; shared with `mounts.ts`) | `forbiddenSet(ctx)`, `checkSkillFolder(real)` | A |
| `library/sources-service.ts` (new) | preview, add, find, check, update, fetch, remove, restore, purge | A |
| `library/locks.ts` (new) | `libraryLock` (KeyedMutex), `storeLock` (RwLock, B) | A, B |
| `library/library-sweep.ts` (new) | previews > 1 h, soft-delete purge, boot purge | A |
| `library/claude-flags.ts` (new) | `CLAUDE_PLUGIN_FLOOR`, `AUTO_UPDATE_ENV`, `checkClaudeVersion` | B |
| `library/store-runner.ts` (new) | `StoreRunner.run(args, { op })` | B |
| `library/plugin-store.ts` (new) | `installed()`, `marketplaceIndex()`, `install`, `updatePreview`, `update`, journal, provenance | B |
| `library/marketplaces-service.ts` (new) | preview, add, boot repair, `assertMarketplacePinned`, check, update, remove | B |
| `library/plugin-contents.ts` (new) | `readContents(root)` | B |
| `library/host-plugins.ts` (new) | `HostPlugins.list()`, `installInFactory` | B |
| `library/plugin-settings.ts` (new) | `buildPluginSettings(closure, store, registry)` → the `--settings` JSON | B |
| `workspace/links.ts` | `resolveSkills`, prefix set, `.claude-plugin` check | A |
| `workspace/agent-folders.ts` (new) | `scrubAgentFolders`, `checkProjectSettings`, `checkAgentFrontmatter` | A |
| `workspace/mounts.ts` | `skillPaths`; the GitHub-skill class (A); `storeDir` and the store class (B) | A, B |
| `workspace/workspace.ts` | `prepare` steps from spec §7.3; per-agent installs deleted (B) | A, B |
| `workspace/settings.ts` | `buildSettings` loses plugin keys (B) | B |
| `workspace/plugins.ts` | deleted (B) | B |
| `templates/validate.ts` (I2's `validateEffective`) | spec §6.6 and §7.4 rules | A, B |
| `agents/config-resolver.ts`, `agents/config-changes.ts` (from I2) | `Effective.library`; `libraryChanged` | A |
| `runtime/runtime-spec.ts` | `FACTORY_ENV_NAMES` additions; `--settings` arg; seed env | B |
| `routes/library.ts` (new) | spec §9 routes, `requireUser` only | A, B |
| `routes/host-skills.ts` (from I2) | deleted | A |
| `app.ts` | wiring, sweeps, boot repair | A, B |

**Web (`apps/web/src/`)**

| File | Purpose | Part |
|---|---|---|
| `lib/library.ts` (new) | query options, `libraryChanged` invalidation | A |
| `routes/_app/skills.tsx`, `skills.index.tsx` (new); `skills.plugins.tsx`, `skills.marketplaces.tsx` (B) | routes | A, B |
| `features/skills/skills-header.tsx` | header, Check for updates outcome | A |
| `features/skills/skill-list.tsx`, `source-header.tsx`, `row-state.tsx` | lists and states | A |
| `features/skills/peeks/*` (`source-peek.tsx`, `skill-peek.tsx`, `update-view.tsx`, `file-view.tsx`, `use-peek.ts`) | peeks | A |
| `features/skills/peeks/plugin-peek.tsx`, `marketplace-peek.tsx` | peeks | B |
| `features/skills/add-skills-sheet.tsx`, `add-skills-results.tsx` | Add skills | A |
| `features/skills/add-marketplace-sheet.tsx` | Add marketplace | B |
| `features/skills/plugin-list.tsx`, `marketplace-list.tsx` | lists | B |
| `components/untrusted-text.tsx` (new) | `UntrustedCode`, `UntrustedProse`, `visibleControls()` | A |
| `components/ui/combobox.tsx` | a `multiple` mode | A |
| `components/ui/checkbox.tsx` | disabled shapes (decision 21) | A |
| `features/config/sections/skills-plugins.tsx` (from I2) | Library pickers | A (plugins B) |
| `components/app-sidebar.tsx`, `features/shortcuts/global-shortcuts.tsx`, `shortcuts-sheet.tsx`, palette Go to | nav, `g k` | A |
| `features/sheets/sheet-bodies.ts` | `add-skills`, `add-marketplace` kinds | A, B |

---

# Part A: `i5/1-library-skills` (PR 1)

Implements spec §2 AC 1–7, §5, §6, §7.3 step 3, §7.10, §8 (skills), §9.1–§9.2, §9.4–§9.6, §10 (skills), §11.1, and DESIGN.md amendments 1–6.

**Reset step** (stated in the PR body):
- drop the database and recreate agents;
- rename `FACTORY_HOST_SKILLS_DIR` to `FACTORY_HOST_CLAUDE_DIR` in `.env`, pointing at the Claude dir, not at `skills/`.

### Task A1: Shared Library module, reserved keys, WS frame

**Files:**
- Create: `packages/shared/src/library.ts`, `packages/shared/src/settings-keys.ts`
- Modify: `packages/shared/src/ws.ts`, `packages/shared/src/messages.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/library.test.ts`, `packages/shared/src/settings-keys.test.ts`, `packages/shared/src/ws.test.ts`

**Interfaces (produces):**

```ts
export const MARKETPLACE_PATTERN: RegExp; export const RESERVED_MARKETPLACES: readonly string[];
export const OFFICIAL_MARKETPLACES: Record<string, { source: "github"; repo: string }>;
export const PLUGIN_REF_PATTERN: RegExp;
export function normalizeRepo(input: string): { owner: string; repo: string } | null;  // owner/repo or https://github.com/o/r[.git]
export function normalizeSubpath(input: string): string | null;  // "" ok; refuses ".", "..", absolute
export function checkBranchName(b: string): boolean;              // git ref-format rules in TS, refuses "@{", "..", ctrl, ~^:?*[\, leading "-", ".lock"
export function checkGitUrl(u: string): boolean;                  // https only, no userinfo/?/#
export function cutGraphemes(s: string, max: number): string;     // Intl.Segmenter, appends "…"
export const ROW_STATE_ORDER: readonly RowState[];                // spec §10.2 precedence
export type RowState = "adding" | "installing" | "checking" | "add_failed" | "install_failed" | "missing" | "unusable" | "check_failed" | "update" | "hidden" | "not_pinned" | "not_installed";
export const skillSourcePreviewBodySchema, skillSourceAddBodySchema, skillGroupsResponseSchema, skillDetailSchema, sourceDetailSchema;  // spec §9.1–§9.2
// settings-keys.ts
export const RESERVED_SETTINGS_KEYS: readonly string[];  // dotted paths, spec §7.10
export function reservedKeysIn(settings: unknown, factoryEnvNames: readonly string[]): string[];  // the dotted keys set, plus "env.<NAME>" hits
```

- [ ] **Step 1: Write failing tests.** In `library.test.ts`:
  - `normalizeRepo` accepts `acme/x` and `https://github.com/acme/x.git`, and refuses `https://u:t@github.com/a/b`, `…?x`, `…#y`, `git@github.com:a/b`, `https://gitlab.com/a/b`, `./x` and `../x`;
  - `normalizeSubpath` refuses `a/../b`, `/a` and `./a`;
  - `checkBranchName` refuses `main@{-1}`, `a..b`, `-x`, `x.lock` and `a b`;
  - `checkGitUrl` refuses `http://` and URLs with userinfo, `?` or `#`;
  - `MARKETPLACE_PATTERN` plus the reserved list refuse `inline`, `skills-dir`, `synced`, `builtin` and `claude-plugin-test`;
  - `cutGraphemes("a👩‍👩‍👧b", 2)` never splits the family emoji;
  - `ROW_STATE_ORDER` equals the spec's order.

  In `settings-keys.test.ts`:
  - every key listed in spec §7.10 is present;
  - `reservedKeysIn({ hooks: {}, permissions: { defaultMode: "x" }, env: { CLAUDE_CODE_PLUGIN_SEED_DIR: "/x", FOO: "1" } }, ["CLAUDE_CODE_PLUGIN_SEED_DIR"])` returns `["env.CLAUDE_CODE_PLUGIN_SEED_DIR", "hooks", "permissions.defaultMode"]` (sorted).

  In `ws.test.ts`: `library_changed` parses.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/library.test.ts packages/shared/src/settings-keys.test.ts packages/shared/src/ws.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `RESERVED_SETTINGS_KEYS` holds the spec §7.10 list verbatim: `enabledPlugins`, `extraKnownMarketplaces`, `syncClaudeAiPlugins`, `strictKnownMarketplaces`, `permissions.defaultMode`, `permissions.additionalDirectories`, `claudeMdExcludes`, `hooks`, `statusLine`, `fileSuggestion`, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` and `otelHeadersHelper`.
  - Before committing, re-read the shipped Claude Code's settings reference (`curl -sL https://code.claude.com/docs/en/settings-reference.md`, reading only). Add any other key marked "Any file" that runs a command or executable, then pin the list in the test.
  - Add a doc comment saying that I7's `agent` policy reuses this constant.
  - Add the spec §10.4 messages to `MSG`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm vitest run packages/shared/src/messages.test.ts` (I4's length tests).
- [ ] **Step 5: Commit** `feat(shared): Library schemas, patterns and reserved settings keys`.

### Task A2: `skill_sources` table and config rename

**Files:**
- Create: `packages/db/src/schema/library.ts`, the generated migration
- Modify: `packages/db/src/schema/index.ts`, `apps/server/src/config.ts`, `apps/server/src/config.test.ts`, `README.md`, `.env.example`, `apps/server/scripts/smoke-*.ts` (8 files), `apps/server/src/test/helpers.ts`, and every `hostSkillsDir` use
- Test: `apps/server/src/config.test.ts`, `packages/db/src/schema/library.test.ts`

**Interfaces (produces):**
- `config.hostClaudeDir: string` (`FACTORY_HOST_CLAUDE_DIR`, default `~/.claude`, resolved with I6's `expandHome`);
- `config.githubUrl: string` (`FACTORY_GITHUB_URL`, default `https://github.com`);
- the `skillSources` Drizzle table with exactly the spec §5.1 columns, plus `state: "ready" | "adding"` and `startedAt`, so a GitHub add that must re-fetch can show a pending header (spec §10.4).

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`: `FACTORY_HOST_CLAUDE_DIR: "~/c"` gives `hostClaudeDir === join(home, "c")`, and `FACTORY_HOST_SKILLS_DIR` is no longer read (an env holding only it leaves the default).
  - `library.test.ts` (schema, CI only): insert, then read back, a GitHub row with `skills: ["a"]` and `trees`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Rename the config field and fix every user: grep `hostSkillsDir|FACTORY_HOST_SKILLS_DIR` and update the 8 smoke scripts, the test helpers, `.env.example` and the README row. There is no warning for the old name (ADR 0028).
  - Add the table, then run `pnpm db:generate`.
- [ ] **Step 4: Run** `pnpm vitest run apps/server/src/config.test.ts` and `pnpm typecheck`. Expected: PASS. The schema test runs in CI.
- [ ] **Step 5: Commit** `feat: skill_sources table; FACTORY_HOST_CLAUDE_DIR replaces FACTORY_HOST_SKILLS_DIR`.

### Task A3: `redact.ts` and the hardened `runGit`

Implements spec §6.2 Runner.

**Files:**
- Create: `apps/server/src/redact.ts`, `apps/server/src/library/git.ts`
- Modify: `apps/server/src/workspace/plugins.ts` (import `redactOutput` from `../redact.ts`)
- Test: `apps/server/src/library/git.test.ts`, `apps/server/src/redact.test.ts` (move the existing redaction cases)

**Interfaces (produces):**

```ts
export const GIT_FLAGS: (o: { allowFile: boolean }) => string[];  // the spec §6.2 -c list, in order
export function gitEnv(server: NodeJS.ProcessEnv): Record<string, string>;  // PATH, HOME, GIT_TERMINAL_PROMPT=0, GIT_CONFIG_NOSYSTEM=1, GIT_ASKPASS="", GIT_LFS_SKIP_SMUDGE=1
export class GitError extends Error { constructor(message: string, readonly output: string) }
export async function runGit(args: string[], o: { cwd: string; allowFile: boolean; timeoutMs?: number; signal?: AbortSignal; gitBin?: string }): Promise<{ stdout: string }>;
```

- [ ] **Step 1: Write failing tests.** Use a fake `git` script in a temp `bin` on `PATH` that writes `argv` and `env` to a JSON file.
  - The argv starts with exactly `GIT_FLAGS({ allowFile: false })`, and `protocol.file.allow=always` appears only when `allowFile` is true.
  - The env keys are exactly the six named. A host `GIT_DIR` / `GIT_CONFIG_COUNT` set in `process.env` doesn't pass.
  - An argument starting with `-` that isn't from `GIT_FLAGS` is refused before spawn. Callers pass options through `o`, not `args`; `fetch --depth 1` is built inside `git-fetch.ts` by a whitelist.
  - A failing fake that prints `https://u:tok@host` and `ghp_abc` rejects with `GitError` whose output contains neither.
  - A command that sleeps past `timeoutMs` is killed.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/git.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `execFile` (never a shell). The cwd is `mkdtemp(tmpdir(), "of-git-")`, removed in `finally` when `runGit` created it. Keep the last 20 lines, at most 4 KB, redacted.
- [ ] **Step 4: Run** the test, plus `pnpm vitest run apps/server/src/redact.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): hardened git runner and shared redaction`.

### Task A4: GitHub fetch into the cache

Implements spec §6.2 Resolve, Fetch, Check and Store, plus §6.3's tree shas.

**Files:**
- Create: `apps/server/src/library/git-fetch.ts`, `apps/server/src/library/testing/fixture-repo.ts` (builds a local git repo for tests and evidence)
- Test: `apps/server/src/library/git-fetch.test.ts`

**Interfaces (produces):**

```ts
export function repoUrl(base: string, r: { owner: string; repo: string }): string;  // `${base}/${owner}/${repo}.git`
export async function resolveRef(url: string, branch: string | null, o): Promise<{ sha: string; branch: string }>;  // exact-match line only; HEAD + --symref for the name
export async function fetchCommit(url: string, sha: string, into: string, o): Promise<{ committedAt: string; subject: string }>;  // init, fetch --depth 1 --no-tags, checkout --detach FETCH_HEAD, verify HEAD
export async function treeShas(co: string, sha: string, paths: string[]): Promise<Record<string, string>>;
export async function checkoutSize(dir: string, capBytes: number): Promise<number>;  // lstat walk, throws "over_cap"
export async function installCheckout(co: string, subpath: string, dest: string): Promise<void>;  // copy subtree minus .git via temp+rename, chmod -R a-w
// fixture-repo.ts
export async function makeFixtureRepo(dir: string, spec: { commits: Array<Record<string, string | { symlink: string } | { gitlink: true } | { bytes: number }>> }): Promise<{ url: string; shas: string[] }>;
```

- [ ] **Step 1: Write failing tests.** Use `makeFixtureRepo` in a temp dir with `allowFile: true`.
  - `resolveRef` takes the exact `refs/heads/main` line, never a decoy branch named `x/refs/heads/main`, and returns the default branch's name for `null`.
  - `fetchCommit` returns the subject and date, and a fake `git` that returns another commit makes it fail with "didn't return commit".
  - A symlink in the repo arrives as a regular file; a gitlink arrives as an empty dir.
  - `checkoutSize` with a 51 MB blob throws `over_cap`.
  - A subpath escaping through `..` is refused (a lexical check plus `realpath`).
  - `installCheckout` leaves dirs 0555 and files 0444, and `.git` is absent.
  - `treeShas` with an empty subpath joins without a leading slash (`<sha>:skill`).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/git-fetch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified in spec §6.2.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): pinned GitHub fetch into a read-only cache`.

### Task A5: `LibraryIndex` and the skill rules

Implements spec §5.2, §5.3 and §6.6.

**Files:**
- Create: `apps/server/src/library/skill-md.ts`, `apps/server/src/library/library-index.ts`
- Test: `apps/server/src/library/skill-md.test.ts`, `apps/server/src/library/library-index.test.ts` (the `usedBy` part runs in CI only)

**Interfaces (produces):**

```ts
export async function readSkillMd(dir: string): Promise<{ name?: string; description?: string; hooks: HookDecl[] } | null>;  // O_NOFOLLOW, 64 KB
export type ResolveFail = "not_added" | "missing" | "hidden" | "unusable";
export class LibraryIndex {
  constructor(d: { db; hostClaudeDir: string; factoryHome: string; templates: TemplateIndex });
  skills(): Promise<SkillGroup[]>;  // spec §5.3 order: host, sources, template groups, unknown
  resolveSkill(name: string): Promise<{ ok: true; name: string; dir: string; ref: string } | { ok: false; reason: ResolveFail; detail?: string }>;
  usedBy(name: string): Promise<{ templates: string[]; agents: string[] }>;
}
```

- [ ] **Step 1: Write failing tests** (a temp host dir and temp `FACTORY_HOME`):
  - host discovery skips `x.zip`, folders without `SKILL.md`, and names failing `HOST_SKILL_PATTERN`;
  - a frontmatter `name: bar` in folder `foo` is `unusable` ("SKILL.md names it bar");
  - a folder holding `.claude-plugin/` is `unusable` ("It's a plugin; add it through a marketplace");
  - a picked folder-source skill replaced by a link is `unusable` ("It's a link"), and a deleted one is `missing`;
  - a registered GitHub skill named `tdd` makes host `tdd` `hidden`, and `resolveSkill("tdd")` returns the GitHub dir;
  - a missing GitHub cache dir is `missing`;
  - a name listed by a template but resolving nowhere appears in the `unknown` group with its users (CI);
  - a description longer than 200 characters is cut with "…";
  - `readSkillMd` refuses a symlinked `SKILL.md` and parses frontmatter `hooks`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/skill-md.test.ts apps/server/src/library/library-index.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the `yaml` package (already a dependency) for frontmatter. Discovery is live on every call, with no cache.
- [ ] **Step 4: Run.** Expected: PASS (`usedBy` in CI).
- [ ] **Step 5: Commit** `feat(server): LibraryIndex with live discovery and the unusable rules`.

### Task A6: Forbidden set, skill folder check, mount class

Implements spec §6.1 (folder check) and §6.5 (only the GitHub-skill class in PR 1).

**Files:**
- Create: `apps/server/src/library/forbidden.ts`
- Modify: `apps/server/src/workspace/mounts.ts` (use `forbiddenSet`; take `skillPaths`; add the GitHub-skill class)
- Test: `apps/server/src/library/forbidden.test.ts`, `apps/server/src/workspace/mounts.test.ts`

**Interfaces (produces):**
- `forbiddenSet(ctx: { home: string; factoryHome: string; dockerSockets: string[] }): Promise<{ path: string; name: string }[]>`
- `checkSkillFolder(real: string, ctx): Promise<void>`, which throws `FieldError("path", MSG.shareHome | MSG.shareFactory | MSG.shareFolder)`
- `buildMounts({ …, skillPaths: string[] })`, replacing `hostSkillPaths`
- `MountCheckContext.factoryHome` used for the class `join(realpath(<FH>/state/library/github), id, sha[, name])`, with an lstat walk from `<FH>/state`

- [ ] **Step 1: Write failing tests** (default layout with `FACTORY_HOME` under a temp `HOME`):
  - `checkSkillFolder` refuses `~`, an ancestor of `~`, `FACTORY_HOME/x` and an ancestor of `FACTORY_HOME`, and allows `~/code/skills`;
  - mounts: a GitHub skill dir mounts read-only;
  - `state/library/github` swapped for a link to `~/.ssh` is refused;
  - a `<sha>` dir swapped for a link to `state/agents/bob` is refused;
  - `…/<id>` (one level up) is refused;
  - `state/` is refused;
  - every existing `mounts.test.ts` case still passes. PR 1 keeps the agent's own `pluginsDir` class.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/forbidden.test.ts apps/server/src/workspace/mounts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the forbidden-set logic from `checkMounts` into `forbiddenSet` and use it in both places. The refusal text becomes "… isn't this agent's workdir, a registered skill or the plugin store".
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): skill folder check and the GitHub skill mount class`.

### Task A7: Skill sources service, locks and sweep

Implements spec §6.1, §6.3, §9.2, §9.4 and §9.6.

**Files:**
- Create: `apps/server/src/library/locks.ts`, `apps/server/src/library/sources-service.ts`, `apps/server/src/library/library-sweep.ts`
- Test: `apps/server/src/library/sources-service.test.ts` (CI), `apps/server/src/library/library-sweep.test.ts` (CI)

**Interfaces (produces):**

```ts
export const libraryLock: KeyedMutex;  // own instance
export class SourcesService {
  preview(b: SkillSourcePreviewBody, by: string): Promise<SourcePreview>;  // folder: resolveHostFolder + checkSkillFolder; github: resolveRef + fetchCommit into state/library/preview/<uuid>/
  add(b: SkillSourceAddBody, by: string): Promise<{ status: 201 | 202; source: SourceDetail }>;  // libraryLock; re-check names/states; move preview or re-fetch (202, state "adding")
  find(id: string): Promise<SourcePreview>; addSkills(id: string, skills: string[], by: string): Promise<SourceDetail>;
  check(id: string): Promise<SourceDetail>;                 // ls-remote; preview fetch; update* or checkError
  checkAll(): Promise<void>;                                // all github sources (+ marketplaces in B), 4 at a time
  update(id: string, commit: string, by: string): Promise<SourceDetail>;  // 409 update_drops_used | empties_source
  refetch(id: string): Promise<SourceDetail>;
  remove(id: string): Promise<{ undoUntil: string }>;       // 409 in_use (≤3 users named); soft delete
  restore(id: string): Promise<SourceDetail>;               // refused after window or name taken
}
export class LibrarySweep { start(): void; stop(): Promise<void>; bootPurge(): Promise<void>; }  // previews > 1 h; soft-deleted past window; skip dirs referenced by loaded runtimes' started.library
```

After `update` and `restore` release `libraryLock`, they call `configChanges.libraryChanged({ skills, by })` (Task A9).

- [ ] **Step 1: Write failing tests** (CI, fixture repo):
  - preview lists every subfolder with its reason ("taken" with `takenBy`, "unusable", "link");
  - add refuses a taken name or an unusable skill;
  - add from an expired preview re-fetches and returns 202;
  - a folder preview of `~` gives the field error `MSG.shareHome`;
  - check stores `update*`; a failing check stores `checkError`;
  - update reports "changed" from `trees`;
  - a changed skill whose `SKILL.md` frontmatter `hooks` were added or changed, or whose executable files (exec bit) were added or changed, is flagged `runsCodeChanged: true` with the hook and file lists (owner plan review change 3). The update preview reads both trees' `SKILL.md` and exec bits from the fetched commits;
  - update refuses `update_drops_used` (naming at most 3 users, then "and N more") and refuses `empties_source`;
  - remove is refused while in use;
  - restore works within 30 s, is refused after 30 s, and is refused once a name has been taken;
  - boot purge removes rows past their window; a cache dir referenced by a loaded runtime is kept;
  - `checkAll` never runs more than 4 at once (a fake `runGit` counts concurrency).
- [ ] **Step 2: Run** `pnpm typecheck`. Expected: FAIL (the service is missing). The DB tests run in CI.
- [ ] **Step 3: Implement.** The lock order is workspace → Library → store, and the code holding `libraryLock` never awaits a runtime job.
- [ ] **Step 4: Run** `pnpm typecheck` (PASS), then push to read CI.
- [ ] **Step 5: Commit** `feat(server): skill sources with pins, updates, Undo and sweeps`.

### Task A8: Library routes; delete `/api/host-skills`

Implements spec §9.1, §9.2, §9.4, §9.5 and §11.1.

**Files:**
- Create: `apps/server/src/routes/library.ts`
- Delete: `apps/server/src/routes/host-skills.ts` and its test (from I2)
- Modify (web; implementer and reviewer invoke `vercel-react-best-practices` and follow it): I2's host-skills reader in `apps/web/src/features/config/` is switched to `libraryQueryOptions` here, so `/api/host-skills` has no web caller left (A14 then replaces the picker itself)
- Modify: `apps/server/src/app.ts` (registration, `LibrarySweep`, the `library_changed` publish)
- Test: `apps/server/src/routes/library.test.ts` (CI)

**Interfaces (produces):**
- `GET /api/library/skills`
- `GET /api/library/skills/:group/:name`
- `GET /api/library/skills/:group/:name/file?path=`
- `GET /api/library/sources/:id`
- `POST /api/library/sources/preview`
- `POST /api/library/sources`
- `POST …/:id/find`, `…/:id/add`, `…/:id/check`, `…/:id/update`, `…/:id/fetch`, `…/:id/restore`
- `DELETE …/:id`
- `POST /api/library/check`

All of them are `requireUser` only. Every write publishes `{ type: "library_changed" }` to all users.

- [ ] **Step 1: Write failing tests** (CI):
  - every route returns 401 without a session and 401 with an agent bearer token;
  - the MCP tool list contains no Library tool;
  - the file route refuses a link, a binary file and a path outside the skill;
  - a write publishes `library_changed`;
  - `/api/host-skills` is 404.
- [ ] **Step 2: Run** `pnpm typecheck`. Expected: FAIL.
- [ ] **Step 3: Implement.** Responses are parsed with the shared schemas. Field errors use I4's `fields` shape.
- [ ] **Step 4: Run** `pnpm typecheck` (PASS). CI covers the rest.
- [ ] **Step 5: Commit** `feat(server): Library routes for skills; drop host-skills`.

### Task A9: Effective library, validation, linking, start checks, change flow

Implements spec §6.4, §6.6, §7.3 step 3, §7.10, §8 and AC 5–7.

**Files:**
- Create: `apps/server/src/workspace/agent-folders.ts`
- Modify:
  - `apps/server/src/workspace/links.ts`;
  - `apps/server/src/workspace/workspace.ts` (`prepare`);
  - `apps/server/src/templates/validate.ts` (`validateEffective`);
  - `apps/server/src/agents/config-resolver.ts`, `apps/server/src/agents/config-changes.ts`;
  - `packages/shared/src/config-changes.ts`.
- Test:
  - `apps/server/src/workspace/agent-folders.test.ts`, `apps/server/src/workspace/links.test.ts`;
  - `apps/server/src/templates/validate.test.ts`;
  - `packages/shared/src/config-changes.test.ts`;
  - `apps/server/src/agents/config-changes.test.ts` (CI).

**Interfaces (produces):**

```ts
// agent-folders.ts
export async function scrubAgentFolders(workdir: string): Promise<void>;            // empty .claude-config/{skills,agents,commands} via SafeFs
export async function checkProjectSettings(workdir: string, envNames: readonly string[]): Promise<void>;  // .claude/settings.json + settings.local.json; lstat; link fails; reservedKeysIn → WorkspaceError naming file and key
export async function checkAgentFrontmatter(workdir: string, factoryLinks: Set<string>): Promise<void>;   // non-factory .claude/skills/*/SKILL.md hooks; .claude/agents/*.md hooks|mcpServers; .claude/commands/*.md hooks
export async function checkSkillPlugins(workdir: string): Promise<void>;           // every .claude/skills entry: stat(<entry>/.claude-plugin) → fail
// links.ts
export async function resolveSkills(lib: LibraryIndex, names: string[]): Promise<{ name: string; dir: string }[]>;  // fails with the §6.6 message for the reason
// config-resolver.ts: Effective gains
library: { skills: Record<string, string>; plugins: Record<string, string> };  // plugins {} in PR 1
// shared config-changes.ts
export function describeChanges(a: { doc: ConfigDoc; library: Library }, b: { doc: ConfigDoc; library: Library }): string[];
// config-changes.ts (server)
libraryChanged(e: { skills?: string[]; plugins?: string[]; by: string }): Promise<void>;
```

- [ ] **Step 1: Write failing tests.**
  - `agent-folders.test.ts`:
    - `settings.local.json` with `{ "hooks": {} }` fails with "….claude/settings.local.json sets hooks, which agents can't set; remove it.";
    - the test iterates **every** key in `RESERVED_SETTINGS_KEYS` for both files;
    - `env.CLAUDE_CODE_PLUGIN_SEED_DIR` fails, and `env.FOO` passes;
    - a link at `.claude/settings.json` fails;
    - an agent-written skill folder whose `SKILL.md` declares `hooks` fails, while a factory link to a Library skill with hooks passes;
    - `.claude/agents/a.md` with `hooks` fails, and so does one with `mcpServers`;
    - `.claude/commands/c.md` with frontmatter `hooks` fails (owner plan review change 5; kept even if G1 shows commands can't declare hooks, since the check is cheap and stays closed);
    - `.claude-config/{skills,agents,commands}` are emptied, and a link there is removed as a link;
    - a `.claude/skills/x` link the agent made to a folder holding `.claude-plugin/` fails.
  - `links.test.ts`: the drop-unlisted pass removes links under every known prefix and leaves a real folder.
  - `validate.test.ts`: each §6.6 message, and the template-local collision in templates and overlays.
  - `config-changes.test.ts` (shared): "skill x updated a1b2c3d → e4f5a6b", "skill x now from GitHub", and a library-only difference is non-empty.
  - Server `config-changes.test.ts` (CI): a GitHub update writes `config_changed` and requests a restart only for agents using the skill, compared against `started.library`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/agent-folders.test.ts apps/server/src/workspace/links.test.ts apps/server/src/templates/validate.test.ts packages/shared/src/config-changes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `prepare`, the order is:
  1. resolve and link skills;
  2. `checkSkillPlugins`;
  3. `scrubAgentFolders`;
  4. `checkProjectSettings`;
  5. `checkAgentFrontmatter`;
  6. the rest as I2 has it.

  `Effective.library.skills` comes from `resolveSkill` refs.
- [ ] **Step 4: Run.** Expected: PASS (the CI parts in CI).
- [ ] **Step 5: Commit** `feat(server): Library skills at start, reserved settings and frontmatter checks, library change flow`.

### Task A10: Web primitives: untrusted text, checkbox, multi Combobox

Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/components/untrusted-text.tsx`
- Modify: `apps/web/src/components/ui/checkbox.tsx`, `apps/web/src/components/ui/combobox.tsx`
- Test: `apps/web/src/components/untrusted-text.test.tsx`, `apps/web/src/components/ui/checkbox.test.tsx`, `apps/web/src/components/ui/combobox.test.tsx`

**Interfaces (produces):**
- `visibleControls(s: string): string`, which maps U+202A–202E, U+2066–2069, zero-width characters and C0 controls to `⟨U+XXXX⟩` / `⟨ESC⟩`;
- `<UntrustedCode text clampLines? fromTop />`: mono, `pre-wrap`, `overflow-wrap:anywhere`, `unicode-bidi:isolate`, `dir="ltr"`, with the 40-line clamp from the top and "Show all · N lines";
- `<UntrustedProse text />`: Geist, `dir="auto"`, isolate;
- `Combobox` gains `multiple?: { added: Set<string>; announce: (label: string) => void }`:
  - picking keeps the popover open;
  - a picked option gets `aria-disabled` and "Added";
  - the highlight moves to the next enabled option;
  - placement locks on the first pick;
  - never `aria-multiselectable`;
  - the trigger is supplied by the caller (`trigger` prop);
- `Checkbox` disabled shapes: unchecked is a rule box with a muted border, checked is an `ink-muted` fill, with no opacity.

- [ ] **Step 1: Write failing tests.**
  - `visibleControls("a‮b")` returns `"a⟨U+202E⟩b"`.
  - `UntrustedCode` with 100 lines shows the first 40 and "Show all · 100 lines", and renders no `<a>` for a URL.
  - The multi Combobox:
    - Enter adds and stays open;
    - the option is still in the list with `aria-disabled="true"` and the text "Added";
    - the highlight is on the next option;
    - the listbox has no `aria-multiselectable`;
    - `announce` is called with "Added tdd".
  - Checkbox: disabled + checked has no `opacity-50` class.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/components/untrusted-text.test.tsx apps/web/src/components/ui/checkbox.test.tsx apps/web/src/components/ui/combobox.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The single-value Combobox behaves exactly as before (existing tests keep passing). The live region is rendered by the caller, outside the popover.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): untrusted text, disabled checkbox shapes and a multi-pick Combobox mode`.

### Task A11: Skills route, header, nav, lists and states

Implements spec §10.1, §10.2, §10.7 and §10.8 (skills). Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create:
  - `apps/web/src/lib/library.ts`;
  - `apps/web/src/routes/_app/skills.tsx`, `apps/web/src/routes/_app/skills.index.tsx`;
  - `apps/web/src/features/skills/skills-header.tsx`, `skill-list.tsx`, `source-header.tsx`, `row-state.tsx`.
- Modify:
  - `apps/web/src/components/app-sidebar.tsx`;
  - `apps/web/src/features/shortcuts/global-shortcuts.tsx`, `shortcuts-sheet.tsx`;
  - the palette Go to group;
  - `apps/web/src/lib/ws.ts` (`library_changed` → invalidate `["library"]`).
- Test:
  - `apps/web/src/features/skills/skill-list.test.tsx`, `skills-header.test.tsx`;
  - `apps/web/src/test/shell.test.tsx` (the nav item and `g k`).

**Interfaces (produces):**
- `libraryQueryOptions`, `skillQueryOptions(group, name)`, `sourceQueryOptions(id)`;
- `<RowState state since? />`, which maps `ROW_STATE_ORDER` to its icon and colour per spec §10.2 and shows elapsed time from the server's `since` after 10 s;
- `useLibraryArrival()`, which reads `{ peek }` from router state, scrolls the row to the centre, focuses it with the arrival tint, and opens its peek.

- [ ] **Step 1: Write failing tests.**
  - `skill-list.test.tsx`:
    - groups render in order: Host, each source, Template `dev`, Unknown;
    - each group is a `ul` labelled by the source name span;
    - rows are buttons with `aria-haspopup="dialog"` and `aria-expanded`;
    - `j`/`k` move between source headers and rows;
    - "Not used" shows; "Used by 2 agents" leaves out zero kinds;
    - "190 agents" uses NBSP;
    - the highest state wins by precedence;
    - the empty state shows `<hostDir>/skills` from the API;
    - the error state shows "Couldn't load skills." with Retry.
  - `skills-header.test.tsx`:
    - in PR 1 there is no view switch;
    - "Check for updates" calls `POST /api/library/check`, and the outcome line reads "Checked 12 sources · 2 updates · 1 couldn't be reached" from mocked server state;
    - below `sm` the actions are icon-only, with aria-labels.
  - `shell.test.tsx`: the Skills nav item sits between Templates and Schedules; `g k` navigates; `g s` still opens Schedules.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills apps/web/src/test/shell.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The route loader prefetches `libraryQueryOptions` and, without awaiting, `hostQueryOptions`.
  - No effect fetches, and no derived state is held in an effect.
  - At ≥54rem of container, the peek gets the `@container` + `@[54rem]:data-[open]:pr-[30rem]` treatment.
  - F6 moves into the peek (the `task-list.tsx` pattern).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Skills page, nav and grouped skill list`.

### Task A12: Source and skill peeks, update view, View file

Implements spec §10.3 (skill and source peeks) and §10.6. Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/skills/peeks/use-peek.ts`, `source-peek.tsx`, `skill-peek.tsx`, `update-view.tsx`, `file-view.tsx`
- Test: `apps/web/src/features/skills/peeks/source-peek.test.tsx`, `skill-peek.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - The Source peek:
    - the update view is open when `updateCommit` is set;
    - a skill with `runsCodeChanged` shows "Runs code changed" first, with its hooks and executables as `+`/`−` lines;
    - the changes show as `+`/`−` lines, and the compare link has `rel="noreferrer"` and `target="_blank"`;
    - "Update to e4f5a6b" posts the update;
    - a 409 shows in the outcome line with linked users;
    - "Remove source (40 skills)" is `aria-disabled` with `aria-describedby` pointing at the in-use reason;
    - after remove, focus goes to the next source header and the toast shows Undo for `undoUntil − now`;
    - Find more skills expands the results inline, with no toast and no Undo;
    - the pin copy button copies the full sha.
  - The skill peek:
    - the "From" line per group, plain text when you came from that Source peek;
    - "Runs code" lists frontmatter hooks first;
    - the Files list collapses past 20;
    - View file is one `aria-expanded` toggle that opens from line 1;
    - "Used by" is grouped by template and collapses past 8.
  - A U+202E hook command renders `⟨U+202E⟩`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills/peeks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - A peek renders from the cached list row first, then refines from the detail query.
  - Keyboard opening and retarget are instant; a click uses the sheet motion.
  - Back is instant and refocuses the row it came from; Esc closes the whole peek.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): source and skill peeks with in-place updates`.

### Task A13: Add skills sheet

Implements spec §10.4 (Add skills). Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create: `apps/web/src/features/skills/add-skills-sheet.tsx`, `add-skills-results.tsx`
- Modify: `apps/web/src/features/sheets/sheet-bodies.ts` (kind `add-skills`, prefetch `hostQueryOptions`)
- Test: `apps/web/src/features/skills/add-skills-sheet.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - Folder mode uses `PathField`; GitHub mode shows the three fields with the spec's help text.
  - Field errors are the I4 constants of at most 40 characters ("Can't share your home folder.", "No such branch.", "Couldn't reach this repo.").
  - After Find:
    - focus is on "Found 12 skills" (`tabindex=-1`);
    - the primary stays inert for 300 ms;
    - "Found at a1b2c3d · main · …" shows;
    - unpickable rows are disabled with their reasons;
    - the Select all / none toggle acts on filtered rows;
    - a filter field appears past 20 rows.
  - Editing the repo marks the results stale and keeps the ticks by name on the next Find.
  - "None of these can be added." shows when every row is unpickable.
  - Add shows "Added 3 skills." with Undo; a 202 shows a pending source header.
  - Close during Find aborts the request (the `AbortSignal` is asserted) and keeps the draft.
  - On phones there is a single scroller (no nested `overflow-auto` in the list).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills/add-skills-sheet.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with `FormFrame`, `useFieldErrors` and `FormOutcome`. The request's `AbortController` is owned by the sheet and aborted on close.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Add skills sheet with find, pick and stale results`.

### Task A14: Skill picker in the Configuration form

Implements spec §10.5 (skills). Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/config/sections/skills-plugins.tsx` (I2), `apps/web/src/features/config/config-list.tsx` (I2: a source tag, pin and state on a row; a `labelAction` slot)
- Test: `apps/web/src/features/config/sections/skills-plugins.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - The ghost "Add skill" sits in the "This agent" label row (agent mode) or the list label row (template mode).
  - Options are grouped by source with `MiddleTruncate` headings.
  - Picking keeps the popover open, marks the option "Added", and announces "Added tdd" from a live region outside the popover.
  - A reopened popover leaves out picked skills.
  - Hidden, unusable and missing skills, and names matching the template's local skills, are left out, with the footer "3 skills can't be used here: hidden or unusable."
  - A selected row shows "GitHub · a1b2c3d" and any state.
  - Template-local skills are read-only "Template skill".
  - The plugins input stays as I2 built it, until Task B11.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Library skill picker in the Configuration form`.

### Task A15: DESIGN.md amendments (PR 1)

- [ ] Apply spec §16 amendments 1–6 to `DESIGN.md`, verbatim. Amendment 3 covers skills and files now, plugins later. Commit `docs: DESIGN.md amendments for the Skills page`.

### Task A16: Finish PR 1

- [ ] **Branch review.** A fresh reviewer, read-only, on `git diff spec/i5-skills-and-plugins...i5/1-library-skills` against spec §5, §6, §7.3 step 3, §7.10, §8–§10 and AC 1–7. It checks:
  - ADR 0028: no compatibility code, and no warning for the old env var;
  - hardened runners: argv, env and redaction tests present;
  - the I4 message rules;
  - **the React diff against `vercel-react-best-practices`**: the reviewer invokes the skill first. Next-only rules are skipped, and the review says so. It covers effects only for external sync, no fetch in effects, stable query keys, no components defined inside components, abort on unmount for Find, and loaders that never await the host query, plus every R-Q, R-E, R-L, R-C, R-F, R-H, R-B and R-P rule in Global Constraints. This checklist is reused by B12 and C3.

  Apply fixes as their own commits (apps/web fixes follow `vercel-react-best-practices`).
- [ ] **Full verification** under `/tmp/of-v002-heavy.lock`:
  - `pnpm install --frozen-lockfile` (no lockfile change), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`;
  - the dev loop from a clean clone: `git clone` the branch into a temp dir, `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm dev` with a throwaway DB, fake Claude, a temp `FACTORY_HOST_CLAUDE_DIR` holding one skill and `FACTORY_GITHUB_URL=file://<fixture>`;
  - load `/skills`, then shut down and remove the clone.

  DB tests: confirm them in CI.
- [ ] **Real-browser evidence.** Use the harness at `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness` through its `run.sh` lock, plus `/tmp/of-v002-heavy.lock`. Fake Claude only, and the fixture repo through `FACTORY_GITHUB_URL=file://…` (built with `makeFixtureRepo`), never the network. Chromium and WebKit headless.
  - Add `i5a_*.py` checks for AC 1–7.
  - Widths: 1440, 1024, 390 and 375px, plus 390px at 200% text, in light and dark.
  - Worst-case data from spec §14: a 40-skill source, a 64-character name, 190 users, zero-found and all-unpickable repos, a failing check, a 200-character subject ending in an emoji, a 120-character path.
  - Measure and record the §10.1 header thresholds.
  - Screenshots and a results table go to `docs/product/ui-review/i5-evidence/` in the main checkout (gitignored).
- [ ] **Push and PR.**
  - `git fetch origin`, merge the latest I3 branch, push `i5/1-library-skills`.
  - Open a **draft** PR with base = `i3/claude-sign-in` if it exists, else `spec/i3-claude-sign-in` (note that it should be retargeted).
  - Title: `feat: skills Library with host, folder and pinned GitHub sources`.
  - Body per `.github/pull_request_template.md`, linking the spec, this plan and #153. State the reset step, the env rename, the deletion of `/api/host-skills`, and that DB tests run only in CI. End with the attribution line.
  - Run `gh pr checks --watch` until green, fixing failures on the branch. Never merge.

---

# Part B: `i5/2-plugins` (PR 2)

Implements spec §2 AC 8–14, §7, the plugin parts of §8–§10, §11 and §13. Cut it with `git checkout -b i5/2-plugins i5/1-library-skills`.

**Reset step:**
- drop the database and recreate agents;
- templates listing `plugins:` fail validation: move them to `settings.json` `enabledPlugins`, and add their marketplaces in Skills.

### Task B0: Pin the base image's Claude Code (before G1)

Implements owner plan review change 2. G1 must run on the exact version the image ships, and an image that takes "latest" at build time is itself a supply-chain gap.

Today `images/base/Dockerfile` already installs an exact `CLAUDE_CODE_VERSION`, verified against the release manifest's sha256, and labels it as `io.open-factory.claude-code.version`. But `.github/workflows/base-image.yml` resolves that version from `downloads.claude.ai/.../latest` on every build, including the weekly rebuild.

**Files:**
- Create: `images/base/claude-code-version` (one line, e.g. `2.1.3xx`)
- Modify: `.github/workflows/base-image.yml` (the "Resolve latest Claude Code version" step reads the file; the weekly no-cache rebuild keeps the pinned version)
- Modify: `apps/server/src/library/claude-flags.ts` gets `CLAUDE_PLUGIN_FLOOR` in B3; until then the planned floor is this pinned version.

- [ ] **Step 1: Choose the version.** It must meet all three:
  - at or above the documented floor features (seed, `syncClaudeAiPlugins`, `mcpb/`, dependency auto-install, so at least 2.1.324);
  - at least 14 days old (the repo's minimum-release-age policy, applied to the CLI too);
  - the newest version that meets both.
  
  If the newest release is younger than 14 days, take the newest one that isn't and say so in the PR body. Record the release date from the release manifest.
- [ ] **Step 2:** Make the workflow read `images/base/claude-code-version`, validate it against `^[0-9]+\.[0-9]+\.[0-9]+$`, and fail on anything else. Delete the "latest" resolution (ADR 0028: no fallback). Update the workflow comment "Weekly no-cache rebuild: new Claude Code, …" to say Claude Code is pinned and changes only through this file.
- [ ] **Step 3:** `actionlint` if installed; otherwise review the YAML diff. CI builds the image on the PR.
- [ ] **Step 4: Commit** `chore(image): pin the base image's Claude Code version`.

The image label already exists, so #160 keeps only the docs.

### Task B1: Gate G1 script and fixture recipe (for Or; blocks B2 onward)

Implements spec §13. **The executor writes the script but never runs it.** Running it needs real Claude Code and Or.

**Files:**
- Create: `scripts/g1/run.sh`, `scripts/g1/fixture/README.md`, `scripts/g1/fixture/make-fixture.sh`, `scripts/g1/report-template.md`

- [ ] **Step 1:** Write `make-fixture.sh`. It builds the fixture marketplace tree, to be pushed by Or to a throwaway GitHub repo (`<or>/of-g1-fixture`):
  - **`marker`**, with every code path writing to `$MARK`: a SessionStart hook; an MCP server that also writes `${CLAUDE_PLUGIN_DATA}/x`; `bin/x`; a monitors entry; and a `package.json` with one real registry dependency, a lockfile and `preinstall`/`postinstall` scripts;
  - **`dep`**, an exact dependency of `marker`;
  - **`ranged`**, with a version-range dependency;
  - **a second commit** that changes `marker`;
  - **a local directory marketplace** with a relative plugin whose manifest has `defaultEnabled: true`;
  - **the sneaky skills-directory plugin**;
  - **a skill and a subagent with frontmatter hooks**.

  The README gives the push steps. It also states:
  - the npm dependency is exact-pinned, tiny and well known (named in the README);
  - `run.sh` uses a throwaway `HOME` and npm cache under its temp dir, so Or's machine isn't touched beyond that dir.
- [ ] **Step 2:** Write `run.sh`, covering items 1–19 of spec §13 exactly as written:
  - `set -eu`, with `mkdir -p $MARK` up front and `test -z "$(ls -A $MARK)"` checks;
  - full stream capture to `out.jsonl`, with `init` selected by `jq 'select(.type=="system" and .subtype=="init")'`;
  - clones detached **behind** origin (`checkout --detach HEAD~1`);
  - item 2 run with the seed both read-only and writable;
  - the agent env exactly as in spec §7.3: a scrubbed plugins root, an empty `skills/`, `CLAUDE_CODE_PLUGIN_SEED_DIR`, `DISABLE_AUTOUPDATER=1`, and `--settings "$(cat plugin-settings.json)"`;
  - it refuses to run with `HOME` pointing at a dir that contains `.open-factory-spike`;
  - each item writes PASS, FAIL or RECORDED plus the evidence into `report.md`, from `report-template.md`.
- [ ] **Step 3:** `bash -n scripts/g1/run.sh` and `shellcheck scripts/g1/*.sh` (if installed). Commit `chore: Gate G1 script and fixture for Or`.
- [ ] **Step 4:** **Stop.** Hand off to tech-lead-i5 / main: "G1 is ready: Or runs `scripts/g1/run.sh` with Claude Code **<exact version from `images/base/claude-code-version`>** (B0) and posts `report.md` on #153." `run.sh` checks `claude --version` against that file, and refuses to run when the versions differ. Tasks B2 onward start only after Or's report. **Any FAIL goes back to owner-i5 before the design adapts.** The RECORDED items fill the constants in Tasks B3, B6 and B7: the floor, update against fresh install, and whether `mcpb/` is scrubbed.

### Task B2: Fake Claude: plugin seed mode

**Files:**
- Modify: `packages/harness/testing/fake-claude.mjs`, `packages/harness/src/fake-claude.test.ts`

**Interfaces (produces).** Fake Claude honours `CLAUDE_CODE_PLUGIN_CACHE_DIR` for `plugin marketplace add <arg>`, `install <key>` and `update <key>`:
- it writes `known_marketplaces.json` and `installed_plugins.json` in the v2 shape of spec §4, `marketplaces/<name>/` as a `git clone` of a local fixture marketplace, and `cache/<mkt>/<plugin>/<version>/`;
- it records argv and env to `$FAKE_CLAUDE_DIR/plugin.log`.

Scenarios through `FAKE_CLAUDE_SCENARIO`: `pull-marketplace`, `extra-dependency`, `unexpected-marketplace`, `orphan-marker` and `fail`. In a normal session the init event lists `plugins` from the seed, filtered by `--settings` `enabledPlugins`.

- [ ] Steps:
  1. Write failing fake tests for each scenario.
  2. Run `pnpm vitest run packages/harness/src/fake-claude.test.ts` → FAIL.
  3. Implement.
  4. Run again → PASS.
  5. Commit `test: fake Claude plugin seed mode`.

### Task B3: `marketplaces` table, locks, version floor, store runner

Implements spec §5.1 (marketplaces), §7.2 and §7.9.

**Files:**
- Modify: `packages/db/src/schema/library.ts` (+ generated migration), `apps/server/src/library/locks.ts` (add `storeLock`)
- Create: `apps/server/src/library/claude-flags.ts`, `apps/server/src/library/store-runner.ts`
- Test: `apps/server/src/library/locks.test.ts`, `apps/server/src/library/store-runner.test.ts`, `apps/server/src/library/claude-flags.test.ts`

**Interfaces (produces):**

```ts
export const storeLock: RwLock;  // { read<T>(fn): Promise<T>; write<T>(fn): Promise<T> }
export const CLAUDE_PLUGIN_FLOOR: string;  // from the G1 report
export async function checkClaudeVersion(bin: string, env): Promise<void>;  // fails "Claude Code {found} is too old; update it to {floor} or later."
export async function checkImageClaudeVersion(image: string, digest: string): Promise<void>;  // docker run --rm --network none --entrypoint claude <image> --version, cached by digest
export class StoreRunner {
  constructor(d: { claudeBin: string; factoryHome: string; serverEnv: NodeJS.ProcessEnv; registry: () => Promise<RegistryRow[]> });
  run(args: string[], o: { op: "add" | "install" | "update" | "remove"; cacheDir?: string; configDir?: string }): Promise<{ stdout: string }>;
  // inside storeLock.write; chmod -R u+w … finally a-w; writes state/plugins-runner/settings.json (exact known_marketplaces set, autoUpdate:false, minus removed/adding/failed/soft-deleted); env PATH, HOME, DISABLE_AUTOUPDATER=1, CLAUDE_CODE_PLUGIN_CACHE_DIR, CLAUDE_CONFIG_DIR, + CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 for install/update
}
```

- [ ] **Step 1: Write failing tests.**
  - The RwLock: two readers run together; a writer excludes readers.
  - The runner, with fake Claude:
    - env keys are exact, and `NONESSENTIAL` is set only for install and update;
    - the store is `a-w` after a run and also after a failed run;
    - the runner settings file declares exactly the store's marketplaces;
    - a leading-dash argument is refused;
    - output is redacted.
  - The floor: a fake `claude --version` printing `2.1.1` fails with the interpolated message.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/locks.test.ts apps/server/src/library/store-runner.test.ts apps/server/src/library/claude-flags.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): marketplaces table, store lock, store runner and version floor`.

### Task B4: Marketplaces service

Implements spec §7.1 and AC 8.

**Files:**
- Create: `apps/server/src/library/marketplaces-service.ts`
- Test: `apps/server/src/library/marketplaces-service.test.ts` (CI for DB parts)

**Interfaces (produces):**

```ts
export class MarketplacesService {
  preview(b: { kind: "github"; repo } | { kind: "git"; url } | { kind: "directory"; path }): Promise<MarketplacePreview>;  // name, commit, branch, plugins with pinned/refusedReason; refuses reserved (OFFICIAL_MARKETPLACES only with matching source), taken (ready/adding/soft-deleted rows, store known_marketplaces); failed rows not taken
  add(previewId: string, by: string): Promise<void>;  // 202; steps 1–5 of spec §7.1; failure → row "failed"
  bootRepair(): Promise<void>;
  assertMarketplacePinned(name: string): Promise<void>;  // HEAD == commit and `git status --porcelain --ignored --untracked-files=all` empty; directory no-op
  check(name): Promise<void>; update(name, commit, by): Promise<void>; remove(name): Promise<{ undoUntil }>; restore(name); removeFailed(name): Promise<void>;
}
```

- [ ] **Step 1: Write failing tests:**
  - preview before the store is touched (the fake Claude log is empty);
  - `claude-plugins-official` with a non-Anthropic source is refused, and accepted with `anthropics/claude-plugins-official`;
  - a name already in the store's `known_marketplaces.json` is refused;
  - a failed add removes only what it created, and a pre-existing marketplace with the same name survives;
  - boot repair completes a good `adding` row and fails a bad one;
  - a fetch for a plain git server uses `refs/heads/<branch>` and checks `FETCH_HEAD`;
  - pin drift and an untracked or ignored file both fail "Marketplace acme isn't at its pinned commit.";
  - update checks out the exact commit through `runGit`, never `marketplace update`;
  - the check result lists every installed or enabled plugin whose version, source or contents change at the new commit (a version or `sha` change, a source change, or a changed tree for a relative path, using `rev-parse <old>:<path>` against `<new>:<path>`). Plugins whose code-running parts change (hooks, MCP, LSP, status line, monitors, `bin/`, `package.json`, dependencies) are flagged `runsCodeChanged` and sorted first (owner plan review change 4);
  - remove is refused with "Uninstalling plugins isn't available yet." while plugins are installed;
  - the purge re-checks under `storeLock`.
- [ ] **Step 2: Run** `pnpm typecheck` → FAIL. Pure parts: `pnpm vitest run apps/server/src/library/marketplaces-service.test.ts -t pure`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (DB parts in CI).
- [ ] **Step 5: Commit** `feat(server): pinned marketplace registry`.

### Task B5: Plugin contents

Implements spec §7.8.

**Files:**
- Create: `apps/server/src/library/plugin-contents.ts`
- Test: `apps/server/src/library/plugin-contents.test.ts`

**Interfaces (produces):** `readContents(root: string): Promise<PluginContents>`, where

```ts
type PluginContents = {
  manifest;
  hooks: HookRow[];
  mcp: McpRow[];
  dependencies: string[];
  codeParts: CodePart[];  // lsp, statusLine, monitors, bin, node
  provides: { skills; commands; agents; outputStyles };
  unshown: string[];
  files: string[];
  summary: ContentsSummary;
};
```

- [ ] **Step 1: Write failing tests** on temp plugin dirs:
  - hooks inline and from `hooks/hooks.json`;
  - MCP stdio with env (values that aren't `${…}` are shown, `${TOKEN}` refs are shown as refs) and http with header **names** only;
  - LSP, statusLine, monitors, `bin/` executables and `package.json` → "Installs Node dependencies";
  - dependencies;
  - each of these goes into `unshown`: `hooks/hooks.json` as a link, a 300 KB JSON, bad JSON, a walk stopped at 2,000 files, and an unknown `plugin.json` key;
  - `files` lists only `${CLAUDE_PLUGIN_ROOT}` references that are regular files inside the root.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/plugin-contents.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): read plugin contents for review`.

### Task B6: Plugin store: installed, install, journal, update preview and apply

Implements spec §7.2 Reading, §7.5 and AC 10–11.

**Files:**
- Create: `apps/server/src/library/plugin-store.ts`
- Test: `apps/server/src/library/plugin-store.test.ts`

**Interfaces (produces):**

```ts
export class PluginStore {
  installed(): Promise<InstalledPlugin[]>;  // installPath exists, no .orphaned_at, inside cache/ or a registered directory marketplace
  isPinned(key: string): Promise<boolean>;  // spec §7.5 definition incl. no version-range deps
  install(key: string, by: string): Promise<void>;  // storeLock.write; journal; post-install closure check; rollback; provenance
  bootRecover(): Promise<void>;                     // journal left behind → roll back
  updatePreview(key: string): Promise<{ version: string; gitCommitSha: string; diff: ContentsDiff }>;  // isolated runner config + throwaway cache with rewritten installLocations; finally delete
  update(key: string, expect: { version: string; gitCommitSha: string }, by: string): Promise<void>;  // mismatch → rollback "x@y changed since you reviewed it. Review the update again."
  updateAvailable(key: string): Promise<boolean>;   // version/sha/source, or relative tree change
  state(key): { kind: "installing" | "failed"; since: string; reason?: string } | undefined;
}
```

- [ ] **Step 1: Write failing tests** with fake Claude scenarios:
  - three concurrent `install` calls of the same key result in one install in the log;
  - `pull-marketplace` rolls back and fails;
  - `extra-dependency` with a dependency from an unregistered marketplace rolls back;
  - `orphan-marker` rollback deletes the marker written during the operation;
  - a ranged dependency makes `isPinned` false;
  - a crash simulated after the journal is written is rolled back by `bootRecover`;
  - `provenance.json` holds only `{ marketplace, marketplaceCommit, installedBy, installedAt }`;
  - `updatePreview` never writes the real store (snapshot the tree before and after);
  - `update` with a different sha rolls back;
  - a failed background install records the state and writes `plugin_install_failed`;
  - relative-path update detection works by tree.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/plugin-store.test.ts` → FAIL.
- [ ] **Step 3: Implement.** If G1 item 10 said `update` can't be pinned, implement it as a fresh install of the new version next to the old one, never uninstall-first.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): plugin store installs once per version, with journal and rollback`.

### Task B7: Start with the seed; delete per-agent installs

Implements spec §7.3 steps 1–2 and 4–8, §6.5 (store class), and AC 9, 10, 12 and 14.

**Files:**
- Create: `apps/server/src/library/plugin-settings.ts`
- Modify:
  - `apps/server/src/workspace/workspace.ts`;
  - `apps/server/src/workspace/settings.ts`;
  - `apps/server/src/workspace/mounts.ts` (`storeDir` + store class; drop `pluginsDir`);
  - `apps/server/src/workspace/paths.ts`;
  - `apps/server/src/runtime/runtime-spec.ts`;
  - `apps/server/src/agents/agent-service.ts`, `apps/server/src/spawning/spawn-service.ts`;
  - `apps/server/src/workspace/agent-folders.ts` (scrub the plugins root to `data/`);
  - web (implementer and reviewer invoke `vercel-react-best-practices` and follow it): `apps/web/src/features/agents/agent-form-state.ts:281-282` (the "Installing plugins…" pending label goes, since create never installs) and its test.
- Delete:
  - `apps/server/src/workspace/plugins.ts` and its test;
  - `pluginsConfigDir`, `readPluginKeys`, `linkPlugins`, `install` in `workspace.ts`;
  - `PluginInstallError` uses and `502 plugin_install_failed`.
- Test:
  - `apps/server/src/library/plugin-settings.test.ts`, `apps/server/src/workspace/settings.test.ts`, `apps/server/src/workspace/workspace.test.ts`;
  - `apps/server/src/workspace/mounts.test.ts`, `apps/server/src/workspace/agent-folders.test.ts`;
  - `apps/server/src/spawning/spawn-service.test.ts` (CI).

**Interfaces (produces):**
- `buildPluginSettings(i: { closure: string[]; storePlugins: string[]; storeCatalogs: string[]; registry: RegistryRow[]; skillsDirNames: string[] }): { enabledPlugins: Record<string, boolean>; extraKnownMarketplaces: Record<string, { source; autoUpdate: false }>; syncClaudeAiPlugins: false }`;
- `PreparedSpec.extraArgs` gains `["--settings", JSON.stringify(pluginSettings)]`;
- `buildAgentEnv` adds `CLAUDE_CODE_PLUGIN_SEED_DIR` and `DISABLE_AUTOUPDATER=1`;
- `FACTORY_ENV_NAMES` gains the seven names from spec §7.3 step 6.

- [ ] **Step 1: Write failing tests.**
  - `plugin-settings.test.ts`:
    - `true` for the closure, including dependencies;
    - `false` for every other plugin in every store marketplace, catalog and installed alike;
    - `false` for known skills-dir names;
    - `extraKnownMarketplaces` holds only the closure's marketplaces, registry sources with no `ref`, and `autoUpdate: false`;
    - the template's own declarations are not carried over.
  - `settings.test.ts`: `buildSettings` writes no `enabledPlugins`, `extraKnownMarketplaces` or `syncClaudeAiPlugins`.
  - `workspace.test.ts`:
    - the plugins root is scrubbed to `data/` (a `data` link is removed);
    - a link at `.claude-config/plugins` becomes a folder;
    - a start during an install waits on `storeLock.read` and never sees a writable store;
    - a writable store under the read hold fails "The plugin store is writable; restart the factory.";
    - an unpinned missing plugin fails "Plugin x@y isn't installed. Install it in Skills." with fix `library`;
    - a pinned missing one installs, then the closure is recomputed;
    - a local agent below the floor fails.
  - Fake Claude records `--settings` in argv.
  - `mounts.test.ts`: the store class at exactly `realpath(<FH>/state/plugins)`; `state/plugins/cache` is refused.
  - `spawn-service.test.ts` (CI): three spawns produce at most one `install` in the log, and `spawn_agent` returns without one.
  - A template, overlay or secret setting `CLAUDE_CODE_PLUGIN_SEED_DIR` is an error.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/plugin-settings.test.ts apps/server/src/workspace` → FAIL.
- [ ] **Step 3: Implement.** If G1 item 7 said `mcpb/` isn't re-extracted, take that back to owner-i5 before changing the scrub.
- [ ] **Step 4: Run** → PASS. Then `pnpm typecheck` (no references to deleted symbols remain).
- [ ] **Step 5: Commit** `feat(server): agents load plugins from the factory seed; per-agent installs removed`.

### Task B8: `enabledPlugins` truth; `plugins:` removed; validation

Implements spec §7.4, §7.7 and R14.

**Files:**
- Modify: `packages/shared/src/templates.ts`, I2's `packages/shared/src/config.ts` (overlay schema), `apps/server/src/templates/validate.ts`, `packages/shared/src/config-changes.ts` (plugin lines)
- Modify (web; implementer and reviewer invoke `vercel-react-best-practices` and follow it): `apps/web/src/features/agents/template-field.tsx:187` (`config.plugins.length` becomes the count of `effectivePlugins`) and any other web reader of `TemplateConfig.plugins` found by `pnpm typecheck`
- Test: `packages/shared/src/templates.test.ts`, `apps/server/src/templates/validate.test.ts`, `packages/shared/src/config-changes.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `plugins:` in `template.yaml` gives "Unknown field.".
  - `enabledPlugins` errors:
    - `false` → "Remove the plugin instead of turning it off.";
    - an undeclared marketplace;
    - a declared marketplace that isn't registered → "Marketplace acme hasn't been added. Add it in Skills.", with the `add_from_template` action;
    - a source mismatch;
    - an overlay plugin from a marketplace the template doesn't declare → "Marketplace acme isn't declared by template dev.";
    - a `command`, `headersHelper`, `npm` or archive-without-sha256 source → "Plugin x@y uses a command source, which Open Factory doesn't install.";
    - `syncClaudeAiPlugins` in a template.
  - The "not installed and not pinned" warning.
  - `describeChanges`: "added plugin x@y", and "plugin x@y updated 1.2.0 → 1.3.0" (a hex version shows as "commit 0120fb8 → 9a8b7c6").
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/templates.test.ts apps/server/src/templates/validate.test.ts packages/shared/src/config-changes.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Delete the old "enabledPlugins is ignored" warning. Keep the `ref`/`path` refusal. Fix every reader of `TemplateConfig.plugins` to use `effectivePlugins(doc)`.
- [ ] **Step 4: Run** → PASS, then `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: enabledPlugins is the plugin truth; plugins: removed`.

### Task B9: Host plugins, plugin and marketplace routes, change flow

Implements spec §7.6, §9.1 (plugins), §9.3, §8.3 (plugins) and AC 9.

**Files:**
- Create: `apps/server/src/library/host-plugins.ts`
- Modify: `apps/server/src/routes/library.ts`, `apps/server/src/app.ts` (wiring; boot: `storeLock` → `a-w`, `bootRepair`, `bootRecover`)
- Test: `apps/server/src/library/host-plugins.test.ts`, `apps/server/src/routes/library.test.ts` (CI)

- [ ] **Step 1: Write failing tests.**
  - `HostPlugins.list()` on a temp host dir in the v2 shape:
    - the newest install by `lastUpdated`;
    - a key already in the store is left out;
    - an `installPath` outside `<hostdir>/plugins/cache` → "Can't show: outside the host's plugin folder.";
    - a host source with userinfo or `ref` → "The host's record for acme can't be used: …".
  - Install in factory: preview, register (skipped when it's already registered with the same source), install.
  - Routes (CI): every plugin and marketplace route returns 401 with an agent token; `update-preview` then `update`; `install` returns 202 and publishes `library_changed`.
  - A plugin update triggers `libraryChanged` only after the locks are released.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/host-plugins.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (routes in CI).
- [ ] **Step 5: Commit** `feat(server): host plugins, plugin and marketplace routes`.
- [ ] **Step 6: Background install on save** (spec §7.5 triggers, T6; owner plan review change 1).
  - `ConfigChanges` (I2's template-change and overlay-save paths) calls `PluginStore.enqueueInstall(key, by)` for every key that a save **newly** adds to the effective `enabledPlugins` closure, when the key is pinned and missing from the store. The PUT records the change, enqueues, and returns; it never awaits the install.
  - `enqueueInstall` dedupes by key: a key already queued or installing isn't queued again.
  - An unpinned missing plugin enqueues nothing; the save response carries the "not installed and not pinned" warning (spec §7.4).
  - Tests (CI, fake Claude):
    - a template save and an overlay save that newly enable a pinned, missing plugin each enqueue exactly one install, and the PUT resolves before fake Claude's `install` finishes (the scenario blocks until released);
    - an unpinned missing plugin enqueues nothing, and the save shows the warning;
    - two saves racing for the same key produce one `install` in the plugin log;
    - a failed background install writes `plugin_install_failed` and the row state (already in B6, re-used here).
  - Commit `feat(server): saves enqueue background installs of pinned plugins`.

### Task B10: Plugins and Marketplaces views, peeks, Add marketplace

Implements spec §10.1–§10.4 (plugins). Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Create:
  - `apps/web/src/routes/_app/skills.plugins.tsx`, `skills.marketplaces.tsx`;
  - `apps/web/src/features/skills/plugin-list.tsx`, `marketplace-list.tsx`;
  - `peeks/plugin-peek.tsx`, `peeks/marketplace-peek.tsx`;
  - `add-marketplace-sheet.tsx`.
- Modify: `skills-header.tsx` (the switch; a `Select` below about 16rem), `apps/web/src/features/sheets/sheet-bodies.ts`
- Test: `apps/web/src/features/skills/plugin-list.test.tsx`, `peeks/plugin-peek.test.tsx`, `peeks/marketplace-peek.test.tsx`, `add-marketplace-sheet.test.tsx`

- [ ] **Step 0 (owner plan review change 4):** the Marketplace peek's update view renders "Plugins in use that change" from the check result, with the `runsCodeChanged` plugins first, each marked "Runs code changed". Add a test for it next to the Step 1 tests.
- [ ] **Step 1: Write failing tests.**
  - The plugin list:
    - the groups "In the factory", "On this host" and "In marketplaces, not installed";
    - the contents line shows the first three kinds, then "+N more", with "Parts not shown" first;
    - hex versions show as commits;
    - a row moving groups waits until pointer and focus leave the list, and an open peek retargets.
    - An empty view shows "No plugins yet. Add a marketplace to install plugins."
  - The plugin peek:
    - "Runs code" comes first and never collapses;
    - skeleton rows render from `contentsSummary`;
    - the hooks stack below `@max-[28rem]`;
    - View file opens from the top;
    - "Update…" is a disclosure: it hides itself, focuses the view heading and shows "Preparing update…", then a `+`/`−` diff and "Update to 1.3.0";
    - a mismatch error shows;
    - opened with `readOnly`, there are no actions and an "Open in Skills" link.
  - The marketplace peek: Check for updates; Back returns focus to the row and Esc closes; the Remove reason reads "Plugins from acme are installed. Uninstalling plugins isn't available yet.".
  - Add marketplace:
    - the preview shows plugins with "Not pinned" or "Can't install: command source";
    - Add closes the sheet;
    - the pending row "Adding acme… 0:42" uses the server's `since`;
    - a failure gives a "Couldn't add" row and a toast with Show details;
    - Find again replaces the failed row.
  - The header: three views; a `Select` below the threshold.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): Plugins and Marketplaces views, peeks and Add marketplace`.

### Task B11: Plugin picker in the Configuration form

Implements spec §10.5 (plugins) and AC 9 and 13. Implementer and reviewer invoke `vercel-react-best-practices` and follow it.

**Files:**
- Modify: `apps/web/src/features/config/sections/skills-plugins.tsx` (replace I2's `name@marketplace` text input)
- Test: `apps/web/src/features/config/sections/skills-plugins.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - Only store plugins are offered, grouped by marketplace.
  - Template mode: picking writes `settings.enabledPlugins[key] = true` and `settings.extraKnownMarketplaces[mkt] = registry.source` into the draft. The footer reads "Install more in Skills".
  - Agent mode offers only the template's marketplaces, with the footer "Only plugins from dev's marketplaces. Add more in the template.", and writes `settings.enabledPlugins` into the overlay.
  - Removing the last plugin of a marketplace leaves its declaration.
  - A row's View opens the read-only peek.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): Library plugin picker`.

### Task B12: Finish PR 2

- [ ] **Branch review.** A fresh reviewer on `git diff i5/1-library-skills...i5/2-plugins` against spec §7, §8, §10, §11, §13 and AC 8–14. It checks:
  - every hardened path, with argv and env tests;
  - no `ref` anywhere;
  - no `marketplace update` call;
  - the lock order, and that `libraryChanged` runs after the locks;
  - the deletions are complete: grep `plugins-config|pluginsConfigDir|readPluginKeys|linkPlugins|PluginInstallError|plugin_install_failed` finds no matches except the new event name;
  - ADR 0028;
  - **the React diff against `vercel-react-best-practices`** (the reviewer invokes the skill first and skips Next-only rules, saying so), using A16's checklist, with R-Q1 (update-preview as a mutation), R-Q3, R-L5 and R-E1 checked on the plugin views.

  Fix the findings.
- [ ] **Full verification**, as in A16, with a fixture marketplace through `file://` for fake Claude.
- [ ] **Real-browser evidence**, as in A16:
  - add `i5b_*.py` checks for AC 8–13;
  - worst-case data: a plugin with 12 hooks, a U+202E command and a multi-line `bash -c`; a `hooks.json` link; more than 2,000 files; `rust-analyzer-lsp@claude-plugins-official` with a 12-hex version; two git-URL marketplaces on one host; an empty Plugins view.
- [ ] **Push and PR.**
  - Merge `i5/1-library-skills`, then push.
  - Open a draft PR with base `i5/1-library-skills`, titled `feat: plugins installed once into a factory seed from pinned marketplaces`. It links the spec, the plan and #153, the G1 report, the reset step, and says that DB tests run in CI.
  - Watch CI until it is green. Never merge.

---

# Part C: `i5/3-polish-docs` (PR 3)

Cut it with `git checkout -b i5/3-polish-docs i5/2-plugins`. If the evidence fixes are small, fold this part into PR 2 instead and say so in the PR 2 body.

### Task C1: Evidence fixes

Implementer and reviewer invoke `vercel-react-best-practices` and follow it, for any apps/web fix.

- [ ] Fix each failing evidence item from A16 and B12 as its own commit, then re-run the affected checks under the locks.

### Task C2: Product docs (for the lead)

- [ ] `docs/product/` is gitignored and lives only in the main checkout. **Don't edit it.** List spec §18 in the PR body and the final report, for the lead:
  - Agent template;
  - Workspace;
  - Administration (a new Skills section);
  - ADR 0017 note, ADR 0024 consequences;
  - Data model;
  - Agent runtime;
  - in both Workspace and Agent runtime, say plainly: on the local runtime, the read-only seed and the scrubbed folders guard against accidents and are **not** a security boundary (Q6, Q21);
  - Base image (#160);
  - I6 path help and README;
  - Factory MCP (I7 note: `RESERVED_SETTINGS_KEYS` is the agent default-deny).

### Task C3: Final whole-branch review, verification, PR

- [ ] **Whole-branch review** of `git diff spec/i5-skills-and-plugins...i5/3-polish-docs` (all of I5) against the whole spec and all 14 acceptance criteria. **The React diff is checked against `vercel-react-best-practices`** with A16's checklist and every R-* rule in Global Constraints: the reviewer invokes the skill, skips Next-only rules and says so.
- [ ] **Full verification** under `/tmp/of-v002-heavy.lock`: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and the dev loop from a clean clone.
- [ ] **Real-browser re-check** of every UI acceptance criterion in Chromium and WebKit headless, through the harness `run.sh` lock. Use fake Claude and the `file://` fixture only.
- [ ] **Push and draft PR.** Base `i5/2-plugins`, titled `chore: Skills evidence fixes and docs list`. Watch CI until it is green. Never merge.

## Manual steps for Or (the executor never does these)

1. **Gate G1** (Task B1): push the fixture repo, run `scripts/g1/run.sh` with the exact Claude Code version pinned in B0, and post `report.md` on #153. Part B starts only after that.
2. **Review the certainty-3-or-lower decisions** listed on #153: Q3, Q5, Q6, Q7, Q9, Q12, Q15, Q18, T1, T7, T8, R5 and R12.
