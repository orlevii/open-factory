# I5 Skills and plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Library of skills (host, local folder, GitHub pinned to a commit, template-local) and plugins (from factory-registered marketplaces that Skills reads at a commit). Claude Code itself installs each agent's plugins at start, into the agent's own plugins dir, at the pin its template declares (pinned by default; Latest is an explicit choice). The factory runs no installer (Or, 2026-11-24). Add a Skills page and Library pickers, with a pin control, in the Configuration form.

**Architecture:**
- **Skill sources and marketplaces** are two DB tables. Host and template-local skills are discovered live by a `LibraryIndex`.
- **GitHub skills** are fetched by a hardened `runGit` into `state/library/github/<id>/<sha>/`, read-only.
- **Marketplaces** are read by the same `runGit` into `state/library/marketplaces/<name>/<sha>/`, read-only, for the catalog, contents and diffs.
- **Plugins** are installed by Claude Code at agent start into `state/agents/<slug>/plugins/` (`CLAUDE_CODE_PLUGIN_CACHE_DIR`, read-write in Docker). The factory-owned keys (`enabledPlugins`, `extraKnownMarketplaces` with `ref` as the pin, `syncClaudeAiPlugins`) arrive through `--settings '<json>'`. After `init`, the factory reports any plugin that didn't load.
- **Every start** scrubs the agent-writable skill paths and refuses reserved settings keys.
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
  - The one real run is Or's Gate G1 (Task B1), inside containers from the agent image. Nothing is installed on Or's machine for any test or evidence.
- **No tokens in URLs or logs.**
  - Every `git` output passes through `redactOutput` (`apps/server/src/redact.ts`). The factory never runs `claude plugin`.
  - Inputs refuse userinfo, `?` and `#`.
  - Events carry only redacted text.
- **Hardened git runner (spec §6.2).** Used for GitHub skills, marketplaces and external plugin sources.
  - An empty temp cwd.
  - Env exactly `PATH` and the host `HOME`, plus the listed variables.
  - Every `git` call prefixed with the `-c` flags verbatim from spec §6.2.
  - Arguments starting with a dash are refused.
  - Budgets: 60 s per command and 180 s per operation.
- **Limits (verbatim from the spec):**
  - GitHub and marketplace checkout ≤ 50 MB;
  - JSON ≤ 256 KB, `marketplace.json` ≤ 1 MB, `SKILL.md` ≤ 64 KB, at most 2,000 files walked;
  - descriptions and subjects cut to 200 characters on grapheme boundaries;
  - Undo 30 s;
  - check-all 4 at a time;
  - previews swept after 1 h.
- **Patterns.** `HOST_SKILL_PATTERN` for every Library skill name. `MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, minus the reserved names. `PLUGIN_REF_PATTERN`: a name of at most 64 characters, then `@`, then a marketplace name.
- **I4 form rules.** Field and outcome messages are exported constants of at most 40 characters, never interpolated (spec §10.4 lists them). User-facing copy says "Skills", never "Library". The real homes (re-validated against the merged I1–I4/I6 code):
  - `FieldShell` `apps/web/src/components/field-shell.tsx`; `FieldNote` + `noteDescribedBy` `components/field-note.tsx`; `useFieldErrors` `components/forms/use-field-errors.ts`; `FormOutcome`, `useOutcome`, `NO_OUTCOME` `components/forms/form-outcome.tsx`; `focusField` `components/forms/focus-field.ts`; `FormFrame` (kind `"inline" | "sheet"`) `features/settings/forms/form-frame.tsx`; the `.field-stack` CSS class `apps/web/src/styles.css`; `PathField` `components/path-field.tsx`; `MiddleTruncate` `components/middle-truncate.tsx`.
  - Messages: field messages the server returns go in shared `MSG` (`packages/shared/src/messages.ts`, tested by `messages.test.ts`); server-only field messages in `FIELD_MSG` (`apps/server/src/field-messages.ts`); web form-level, outcome and load lines in `FORM_MSG` (`apps/web/src/lib/form-messages.ts`, tested by `form-messages.test.ts`); config-form copy in `apps/web/src/features/config/messages.ts` (`CONFIG_FIELD_MSG`, `CONFIG_FORM_MSG`, `CONFIG_PAGE_MSG`, `CONFIG_COPY`). Reuse `MSG.hostPathStart`, `FIELD_MSG.noFolder` and `FORM_MSG.enterPath` for the folder path.
  - Sheets: kinds are declared in `features/sheets/sheet-store.ts` (`SheetSpec`, `ChildSpec`); bodies in `features/sheets/sheet-bodies.ts` (with the `warm()` prefetch helper); drafts that survive close in `features/sheets/drafts.ts`.
- **I2 config form (where I5's pickers live).** The section is `apps/web/src/features/config/skills-section.tsx` (`SkillsSection`, titled "Skills and plugins", with `SkillPicker` via `PickAdd` and the plugins `ListField`), placed by `config-form.tsx`. Lists: `list-field.tsx` → `config-list.tsx`; the add control is `pick-add.tsx`; field paths are in `fields.ts`; `PageFooter` is `features/config/page-footer.tsx`. The agent page is `features/config/config-page.tsx` (route `routes/_app/agents.$slug_.config.tsx`); the template tab is `features/templates/template-config-tab.tsx` (route `routes/_app/templates.$name.tsx`). There is no `features/config/sections/` directory.
- **Database tests.** Server tests need Postgres (`DATABASE_URL`). Get a database only through `makeTestApp` or `createTestDb` (`apps/server/src/test/helpers.ts`); both copy a template migrated once per migration set (`createMigratedTestDatabase` in `packages/db/src/testing.ts`), and test apps get a cheap `AppDeps.passwordHasher`. Never migrate your own database in a test. Where the local Postgres role is unavailable, run the pure unit tests and the web tests you touched and read CI for the DB suites.
- **Testing standards (AGENTS.md).** Every new or changed test follows AGENTS.md "Testing standards": test observable behaviour; cover the failure cases and security boundaries; no existence-only tests (no asserting that a key, export, constant or element exists, and no comparing a constant to its own literal); no implementation details; **no assertions on CSS classes or styling** (no `toHaveClass`, class strings, inline styles or tokens; layout and look are checked in the browser evidence); every test can fail; mock only boundaries; one behaviour per test, `test.each` for inputs; no tombstones for deleted routes or fields. The per-task reviewer checks the tests against these too.
- **Tests per task, full suite per Part.** Each implementer and each reviewer runs **only the test files it created or changed** (`pnpm vitest run <files>`), or `pnpm test:related <changed source files>` to run the tests that import them. The full suite, `pnpm typecheck`, `pnpm lint` and `pnpm build` run **once at the end of each Part** (A16, B11, C3); CI is the full-suite check (a `checks` job plus test shards 1–4), because local full runs are slow and flaky on this machine. A task may run `pnpm typecheck` when it deletes or renames an exported symbol, to find the callers.
- **One reviewer per task.** After each task, one fresh reviewer checks that task's diff against the spec sections it cites and this plan; for React tasks it also checks the diff against `vercel-react-best-practices`.
- **React.** The React parts of this plan were checked against `vercel-react-best-practices` when it was re-validated (React + Vite + TanStack Router/Query; Next-only rules don't apply). Whoever edits a React task of this plan MUST invoke the `vercel-react-best-practices` skill first and keep the task compliant. Every task that touches `apps/web` says: "The plan is already React-compliant; follow it as written and report any deviation." The implementer follows it; the per-task reviewer and the Part's final review check the React diff against the skill.
- **React rules from the plan review** (binding for every web task; the branch reviews check each one):
  - **R-Q1. POSTs are mutations.**
    - These are `useMutation`, started from click handlers and kept in component state, never under the `["library"]` key: Check for updates per source (A12) and per marketplace (B9), Find skills and Find more skills (A12, A13), marketplace Update, Fetch, Read contents and Add its marketplace (B9), and the pin diff (`POST …/diff`, B10).
    - Test: a `library_changed` frame while a pin review is open doesn't call `diff` again.
    - A mutation's result is kept in component state keyed by what it is for (`key`, source `id`). When the peek retargets, the stale result is dropped during render (`if (resultFor !== key) setResult(undefined)`), never in an effect.
  - **R-Q2. Query keys.** Pinned keys, arrays of primitives:
    - `["library","skills"]`, `["library","skill",group,name]`, `["library","source",id]`;
    - `["library","plugins"]`, `["library","plugin",key,from,commit ?? "library"]` (the commit is part of the key, so a peek at a template's pin never shows the Library commit's cache entry), `["library","marketplaces"]`;
    - file text as `["library-file", group|key, name, path, pin]`, outside the `["library"]` prefix, with `staleTime: Infinity` when pinned. It is fetched only while View file is open (`enabled: open`), prefetched on pointer-enter or focus of the toggle, and rendered with `UntrustedCode`, never CodeMirror.
    - `libraryQueryOptions` uses `staleTime: 0`, so a window focus refreshes the host and template-local lists (spec §9.5).
  - **R-Q3. Coalesced invalidation.** WS frames are handled in `apps/web/src/routes/_app.tsx` `onMessage` (`lib/ws.ts` is only the socket). Add `onLibraryChanged(qc)` in `apps/web/src/lib/library.ts`: a **module-level** 250 ms trailing timer (like `features/agents/status-frames.ts`'s batching, never per render) that invalidates `["library"]` once; `onMessage` calls it for `library_changed`. The reconnect path already invalidates everything but chat, so no reconnect code is added. Test (`lib/library.test.ts`): 10 frames in one tick give one invalidation.
  - **R-E1. One elapsed timer.** `Elapsed` already exists in `features/session/activity-line.tsx` (memo, ticks itself, paused when the document is hidden via `hooks/use-document-visible.ts`) but shows from 0 s. Move it to `apps/web/src/components/elapsed.tsx`, add `hideUnderMs?: number` (renders nothing until then and schedules its first tick at that point), and import it back into `activity-line.tsx`. Rows and headers render `<Elapsed since={since} hideUnderMs={10_000} />` and pass only `since`. Test: a tick doesn't re-render sibling rows.
  - **R-L1. Rows and `j`/`k`.** Rows are `memo` components with primitive props (`shown`, `name`, `state`, `since`) and stable handlers, as in `features/tasks/task-list.tsx`. `lib/row-nav.ts` `onRowKeyDown` today returns unless the target is an `<a>` and queries `a`; change it to select rows by a `data-row` attribute (set on the anchors in the existing task, agent and inbox lists, and on the new button rows and source headers), and update `test/row-nav.test.tsx`. Never a per-list `j`/`k` handler.
  - **R-L2. Peek from the cached row.** The peek reads the row with `useQuery({...libraryQueryOptions, select})`, where `select` comes from a module-level factory (`selectSkillRow(group, name)`) memoised with `useCallback` keyed on `[group, name]`; an inline `select` re-runs every render. The detail comes from its own query, and the view is derived during render (`detail ?? rowFields`, plus skeletons from `contentsSummary`). Never `initialData` or `placeholderData`, and never an effect.
  - **R-L3. Aborting Find.** The Find sheet keeps one `AbortController` in a ref:
    - a new Find aborts the previous one inside its click handler;
    - Close aborts in its handler;
    - an unmount cleanup aborts as well, and that cleanup is the only effect.
    
    The signal goes through the `mutationFn`. Tests: unmount aborts; a second Find drops the first response.
  - **R-L4. Arrival.** Reuse I3's `apps/web/src/lib/use-arrival.ts` (`arrive(row)`: focus without scroll plus the `data-focus-ring` stand-in; `useArrivalTint()`: `{arrival, start, onArrivedEnd}`, a 2 s visible-time tint with stable callbacks; used by `features/settings/credentials-section.tsx`). `useLibraryArrival()` keeps `[arrivedKey, setArrivedKey] = useState<string>()` and adjusts during render: `if (state.peek && location.key !== arrivedKey) { setArrivedKey(location.key); setPeek(state.peek) }` (the adjust-state-while-rendering pattern `credentials-section.tsx` uses; a lazy `useState` would not re-run for a second arrival on the same mounted page). One effect, deps `[location.key, rowFound]`, ref-guarded per key: `row.scrollIntoView({ block: "center" }); arrive(row); start()`. Rows take `arrival`/`onArrivedEnd` as props. Router state stays (spec R6). Test: a `library_changed` after arrival doesn't scroll again; a second arrival on the mounted page opens its peek.
  - **R-L5.** Retired with the plugin redesign: rows no longer move between groups.
  - **R-C1. Multi Combobox.** The existing `Combobox` (`components/ui/combobox.tsx`) has an `onOpen` prop and an internal `onOpenChange`. The snapshot of what to leave out next time is taken in that open handler (`onOpen`), never in an effect. Callers keep `added` stable with a primitive key: `useMemo(() => new Set(names), [names.join("\0")])`, because the config draft's `readList` may return a fresh array each render. Picked options keep cmdk's `disabled` prop, so the highlight skips them.
  - **R-F1. Find results.** Ticks are a `Set<name>` updated with functional `setState`. The filtered rows, the toggle label and "None of these can be added" are derived during render. Old ticks merge with new names in the Find success handler. No `useDeferredValue`.
  - **R-H1. Hoisting.** No section component (Runs code, Files, Used by, Provenance, `renderOption`) is ever defined inside another component. Static skeleton rows are hoisted to module scope and sized from counts.
  - **R-B1. Routes and loaders.** Routes are code-split by `autoCodeSplitting: true` in `vite.config.ts`; never add `lazy()` by hand. The loader follows `routes/_app/settings.projects.tsx`: `void qc.prefetchQuery(hostQueryOptions)`, then `await Promise.allSettled([preload ? qc.ensureQueryData(lib) : qc.fetchQuery(lib)])`. The sidebar link relies on the router's `defaultPreload: "intent"` (`router.tsx`). Every page that renders a Library picker prefetches the Library without awaiting it: `void qc.prefetchQuery(libraryQueryOptions)` in both `routes/_app/agents.$slug_.config.tsx` (replacing today's host-skills prefetch) and `routes/_app/templates.$name.tsx`, so the picker never starts a fetch on mount (no waterfall).
  - **R-T1. Timers from handlers.** A delay that follows a user action (Add skills' 300 ms inert primary, Undo windows) is started in the handler that caused it (`onSuccess`: `setInertUntil(Date.now() + 300)` plus one `setTimeout`), not by an effect watching state.
  - **R-P1. `content-visibility`.** Not used, because it can break `scrollIntoView({block:"center"})` on arrival. Add it only if the A16 evidence shows slow renders, and say so.
- **No shared heavy-job lock.** There is no `/tmp/of-v002-heavy.lock`. Browser evidence still goes through the evidence harness's own `run.sh` lock. Never write sleep or wait loops on other agents' processes.
- **Git.** Merge, never rebase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never merge a PR; Or merges the stack.
- **PRs.** Each of the three PRs opens **ready for review, not draft**, only after its final review's findings are fixed and CI is green. Base is the previous branch of the stack: `i5/1-library-skills` → `chore/faster-tests`, `i5/2-plugins` → `i5/1-library-skills`, `i5/3-polish-docs` → `i5/2-plugins`.

## Branches

All work happens in the worktree `/Users/orlevi/projects/open-factory/.worktrees/spec-i5`. `spec/i5-skills-and-plugins` already merges `origin/chore/faster-tests`, which includes `chore/test-review` and `i3/claude-sign-in` (I4, I6, I1, I2 and I3 implemented; I3 is PR #185).

- **Part A, `i5/1-library-skills`:** cut from `spec/i5-skills-and-plugins`, after merging the latest `origin/chore/faster-tests` again.
- **Part B, `i5/2-plugins`:** cut from `i5/1-library-skills`. Its implementation (B2 onwards) **waits for Or's Gate G1 result** (Task B1, a manual step for Or).
- **Part C, `i5/3-polish-docs`:** cut from `i5/2-plugins`. Fold it into Part B if it is small.

```bash
cd /Users/orlevi/projects/open-factory/.worktrees/spec-i5
git fetch origin
git merge --no-edit origin/chore/faster-tests
git checkout -b i5/1-library-skills
```

Before each push, and before `pnpm db:generate` (A2, B3), merge the latest lower branch again (never rebase): a later I3 migration would take I5's number.

**Commands:**
- the files you touched: `pnpm vitest run <paths>`, or `pnpm test:related <source files>`; `pnpm test:fast` runs the tests related to everything changed since `origin/main`;
- the whole suite, once per Part: `pnpm test`;
- `pnpm typecheck`, `pnpm lint`, `pnpm build`;
- migrations: `pnpm db:generate` (migrations live in `packages/db/migrations/`; the last on the branch is `0020_superb_lyja.sql`, so A2 generates `0021_*` and B3 `0022_*` unless a later lower-branch merge added one).

## File map

**Shared (`packages/shared/src/`)**

| File | Purpose | Part |
|---|---|---|
| `library.ts` (new) | Patterns (imports `HOST_SKILL_PATTERN` from `names.ts`), reserved names, `OFFICIAL_MARKETPLACES`, `PLUGIN_REF_PATTERN`, input normalisers (`normalizeRepo`, `normalizeSubpath`, `checkBranchName`, `checkGitUrl`), schemas for every API in spec §9, `SkillGroup`, `SkillEntry`, `ROW_STATE_ORDER`, `cutGraphemes` | A (plugin schemas in B) |
| `settings-keys.ts` (new) | `RESERVED_SETTINGS_KEYS`, `reservedKeysIn(settings)` (uses `isFactoryEnvName`) | A |
| `config-changes.ts` (modify, from I2) | `describeDocChanges(a, b)` (today's doc-only body), `describeChanges({doc, library}, {doc, library})`, the library lines, `summarizeChanges` counts | A (plugin lines in B) |
| `templates.ts` (modify) | `PLUGIN_REF` deleted (A1, replaced by `PLUGIN_REF_PATTERN`); `plugins`, `PLUGIN_REF_MSG` and `pluginRef` removed (B6) | A, B |
| `library.ts` (modify, B6) | `pinOf`, `checkPinRef`, `OFFICIAL_MARKETPLACES` pin kinds, `ROW_STATE_ORDER` for plugins | B |
| `events.ts` (modify, B7) | `plugin_not_loaded` session event | B |
| `config.ts` (modify, from I2/I6) | host-skills schema and `HOST_SKILL_DESCRIPTION_MAX` deleted (A8); `FACTORY_ENV_NAMES` gains the plugin env names (B7); `overlayTemplateSchema.plugins` removed (B6) | A, B |
| `ws.ts` (modify) | `{ type: "library_changed" }` | A |
| `messages.ts` (modify) | I4 `MSG` constants from spec §10.4 that the server returns | A |
| `index.ts` | exports | A, B |

**DB (`packages/db/src/schema/`)**

| File | Purpose | Part |
|---|---|---|
| `library.ts` (new) | `skillSources` (A), `marketplaces` (B3), as spec §5.1 | A, B |

**Server (`apps/server/src/`)**

| File | Purpose | Part |
|---|---|---|
| `redact.ts` (new; moved from `workspace/plugins.ts`) | `redactOutput`, `capOutput`, `OUTPUT_MAX_LINES`, `OUTPUT_MAX_BYTES` | A |
| `config.ts` | `hostClaudeDir` replaces `hostSkillsDir`; `githubUrl`; `FACTORY_HOST_SKILLS_DIR` joins the `REMOVED_ENV` boot warning | A |
| `library/git.ts` (new) | `runGit`, `GIT_FLAGS`, `gitEnv` | A |
| `library/git-fetch.ts` (new) | `resolveRef`, `fetchCommit`, `checkoutSize`, `treeShas`, `installCheckout` | A |
| `library/skill-md.ts` (new) | `readSkillMd(dir)` → `{ name?, description?, hooks[] }` (O_NOFOLLOW, 64 KB) | A |
| `library/library-index.ts` (new) | `LibraryIndex.skills()`, `resolveSkill(name)`, `usedBy` | A |
| `library/forbidden.ts` (new; shared with `mounts.ts`) | `forbiddenSet(ctx)`, `checkSkillFolder(real)` | A |
| `library/sources-service.ts` (new) | preview, add, find, check, update, fetch, remove, restore, purge | A |
| `library/locks.ts` (new) | `libraryLock` (KeyedMutex) | A |
| `library/library-sweep.ts` (new) | previews > 1 h, soft-delete purge, boot purge | A |
| `library/claude-flags.ts` (new) | `assertPluginFloor` (on the harness's `checkClaudeVersion`), `checkImageClaudeVersion`, `versionCheckEnv` (moved from `agents/runtimes.ts`) | B3 |
| `library/marketplaces-service.ts` (new) | preview, add, check, update (the Library's commit), `fetchAt`, `checkout`, remove, restore | B4 |
| `library/plugin-sources.ts` (new) | `readPluginSource(src, sha)`: external `sha` sources, read-only | B4 |
| `library/plugin-contents.ts` (new) | `readContents(root)` with `needs`, `diffContents(a, b)` | B5 |
| `library/host-plugins.ts` (new) | `HostPlugins.list()`, `addMarketplace` | B8 |
| `library/plugin-settings.ts` (new) | `buildPluginSettings(...)` → the `--settings` JSON; `readInstalled(pluginsDir)` | B7 |
| `workspace/links.ts` | `resolveSkills` (replaces `resolveHostSkills`), prefix set, `.claude-plugin` check | A |
| `workspace/agent-folders.ts` (new) | `scrubAgentFolders`, `checkProjectSettings`, `checkAgentFrontmatter` | A |
| `workspace/mounts.ts` | `skillPaths`; the GitHub-skill class (A); the agent's plugins dir read-write as an exact class, `declaredMarketplaceDirs` from the closure (B7) | A, B |
| `workspace/workspace.ts` | takes `library: LibraryIndex` instead of `hostSkillsDir`; `materialize` and `prepare` steps from spec §7.3; `ensurePlugins` deleted (B) | A, B |
| `workspace/paths.ts` | `agentPluginsDir` replaces `pluginsConfigDir` (B7) | B |
| `workspace/settings.ts` | `buildSettings` loses `pluginKeys` and `plugins` (B) | B |
| `workspace/plugins.ts` | deleted (B) | B |
| `templates/validate.ts` (I2's `validateEffective`) | spec §6.6 and §7.4 rules; `ValidationContext.library` replaces `hostSkillsDir` | A, B |
| `templates/template-index.ts` | `context()` passes `library`; rescans on `libraryChanged` | A |
| `agents/config-resolver.ts`, `agents/config-changes.ts` (from I2) | `Effective.library`; `currentEffective` port; `libraryChanged`; `Effective.templatePlugins` deleted (B) | A, B |
| `agents/agent-runtime.ts`, `agents/runtimes.ts` | `requestRestart` compares `{doc, library}` | A |
| `agents/runtime-spec.ts` | `buildAgentEnv` adds `CLAUDE_CODE_PLUGIN_CACHE_DIR` and the update env; passes `settingsJson` | B7 |
| `agents/agent-runtime.ts` | the init check: `plugin_not_loaded` and the Inbox notice; loaded versions into `started.library` | B7 |
| `packages/harness/src/types.ts`, `packages/harness/src/claude/args.ts`, `packages/harness/src/claude/mapper.ts` | `AgentRuntimeSpec.settingsJson`; `buildClaudeArgs` pushes `--settings`; `session_started.plugins` | B7 |
| `packages/harness/src/claude/version.ts` | `MIN_CLAUDE_VERSION` = 2.1.331, the one floor (B3; G1 item 21 may lower it) | B |
| `images/base/claude-code-version`, `.github/workflows/base-image.yml` | the 2.1.331 pin (B0) | B |
| `scripts/g1/*` | G1 in containers (B1) | B |
| `routes/library.ts` (new) | spec §9 routes, `requireUser` only | A, B |
| `routes/host-skills.ts` (from I2) | deleted (its `skillDescription` moves to `library/skill-md.ts`) | A |
| `app.ts` | wiring, sweeps, boot removal of `adding` rows | A, B |

**Web (`apps/web/src/`)**

| File | Purpose | Part |
|---|---|---|
| `lib/library.ts` (new) | query options (A8), `onLibraryChanged` coalesced invalidation (A11) | A |
| `routes/_app.tsx` | `onMessage` calls `onLibraryChanged` | A |
| `routes/_app/agents.$slug_.config.tsx`, `routes/_app/templates.$name.tsx` | non-awaited `libraryQueryOptions` prefetch | A |
| `features/config/api.ts` | `hostSkillsQueryOptions` deleted | A |
| `components/elapsed.tsx` (moved from `features/session/activity-line.tsx`) | `Elapsed` with `hideUnderMs` | A |
| `lib/row-nav.ts` | rows selected by `data-row` | A |
| `routes/_app/skills.tsx`, `skills.index.tsx` (new); `skills.plugins.tsx`, `skills.marketplaces.tsx` (B) | routes | A, B |
| `features/skills/skills-header.tsx` | header, Check for updates outcome | A |
| `features/skills/skill-list.tsx`, `source-header.tsx`, `row-state.tsx` | lists and states | A |
| `features/skills/peeks/*` (`source-peek.tsx`, `skill-peek.tsx`, `update-view.tsx`, `file-view.tsx`, `use-peek.ts`) | peeks | A |
| `features/skills/peeks/plugin-peek.tsx`, `marketplace-peek.tsx`, `needs-from-image.tsx` | peeks | B9 |
| `features/config/plugin-pin.tsx`, `latest-badge.tsx` (new) | the pin control, its reviews, the Latest badge | B10 |
| `features/skills/add-skills-sheet.tsx`, `add-skills-results.tsx` | Add skills | A |
| `features/skills/add-marketplace-sheet.tsx` | Add marketplace | B |
| `features/skills/plugin-list.tsx`, `marketplace-list.tsx` | lists | B |
| `components/untrusted-text.tsx` (new) | `UntrustedCode`, `UntrustedProse`, `visibleControls()` | A |
| `components/ui/combobox.tsx` | a `multiple` mode | A |
| `components/ui/checkbox.tsx` | disabled shapes (decision 21) | A |
| `features/config/skills-section.tsx`, `config-list.tsx`, `pick-add.tsx`, `fields.ts` (from I2) | Library pickers | A (plugins B) |
| `components/app-sidebar.tsx`, `features/shortcuts/global-shortcuts.tsx`, `shortcuts-sheet.tsx`, `features/palette/rank.ts` (`GO_TO`) | nav, `g k` (free) | A |
| `features/sheets/sheet-store.ts`, `sheet-bodies.ts` | `add-skills`, `add-marketplace` kinds | A, B |
| `features/agents/agent-form-state.ts`, `show-output.tsx` | per-agent install output deleted | B |

---

# Part A: `i5/1-library-skills` (PR 1)

Implements spec §2 AC 1–7, §5, §6, §7.3 step 3, §7.10, §8 (skills), §9.1–§9.2, §9.4–§9.6, §10 (skills), §11.1, and DESIGN.md amendments 1–6.

**Reset step** (stated in the PR body):
- drop the database and recreate agents;
- rename `FACTORY_HOST_SKILLS_DIR` to `FACTORY_HOST_CLAUDE_DIR` in `.env`, pointing at the Claude dir, not at `skills/`.

### Task A1: Shared Library module, reserved keys, WS frame

**Files:**
- Create: `packages/shared/src/library.ts`, `packages/shared/src/settings-keys.ts`
- Modify: `packages/shared/src/ws.ts`, `packages/shared/src/messages.ts`, `packages/shared/src/index.ts`, `packages/shared/src/templates.ts` (delete `PLUGIN_REF`; `pluginRef` uses `PLUGIN_REF_PATTERN` until B6), `apps/web/src/lib/form-messages.ts` (the web-only §10.4 lines)
- Test: `packages/shared/src/library.test.ts`, `packages/shared/src/settings-keys.test.ts`, `packages/shared/src/ws.test.ts`, `packages/shared/src/messages.test.ts`, `apps/web/src/lib/form-messages.test.ts`

**Interfaces (produces):**

```ts
export const MARKETPLACE_PATTERN: RegExp; export const RESERVED_MARKETPLACES: readonly string[];
export const OFFICIAL_MARKETPLACES: Record<string, { source: "github"; repo: string }>;
export const PLUGIN_REF_PATTERN: RegExp;  // the one plugin-ref pattern; templates.ts's PLUGIN_REF is deleted
// HOST_SKILL_PATTERN is imported from ./names.ts (hostSkillSchema), never redefined
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
export function reservedKeysIn(settings: unknown): string[];  // the dotted keys set, plus "env.<NAME>" for every name isFactoryEnvName (./config.ts) accepts: the list or the OPEN_FACTORY_ prefix
```

- [ ] **Step 1: Write failing tests.** In `library.test.ts`:
  - `normalizeRepo` accepts `acme/x` and `https://github.com/acme/x.git`, and refuses `https://u:t@github.com/a/b`, `…?x`, `…#y`, `git@github.com:a/b`, `https://gitlab.com/a/b`, `./x` and `../x`;
  - `normalizeSubpath` refuses `a/../b`, `/a` and `./a`;
  - `checkBranchName` refuses `main@{-1}`, `a..b`, `-x`, `x.lock` and `a b`;
  - `checkGitUrl` refuses `http://` and URLs with userinfo, `?` or `#`;
  - `MARKETPLACE_PATTERN` plus the reserved list refuse `inline`, `skills-dir`, `synced`, `builtin` and `claude-plugin-test`;
  - `cutGraphemes("a👩‍👩‍👧b", 2)` never splits the family emoji;
  - a row holding several states resolves to the spec §10.2 winner (`test.each` over the precedence pairs).

  In `settings-keys.test.ts`:
  - `test.each` over the spec §7.10 keys: a settings object setting that key is reported by `reservedKeysIn`, and a harmless sibling key (`permissions.allow`) is not;
  - `reservedKeysIn({ hooks: {}, permissions: { defaultMode: "x" }, env: { OPEN_FACTORY_URL: "/x", FOO: "1" } })` returns `["env.OPEN_FACTORY_URL", "hooks", "permissions.defaultMode"]` (sorted), and an `env` name from `FACTORY_ENV_NAMES` is reported too. (The plugin env names join `FACTORY_ENV_NAMES` in B7.)

  In `ws.test.ts`: `serverMessageSchema` accepts `{ type: "library_changed" }` and refuses an unknown frame type.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/library.test.ts packages/shared/src/settings-keys.test.ts packages/shared/src/ws.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `RESERVED_SETTINGS_KEYS` holds the spec §7.10 list verbatim: `enabledPlugins`, `extraKnownMarketplaces`, `syncClaudeAiPlugins`, `strictKnownMarketplaces`, `permissions.defaultMode`, `permissions.additionalDirectories`, `claudeMdExcludes`, `hooks`, `statusLine`, `fileSuggestion`, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` and `otelHeadersHelper`.
  - Before committing, re-read the shipped Claude Code's settings reference (`curl -sL https://code.claude.com/docs/en/settings-reference.md`, reading only). Add any other key marked "Any file" that runs a command or executable, then pin the list in the test.
  - Add a doc comment saying that I7's `agent` policy reuses this constant.
  - Add the spec §10.4 messages: field messages the server returns ("Can't share your home folder.", "No such branch." …) to shared `MSG`; web-only outcome and load lines ("Couldn't load skills." …) to `FORM_MSG` in `apps/web/src/lib/form-messages.ts`. Reuse `MSG.hostPathStart`, `FIELD_MSG.noFolder` and `FORM_MSG.enterPath` for the folder path instead of adding near-duplicates.
  - Delete `PLUGIN_REF` from `templates.ts`; `pluginRef` uses `PLUGIN_REF_PATTERN` until B6 removes it.
- [ ] **Step 4: Run** the same command plus `pnpm vitest run packages/shared/src/messages.test.ts apps/web/src/lib/form-messages.test.ts` (I4's length tests). Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): Library schemas, patterns and reserved settings keys`.

### Task A2: `skill_sources` table and config rename

**Files:**
- Create: `packages/db/src/schema/library.ts`, the generated migration (`packages/db/migrations/0021_*.sql` on today's branch; merge the latest `origin/chore/faster-tests` first)
- Modify: `packages/db/src/schema/index.ts`, `apps/server/src/config.ts`, `apps/server/src/config.test.ts`, `README.md`, `.env.example`, `apps/server/scripts/smoke-*.ts` (8 files; e.g. `smoke-workspace.ts` creates `host-skills/<name>`), `apps/server/src/test/helpers.ts`, and every `hostSkillsDir` use, including the tests that write skills under it: `routes/agents.test.ts`, `routes/host-skills.test.ts` (deleted in A8), `templates/validate.test.ts`, `templates/template-index.test.ts`, `runtime/docker/docker.int.test.ts`, `workspace/workspace.test.ts`, `workspace/hardening.test.ts`, `workspace/plugins.test.ts`, `agents/start.test.ts`, `agents/start.docker.test.ts`, and `scripts/smoke-harness.ts`
- Test: `apps/server/src/config.test.ts`, `packages/db/src/schema/library.test.ts`

**Interfaces (produces):**
- `config.hostClaudeDir: string` (`FACTORY_HOST_CLAUDE_DIR`, default `~/.claude`, resolved with I6's `expandHome`);
- `config.githubUrl: string` (`FACTORY_GITHUB_URL`, default `https://github.com`);
- the `skillSources` Drizzle table with exactly the spec §5.1 columns, plus `state: "ready" | "adding"` and `startedAt`, so a GitHub add that must re-fetch can show a pending header (spec §10.4).

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`: `FACTORY_HOST_CLAUDE_DIR: "~/c"` gives `hostClaudeDir === join(home, "c")`, and `removedEnvWarnings` returns "FACTORY_HOST_SKILLS_DIR is no longer read; set FACTORY_HOST_CLAUDE_DIR to the Claude folder." for it.
  - `library.test.ts` (schema, CI only): insert, then read back, a GitHub row with `skills: ["a"]` and `trees`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Rename the config field and fix every user: grep `hostSkillsDir|FACTORY_HOST_SKILLS_DIR` and update the smoke scripts, the test helpers, the tests listed above, `.env.example` and the README row.
  - `makeTestApp` sets `FACTORY_HOST_CLAUDE_DIR` to a temp dir and creates `<dir>/skills/`. Every test and smoke script that wrote `<hostSkillsDir>/<name>` now writes `<hostClaudeDir>/skills/<name>`. For tests, `makeTestApp` returns `hostSkillsDir: path.join(config.hostClaudeDir, "skills")`; `Config` itself has no `hostSkillsDir`.
  - Use the S10 precedent for the old name: `REMOVED_ENV` in `config.ts` becomes a record of name → message, and `FACTORY_HOST_SKILLS_DIR` maps to "FACTORY_HOST_SKILLS_DIR is no longer read; set FACTORY_HOST_CLAUDE_DIR to the Claude folder." It is a boot warning only; nothing reads the old variable (ADR 0028: no shim). The variable changes meaning (the skills folder becomes its parent), so the warning is worth its one line.
  - Add the table, merge the latest lower branch, then run `pnpm db:generate`.
- [ ] **Step 4: Run** `pnpm vitest run apps/server/src/config.test.ts` and `pnpm typecheck` (a rename; finds the callers). Expected: PASS. The schema test runs in CI.
- [ ] **Step 5: Commit** `feat: skill_sources table; FACTORY_HOST_CLAUDE_DIR replaces FACTORY_HOST_SKILLS_DIR`.

### Task A3: `redact.ts` and the hardened `runGit`

Implements spec §6.2 Runner.

**Files:**
- Create: `apps/server/src/redact.ts`, `apps/server/src/library/git.ts`
- Modify: `apps/server/src/workspace/plugins.ts` and `apps/server/src/workspace/workspace.ts` (import `redactOutput`, `capOutput` from `../redact.ts`). Move `redactOutput`, `capOutput`, `OUTPUT_MAX_LINES` and `OUTPUT_MAX_BYTES` together; "last 20 lines, at most 4 KB" below is `capOutput`. Leave I3's transcript-specific `apps/server/scripts/sign-in-redact.ts` alone.
- Test: `apps/server/src/library/git.test.ts`, `apps/server/src/redact.test.ts` (move the existing redaction cases out of `workspace/plugins.test.ts`)

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
- [ ] **Step 4: Run** the test, plus `pnpm vitest run apps/server/src/redact.test.ts apps/server/src/workspace/plugins.test.ts`. Expected: PASS.
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
// TemplateIndex validates through the Library (A9) and LibraryIndex reads template groups, so the
// template side is a lazy port, wired in app.ts after both exist (no construction cycle).
export type TemplatesPort = Pick<TemplateIndex, "names" | "localSkillsOf" /* + whatever usedBy needs */>;
export class LibraryIndex {
  constructor(d: { db; hostClaudeDir: string; factoryHome: string; templates: () => TemplatesPort });
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
- [ ] **Step 3: Implement.** Use the `yaml` package (already a dependency) for frontmatter. Discovery is live on every call, with no cache. Move `skillDescription()` from `routes/host-skills.ts` into `readSkillMd` (so A8's delete loses nothing), and `cutGraphemes` with the 200 limit replaces `HOST_SKILL_DESCRIPTION_MAX`. Use `HOST_SKILL_PATTERN` from `packages/shared/src/names.ts`.
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
- `buildMounts({ …, skillPaths: string[] })`, replacing `hostSkillPaths` (in both `buildMounts` and `MountCheckContext`)
- `MountCheckContext.factoryHome` (already there) used for the class `join(realpath(<FH>/state/library/github), id, sha[, name])`, with an lstat walk from `<FH>/state`

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
export const libraryLock: KeyedMutex;  // own instance of KeyedMutex from apps/server/src/workspace/lock.ts
export class SourcesService {
  preview(b: SkillSourcePreviewBody, by: string): Promise<SourcePreview>;  // folder: resolveHostFolder (apps/server/src/host-path.ts) + checkSkillFolder; github: resolveRef + fetchCommit into state/library/preview/<uuid>/
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
- [ ] **Step 2: Run** `pnpm vitest run` on the pure parts of the new test files (the DB parts run in CI). Expected: FAIL (the service is missing).
- [ ] **Step 3: Implement.** The lock order is workspace → Library → store, and the code holding `libraryLock` never awaits a runtime job.
- [ ] **Step 4: Run** the same files (PASS), then push to read CI.
- [ ] **Step 5: Commit** `feat(server): skill sources with pins, updates, Undo and sweeps`.

### Task A8: Library routes; delete `/api/host-skills`

Implements spec §9.1, §9.2, §9.4, §9.5 and §11.1.

**Files:**
- Create: `apps/server/src/routes/library.ts`
- Delete: `apps/server/src/routes/host-skills.ts` and its test (from I2); `hostSkillsResponseSchema`, `HostSkillsResponse` and `HOST_SKILL_DESCRIPTION_MAX` in `packages/shared/src/config.ts`
- Create (web): `apps/web/src/lib/library.ts` with the query options only (`libraryQueryOptions`, `skillQueryOptions(group, name)`, `sourceQueryOptions(id)`); A11 adds `onLibraryChanged` to it.
- Modify (web; the plan is already React-compliant; follow it as written and report any deviation):
  - `apps/web/src/features/config/api.ts`: delete `hostSkillsQueryOptions`;
  - `apps/web/src/features/config/skills-section.tsx`: `SkillPicker` reads `libraryQueryOptions` (host group only, until A14 replaces the picker);
  - `apps/web/src/routes/_app/agents.$slug_.config.tsx`: `void qc.prefetchQuery(libraryQueryOptions)` replaces the host-skills prefetch;
  - `apps/web/src/routes/_app/templates.$name.tsx`: add the same non-awaited prefetch (R-B1).

  After this, `/api/host-skills` has no caller.
- Modify: `apps/server/src/app.ts` (registration, `LibrarySweep`, the `library_changed` publish)
- Test: `apps/server/src/routes/library.test.ts` (CI), `apps/web/src/features/config/sections.test.tsx` and `apps/web/src/test/agent-config-page.test.tsx` (mock `/api/library/skills` instead of `/api/host-skills`)

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
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/config/sections.test.tsx apps/web/src/test/agent-config-page.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Responses are parsed with the shared schemas. Field errors use I4's `fields` shape.
- [ ] **Step 4: Run** the same files and `pnpm typecheck` (deleted exports; finds the callers). Expected: PASS. CI covers the route tests.
- [ ] **Step 5: Commit** `feat(server): Library routes for skills; drop host-skills`.

### Task A9: Effective library, validation, linking, start checks, change flow

Implements spec §6.4, §6.6, §7.3 step 3, §7.10, §8 and AC 5–7.

**Files:**
- Create: `apps/server/src/workspace/agent-folders.ts`
- Modify:
  - `apps/server/src/workspace/links.ts` (`resolveHostSkills` deleted; `linkSkills`'s `host: {dir, skills}` param becomes `library: {name, dir}[]`, with prefixes from `LibraryIndex`: host `skills/`, each folder source, the GitHub cache root);
  - `apps/server/src/workspace/workspace.ts`: `Workspace` takes `library: LibraryIndex` instead of `hostSkillsDir`; both `materialize` (check-only, at create) and `prepare` use `resolveSkills(lib, names)`;
  - `apps/server/src/templates/validate.ts` (`validateEffective`; `ValidationContext.hostSkillsDir` → `library: Pick<LibraryIndex, "resolveSkill">`);
  - `apps/server/src/templates/template-index.ts` (`context()` passes `library`; `rescan()` on `libraryChanged`, so stored template issues don't go stale);
  - `apps/server/src/agents/agent-service.ts` (the `overlayIssues` ctx);
  - `apps/server/src/agents/config-resolver.ts`, `apps/server/src/agents/config-changes.ts`;
  - `apps/server/src/agents/agent-runtime.ts` (`requestRestart`: `current` returns `{doc, library}` and is compared with `this.started` as `{doc, library}`), `apps/server/src/agents/runtimes.ts` (`requestRestart` passthrough);
  - `apps/server/src/app.ts` (construct `LibraryIndex` with a lazy `templates` port, then `TemplateIndex` with it, then `Workspace` with `library`), `apps/server/scripts/smoke-harness.ts`;
  - `packages/shared/src/config-changes.ts`;
  - `apps/web/src/features/config/config-page.tsx` (its pre-save restart summary calls `describeDocChanges`).
- Test:
  - `apps/server/src/workspace/agent-folders.test.ts`, `apps/server/src/workspace/links.test.ts`, `apps/server/src/workspace/workspace.test.ts`;
  - `apps/server/src/templates/validate.test.ts`, `apps/server/src/templates/template-index.test.ts` (their ctx gains `library`);
  - `packages/shared/src/config-changes.test.ts`;
  - `apps/server/src/agents/config-changes.test.ts` (CI).

**Interfaces (produces):**

```ts
// agent-folders.ts
export async function scrubAgentFolders(workdir: string): Promise<void>;            // empty .claude-config/{skills,agents,commands} via SafeFs
export async function checkProjectSettings(workdir: string): Promise<void>;  // .claude/settings.json + settings.local.json; lstat; link fails; reservedKeysIn → WorkspaceError naming file and key
export async function checkAgentFrontmatter(workdir: string, factoryLinks: Set<string>): Promise<void>;   // non-factory .claude/skills/*/SKILL.md hooks; .claude/agents/*.md hooks|mcpServers; .claude/commands/*.md hooks
export async function checkSkillPlugins(workdir: string): Promise<void>;           // every .claude/skills entry: stat(<entry>/.claude-plugin) → fail
// links.ts
export async function resolveSkills(lib: LibraryIndex, names: string[]): Promise<{ name: string; dir: string }[]>;  // fails with the §6.6 message for the reason
// config-resolver.ts: Effective gains
library: { skills: Record<string, string>; plugins: Record<string, string> };  // plugins {} in PR 1
// shared config-changes.ts
export function describeDocChanges(a: ConfigDoc, b: ConfigDoc): string[];  // today's describeChanges body, renamed; the web's pre-save summary uses it (no library client-side)
export function describeChanges(a: { doc: ConfigDoc; library: Library }, b: { doc: ConfigDoc; library: Library }): string[];  // [...describeDocChanges, ...libraryLines], sorted
// config-changes.ts (server)
libraryChanged(e: { skills?: string[]; plugins?: string[]; by: string }): Promise<void>;  // also triggers templates.rescan()
// ConfigChangeAgents port: currentDoc() becomes currentEffective(): Promise<{ doc; library } | undefined>;
// a new allLive() (or liveUsing(skills, plugins)) lists the runtimes libraryChanged must compare;
// templateChanged/apply resolve both sides' library through LibraryIndex; runtimes.startedOf(id) is used whole, not .doc
```

Every current caller of `describeChanges(ConfigDoc, ConfigDoc)` moves: `agents/agent-runtime.ts` (`requestRestart`), `agents/config-changes.ts` (`templateChanged` gate and `apply`) and `runtimes.startedOf(id)?.doc` take `{doc, library}`; the web `config-page.tsx` takes `describeDocChanges`.

- [ ] **Step 1: Write failing tests.**
  - `agent-folders.test.ts`:
    - `settings.local.json` with `{ "hooks": {} }` fails with "….claude/settings.local.json sets hooks, which agents can't set; remove it.";
    - the test iterates **every** key in `RESERVED_SETTINGS_KEYS` for both files;
    - `env.OPEN_FACTORY_URL` and a `FACTORY_ENV_NAMES` entry fail, and `env.FOO` passes;
    - a link at `.claude/settings.json` fails;
    - an agent-written skill folder whose `SKILL.md` declares `hooks` fails, while a factory link to a Library skill with hooks passes;
    - `.claude/agents/a.md` with `hooks` fails, and so does one with `mcpServers`;
    - `.claude/commands/c.md` with frontmatter `hooks` fails (owner plan review change 5; kept even if G1 shows commands can't declare hooks, since the check is cheap and stays closed);
    - `.claude-config/{skills,agents,commands}` are emptied, and a link there is removed as a link;
    - a `.claude/skills/x` link the agent made to a folder holding `.claude-plugin/` fails.
  - `links.test.ts`: the drop-unlisted pass removes links under every known prefix and leaves a real folder.
  - `validate.test.ts`: each §6.6 message, and the template-local collision in templates and overlays.
  - `config-changes.test.ts` (shared): "skill x updated a1b2c3d → e4f5a6b", "skill x now from GitHub", a library-only difference is non-empty, and `describeDocChanges` equals today's doc-only output.
  - `workspace.test.ts`: `materialize` refuses a skill the Library can't resolve, with the §6.6 message.
  - Server `config-changes.test.ts` (CI): a GitHub update writes `config_changed` and requests a restart only for agents using the skill, compared against `started.library`; a template whose skill became `missing` shows the issue after `libraryChanged` (rescan).
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/workspace/agent-folders.test.ts apps/server/src/workspace/links.test.ts apps/server/src/workspace/workspace.test.ts apps/server/src/templates/validate.test.ts apps/server/src/templates/template-index.test.ts packages/shared/src/config-changes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `materialize`, skills are resolved and linked check-only, as today with host skills. In `prepare`, the order is:
  1. resolve and link skills;
  2. `checkSkillPlugins`;
  3. `scrubAgentFolders`;
  4. `checkProjectSettings`;
  5. `checkAgentFrontmatter`;
  6. the rest as I2 has it.

  `Effective.library.skills` comes from `resolveSkill` refs.
- [ ] **Step 4: Run** the same files and `pnpm typecheck` (signature changes; finds the callers). Expected: PASS (the CI parts in CI).
- [ ] **Step 5: Commit** `feat(server): Library skills at start, reserved settings and frontmatter checks, library change flow`.

### Task A10: Web primitives: untrusted text, checkbox, multi Combobox

The plan is already React-compliant; follow it as written and report any deviation.

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
  - an optional `trigger` prop lets the caller supply the trigger; without it the existing `<button data-slot="combobox-trigger">` stays the default, since `PickAdd` and every current picker rely on it;
  - the leave-out snapshot is taken in the existing open handler (`onOpen`), per R-C1;
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
  - Checkbox (new file `components/ui/checkbox.test.tsx`): a disabled checkbox exposes `disabled` and `data-state`, and a click doesn't change it. The disabled shapes themselves (no opacity) are checked in the A16 browser evidence, not in jsdom.
  - `UntrustedCode` builds on `components/code-text.tsx`'s mono styling if it fits, rather than duplicating its classes.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/components/untrusted-text.test.tsx apps/web/src/components/ui/checkbox.test.tsx apps/web/src/components/ui/combobox.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The single-value Combobox behaves exactly as before (run its existing test file). The live region is rendered by the caller, outside the popover. `renderOption` stays a module-level function at every call site (R-H1).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): untrusted text, disabled checkbox shapes and a multi-pick Combobox mode`.

### Task A11: Skills route, header, nav, lists and states

Implements spec §10.1, §10.2, §10.7 and §10.8 (skills). The plan is already React-compliant; follow it as written and report any deviation.

**Files:**
- Create:
  - `apps/web/src/routes/_app/skills.tsx`, `apps/web/src/routes/_app/skills.index.tsx`;
  - `apps/web/src/features/skills/skills-header.tsx`, `skill-list.tsx`, `source-header.tsx`, `row-state.tsx`, `use-library-arrival.ts`;
  - `apps/web/src/components/elapsed.tsx` (moved from `features/session/activity-line.tsx`, R-E1).
- Modify:
  - `apps/web/src/lib/library.ts` (from A8: add `onLibraryChanged`, R-Q3), `apps/web/src/routes/_app.tsx` (`onMessage` calls it for `library_changed`);
  - `apps/web/src/components/app-sidebar.tsx` (the nav array: Skills between Templates and Schedules, icon `Blocks`);
  - `apps/web/src/features/shortcuts/global-shortcuts.tsx` (`g k` is free), `shortcuts-sheet.tsx`;
  - `apps/web/src/features/palette/rank.ts` (`GO_TO` gains `{ id: "skills", label: "Skills", to: "/skills" }`);
  - `apps/web/src/lib/row-nav.ts` (rows by `data-row`, R-L1) and the lists that use it (tasks, agents, inbox: add `data-row` to their row anchors);
  - `apps/web/src/features/session/activity-line.tsx` (imports `Elapsed`).
- Test:
  - `apps/web/src/features/skills/skill-list.test.tsx`, `skills-header.test.tsx`;
  - `apps/web/src/lib/library.test.ts` (10 frames → one invalidation);
  - `apps/web/src/test/shell.test.tsx` (the nav item and the nav-order string), `apps/web/src/test/global-shortcuts.test.tsx` (`g k`), `apps/web/src/test/row-nav.test.tsx`.

**Interfaces (produces):**
- `onLibraryChanged(qc)` (module-level 250 ms coalescer, R-Q3);
- `<RowState state since? />`, which maps `ROW_STATE_ORDER` to its icon and colour per spec §10.2; the "installing/checking" icons use `components/ui/spinner.tsx` (the ui-contract test allows only it to spin), and it renders `<Elapsed since hideUnderMs={10_000} />` from the server's `since`;
- `useLibraryArrival()` (R-L4: reuses `arrive` and `useArrivalTint` from `@/lib/use-arrival`), which reads `{ peek }` from router state, scrolls the row to the centre, focuses it with the arrival tint, and opens its peek.

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
    - the actions have accessible names when shown icon-only (the icon-only switch below `sm` is checked in the browser evidence).
  - `shell.test.tsx`: the nav order string becomes "Inbox, Tasks, Templates, Skills, Schedules, Usage, Settings"; `global-shortcuts.test.tsx`: `g k` navigates and `g s` still opens Schedules; the palette Go to lists Skills.
  - `row-nav.test.tsx`: `j`/`k` move across `data-row` anchors and buttons alike.
  - Arrival (R-L4): a second arrival on the mounted page opens its peek; a `library_changed` after arrival doesn't scroll again.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills apps/web/src/lib/library.test.ts apps/web/src/test/shell.test.tsx apps/web/src/test/global-shortcuts.test.tsx apps/web/src/test/row-nav.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The route loader follows R-B1: `void qc.prefetchQuery(hostQueryOptions)`, then `await Promise.allSettled([...])` on `libraryQueryOptions`.
  - No effect fetches, and no derived state is held in an effect.
  - At ≥54rem of container, the peek gets the `@container` + `@[54rem]:data-[open]:pr-[30rem]` treatment.
  - F6 moves into the peek (the `task-list.tsx` pattern).
- [ ] **Step 4: Run** the same files, plus the existing tests of the lists whose anchors gained `data-row` and of `activity-line`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Skills page, nav and grouped skill list`.

### Task A12: Source and skill peeks, update view, View file

Implements spec §10.3 (skill and source peeks) and §10.6. The plan is already React-compliant; follow it as written and report any deviation.

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
  - A peek renders from the cached list row first, then refines from the detail query (R-L2: a module-level `select` factory memoised on `[group, name]`; never `initialData`, `placeholderData` or an effect).
  - Check for updates, Find more skills and Update are mutations (R-Q1); their results are dropped during render when the peek retargets.
  - The Undo toast window comes from `undoUntil` in the remove handler (R-T1).
  - Section components (Runs code, Files, Used by, Provenance) and static skeleton rows are module-level (R-H1).
  - Keyboard opening and retarget are instant; a click uses the sheet motion.
  - Back is instant and refocuses the row it came from; Esc closes the whole peek.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): source and skill peeks with in-place updates`.

### Task A13: Add skills sheet

Implements spec §10.4 (Add skills). The plan is already React-compliant; follow it as written and report any deviation.

**Files:**
- Create: `apps/web/src/features/skills/add-skills-sheet.tsx`, `add-skills-results.tsx`
- Modify: `apps/web/src/features/sheets/sheet-store.ts` (`SheetSpec` gains `{ kind: "add-skills" }`), `apps/web/src/features/sheets/sheet-bodies.ts` (an entry with `load`, `prefetch: warm(qc, hostQueryOptions)` and `title`)
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
  - (Browser evidence, A16: on phones there is a single scroller, with no nested scrolling list.)
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills/add-skills-sheet.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with `FormFrame` (kind `"sheet"`), `useFieldErrors`, `FormOutcome` and `PathField`. The draft that survives close uses `features/sheets/drafts.ts`. Find is a `useMutation` (R-Q1) with the `AbortController` in a ref (R-L3): a new Find aborts the previous one in its click handler, Close aborts in its handler, and the unmount cleanup is the only effect. Ticks follow R-F1. The 300 ms inert primary is set in Find's `onSuccess` (R-T1), not in an effect.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Add skills sheet with find, pick and stale results`.

### Task A14: Skill picker in the Configuration form

Implements spec §10.5 (skills). The plan is already React-compliant; follow it as written and report any deviation.

**Files:**
- Modify:
  - `apps/web/src/features/config/skills-section.tsx` (I2's `SkillsSection`/`SkillPicker`/`LocalSkills`);
  - `apps/web/src/features/config/config-list.tsx` (I2): add `labelAction?: ReactNode`, rendered in the "This agent" label row (agent mode) and in the list label row (template mode); the per-row source tag, pin and state go through the existing `format` prop;
  - `apps/web/src/features/config/pick-add.tsx`: use the A10 multi Combobox with a caller trigger.
- Test: `apps/web/src/features/config/skills-section.test.tsx` (new), plus `apps/web/src/features/config/sections.test.tsx` and `apps/web/src/test/agent-config-page.test.tsx`, `apps/web/src/test/template-config-tab.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - The ghost "Add skill" sits in the "This agent" label row (agent mode) or the list label row (template mode).
  - Options are grouped by source with `MiddleTruncate` headings.
  - Picking keeps the popover open, marks the option "Added", and announces "Added tdd" from a live region outside the popover.
  - A reopened popover leaves out picked skills.
  - Hidden, unusable and missing skills, and names matching the template's local skills, are left out, with the footer "3 skills can't be used here: hidden or unusable."
  - A selected row shows "GitHub · a1b2c3d" and any state.
  - Template-local skills are read-only "Template skill".
  - The plugins input stays as I2 built it, until Task B11.
  - The picker doesn't fetch on mount: the Library list is already in the cache from the route prefetch (R-B1).
- [ ] **Step 2: Run** the test files above. Expected: FAIL.
- [ ] **Step 3: Implement.** `added` is memoised on a primitive key (R-C1: `names.join("\0")`). The grouped `renderOption` is module-level like today's `renderSkill` (R-H1). Template-local names come from the draft, derived during render.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Library skill picker in the Configuration form`.

### Task A15: DESIGN.md amendments (PR 1)

- [ ] Apply spec §16 amendments 1–6 to `DESIGN.md`, verbatim. Amendment 3 covers skills and files now, plugins later. Commit `docs: DESIGN.md amendments for the Skills page`.

### Task A16: Finish PR 1

- [ ] **Branch review.** A fresh reviewer, read-only, on `git diff spec/i5-skills-and-plugins...i5/1-library-skills` against spec §5, §6, §7.3 step 3, §7.10, §8–§10 and AC 1–7. It checks:
  - ADR 0028: no compatibility code; the old env var is never read, only named by the `REMOVED_ENV` boot warning;
  - hardened runners: argv, env and redaction tests present;
  - the I4 message rules;
  - **the React diff against `vercel-react-best-practices`**: the reviewer invokes the skill first. Next-only rules are skipped, and the review says so. It covers effects only for external sync, no fetch in effects, stable query keys, no components defined inside components, abort on unmount for Find, and loaders that never await the host query, plus every R-Q, R-E, R-L, R-C, R-F, R-H, R-B, R-T and R-P rule in Global Constraints, that the `library_changed` coalescer is module-level (not per render), and that arrival uses `arrive`/`useArrivalTint`. This checklist is reused by B11 and C3.

  Apply fixes as their own commits (apps/web fixes follow `vercel-react-best-practices`).
- [ ] **Full verification, once for the Part** (the only full run in Part A):
  - `pnpm install --frozen-lockfile` (no lockfile change), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; if the local full suite is flaky, CI is the authority;
  - the dev loop from a clean clone: `git clone` the branch into a temp dir, `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm dev` with a throwaway DB, fake Claude, a temp `FACTORY_HOST_CLAUDE_DIR` holding one skill and `FACTORY_GITHUB_URL=file://<fixture>`;
  - load `/skills`, then shut down and remove the clone.

  DB tests: confirm them in CI.
- [ ] **Real-browser evidence.** Use the harness at `/Users/orlevi/projects/open-factory/docs/product/ui-review/u4-evidence/harness` through its own `run.sh` lock. Fake Claude only, and the fixture repo through `FACTORY_GITHUB_URL=file://…` (built with `makeFixtureRepo`), never the network. Chromium and WebKit headless.
  - Add `i5a_*.py` checks for AC 1–7.
  - Widths: 1440, 1024, 390 and 375px, plus 390px at 200% text, in light and dark.
  - Look and layout that jsdom tests don't assert: the disabled checkbox shapes (no opacity), icon-only header actions below `sm`, and a single scroller in Add skills on phones.
  - Worst-case data from spec §14: a 40-skill source, a 64-character name, 190 users, zero-found and all-unpickable repos, a failing check, a 200-character subject ending in an emoji, a 120-character path.
  - Measure and record the §10.1 header thresholds.
  - Screenshots and a results table go to `docs/product/ui-review/i5-evidence/` in the main checkout (gitignored).
- [ ] **Push and PR.**
  - `git fetch origin`, merge the latest `origin/chore/faster-tests`, push `i5/1-library-skills`, and get CI green on the branch (fix failures as commits).
  - Then open the PR **ready for review (not draft)** with base `chore/faster-tests`.
  - Title: `feat: skills Library with host, folder and pinned GitHub sources`.
  - Body per `.github/pull_request_template.md`, linking the spec, this plan and #153. State the reset step, the env rename, the deletion of `/api/host-skills`, and that DB tests run only in CI. End with the attribution line.
  - Confirm `gh pr checks` is green. Never merge; Or merges the stack.

---

# Part B: `i5/2-plugins` (PR 2)

Implements spec §2 AC 8–15, §7 (the plugin design Or approved on 2026-11-24: Claude Code installs per agent at start; the factory runs no installer), the plugin parts of §8–§10, §11, §13 and DESIGN.md amendment 7. The branch exists and already holds B0's first pin (2.1.327), B1's first G1 scripts and `timing.sh`; B0 and B1 below redo them for the new design.

**Reset step:**
- drop the database and recreate agents;
- templates listing `plugins:` fail validation: move them to `settings.json` `enabledPlugins`, add their marketplaces in Skills, and pick the plugins again in each template (that writes the pins).

**What PR 2 no longer builds** (the old shared-store tasks; never implemented, nothing to revert): `StoreRunner`, the seed and `CLAUDE_CODE_PLUGIN_SEED_DIR` use, `storeLock`, the install journal and `bootRecover`, `provenance.json`, the update-preview copy, the start's store check and install, background installs on save, `install`/`install-in-factory`/`update-preview`/`update` plugin routes, the store mount class, `useHeldWhileInside` (rows no longer move between groups), and the `failed` marketplace row.

### Task B0: Pin the base image's Claude Code to 2.1.331

Implements spec §7.9. Already on the branch: `images/base/claude-code-version` (2.1.327), and `.github/workflows/base-image.yml` reading it.

**Files:**
- Modify: `images/base/claude-code-version` (`2.1.331`), `.github/workflows/base-image.yml` (delete any text about the 14-day release-age wait for this pin; the comment says the version changes only through this file), `scripts/g1/run.sh` and `scripts/g1/timing.sh` only if they hard-code 2.1.327.

- [ ] **Step 1:** Write `2.1.331`. The repo's release-age rule for dependencies stays; it doesn't apply to the Claude Code pin while pre-release (Or). Record the release date from the release manifest in the commit body.
- [ ] **Step 2:** `actionlint` if installed; otherwise review the YAML diff. CI builds the image.
- [ ] **Step 3: Commit** `chore(image): pin Claude Code 2.1.331`.

### Task B1: Gate G1 scripts for the container design (for Or; blocks B2 onward)

Implements spec §13 as rewritten. **The executor writes the scripts but never runs them**; G1 is Or's manual step. Never read `~/.claude`, `~/.open-factory-spike` or a keychain.

**Files:**
- Modify: `scripts/g1/run.sh`, `scripts/g1/report-template.md`, `scripts/g1/fixture/make-fixture.sh`, `scripts/g1/fixture/README.md`
- Keep: `scripts/g1/timing.sh` (item 20); change it only to read the version from `images/base/claude-code-version` and to add the two session-start timings when `CLAUDE_CODE_OAUTH_TOKEN` is set.

- [ ] **Step 1: The container harness in `run.sh`.**
  - It refuses to run outside Docker's control (it only orchestrates `docker run --rm` from the pinned agent image, `open-factory-base:<pin>` or the tag Or passes) and refuses when `HOME` contains `.open-factory-spike`. Nothing is installed on the host.
  - Each item runs in a fresh container. The agent's plugins dir is a host temp dir `$P` mounted read-write at the same path, with `CLAUDE_CODE_PLUGIN_CACHE_DIR=$P`; items 3, 5–8, 10 and 12 reuse `$P` across runs; every other item starts empty.
  - The agent env is spec §7.3's: `CLAUDE_CONFIG_DIR=$AG`, an empty `skills/`, `DISABLE_AUTOUPDATER=1`, `FORCE_AUTOUPDATE_PLUGINS=1` only in items 5 (its second run, with a Latest marketplace declared alongside), 7 and 8, and `--settings "$(cat $S/plugin-settings.json)"`.
  - A credential is passed only to session items, only as `-e CLAUDE_CODE_OAUTH_TOKEN` from Or's shell; the script never writes it to disk or to the report.
  - Full stream capture to `out.jsonl`; `init` selected with `jq`; `set -eu`; `$MARK` checks with `test -z "$(ls -A $MARK)"`.
  - `claude --version` inside the image must equal `images/base/claude-code-version`, or the script stops.
- [ ] **Step 2: Items.** Delete the old items 2, 3, 4, 10, 11, 14 and 15 (seed, install-doesn't-pull, ref-less refetch, store update path, store auto-update, preview copy, runner auto-add) and everything that built the seed or the runner config. Renumber to spec §13's 0–21:
  - **new:** 0 (file-URL git marketplace), 2 (install at start, with and without `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`), 3 (the per-agent plugins dir and persistence), 4 (pins: commit, tag, branch; the official marketplace's commit and tag; (f) `obra/superpowers-marketplace` at a fixed commit), 5 (a pinned plugin stays, including the ten-minute session, run without and with FORCE), 6 (repin, plus the `autoUpdate: true` fallback run if the new version doesn't load), 7 (Latest updates on restart, with and without `FORCE_AUTOUPDATE_PLUGINS=1`; `claude --version` unchanged), 8 (network down, installed: `--network none`), 9 (network down, missing);
  - **extended:** 1 also records the `init.plugins` entry shape and whether `init` comes before the first message; 20 also records (e) the spawn-to-`initialize` time, cold and warm, with 1 and 3 plugins, when a credential is set;
  - **rethought:** 10 (the agent's own install is disabled by an explicit `false` at the next start; record whether its marketplace stays and refreshes), 12 (`data/` and `mcpb/` land under `$P`), 13 (no plugin code at install, at the start install, at repin and at the dependency install);
  - **kept as written, renumbered:** 1, 11, 14–19 (old 1, 5, 9, 12, 13, 16, 17, 18), 20 (timing) and 21 (floor, over items 1–9, 12, 15, 19).
- [ ] **Step 3: Fixtures without GitHub where possible.** `make-fixture.sh` builds (a) the directory marketplace (`marker`, `dep`, `ranged`, the `defaultEnabled` plugin, an external `git-subdir` entry with a `sha` pointing into (b)), and (b) a local **bare** git repo of the same tree with two commits and tag `v1` on the first, both mounted read-only into the containers. Item 0 decides whether (b) works as `{"source":"git","url":"file:///fixture/acme.git"}`; if not, `run.sh` reads `G1_GITHUB_REPO=<or>/of-g1-fixture` for items 4–9 and the README gives the push steps. Items 5–7 "push" the second commit by updating (b) between runs (or the GitHub repo when used).
- [ ] **Step 4: The report.** `report-template.md` follows spec §13 "The report": version, image digest, network and host, whether item 0 made GitHub unnecessary, then each item PASS/FAIL/RECORDED with its evidence, then a "Fills" list (Latest env rule, `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, `OFFICIAL_MARKETPLACES` pin rules, `plugin_not_loaded` copy, floor).
- [ ] **Step 5:** `bash -n scripts/g1/*.sh scripts/g1/fixture/*.sh` and `shellcheck` if installed. Commit `chore: Gate G1 in containers for per-agent plugin installs`.
- [ ] **Step 6: Stop.** Hand off to tech-lead-i5 / main: "G1 is ready: Or runs `scripts/g1/run.sh` against the image with Claude Code 2.1.331, passing `CLAUDE_CODE_OAUTH_TOKEN` for the session items, and posts `report.md` on #153." Tasks B2 onward start only after Or's report. **Any FAIL goes back to owner-i5; item 2 failing goes to Or (spec P6).** The RECORDED items fill the constants in B3, B6 and B7.

### Task B2: Fake Claude: install at session start

Implements the fake side of spec §7.3 steps 4–8 and §14 "Starting with plugins".

**Files:**
- Modify: `packages/harness/testing/fake-claude.mjs` (replace the `argv[0] === "plugin"` block, which served the factory's per-agent installs deleted in B7; ADR 0028)
- Test: `packages/harness/testing/fake-plugin.test.ts` (next to I3's `fake-setup-token.test.ts`)

**Behaviour.** Follow the shape of I3's `setup-token` mode (an early branch, env knobs, no fall-through):
- **At session start**, before it emits `init`, the fake reads `--settings` and, for each `enabledPlugins` key set to `true` whose marketplace is declared in `extraKnownMarketplaces` with a `directory` or `git` (`file://`) source, "installs" it into `$CLAUDE_CODE_PLUGIN_CACHE_DIR`: it copies the plugin from the fixture at `ref` (the git source is cloned at `ref`; no `ref` means HEAD) into `cache/<mkt>/<plugin>/<version>/`, and writes `installed_plugins.json` and `known_marketplaces.json` in the v2 shape of spec §4. A key already installed at the same commit is skipped. Each install appends `install <key> <commit> <dir>` to `$FAKE_CLAUDE_DIR/plugin.log`.
- `init.plugins` lists every key that is `true` and installed, each with its `path`; a `false` key never appears, installed or not.
- `FAKE_CLAUDE_PLUGIN_SCENARIO=install-fail` installs nothing (as if the network were down) and still emits `init`; `slow` sleeps `FAKE_CLAUDE_PLUGIN_SLEEP_MS` before installing. Set through `createFakeClaude({ env })`.
- A `{ "source": "github", "repo": "o/r" }` declaration is cloned from `${FAKE_CLAUDE_GITHUB_URL}/o/r.git`; tests set it to the same `file://` root as `FACTORY_GITHUB_URL`, so a marketplace the factory registered (and pins) installs end to end. The fake honours `ref` (a commit or a tag) and logs the commit it installed.
- `--version` prints `${FAKE_CLAUDE_VERSION ?? "2.1.331"} (Claude Code)`, and the `initialize` response's `claude_code_version` uses the same default (today it hard-codes 2.1.327).
- `claude plugin …` subcommands are no longer faked: the factory never runs them, so a call fails loudly ("fake claude: plugin subcommands aren't used by Open Factory").

- [ ] **Step 1: Write failing tests:** a cold start installs the declared plugin at its `ref` and lists it in `init`; a `github`-source declaration with a commit `ref` installs that commit from `FAKE_CLAUDE_GITHUB_URL`; a second start installs nothing; a changed `ref` installs the new version; no `ref` takes HEAD; a `false` key isn't loaded; `install-fail` emits `init` without the plugin; `--version`.
- [ ] **Step 2: Run** `pnpm vitest run packages/harness/testing/fake-plugin.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep `FAKE_CLAUDE_PLUGIN_FAIL` and `_SILENT_FAIL` working until B7 deletes their last users (`workspace/plugins.test.ts`, `agents/agent-service.test.ts`, the spawn-service tests); B7 deletes them.
- [ ] **Step 4: Run** → PASS, plus `pnpm test:related packages/harness/testing/fake-claude.mjs`.
- [ ] **Step 5: Commit** `test: fake Claude installs declared plugins at session start`.

### Task B3: `marketplaces` table and the version floor

Implements spec §5.1 (marketplaces) and §7.9.

**Files:**
- Modify: `packages/db/src/schema/library.ts` (+ generated migration; merge the lower branch first), `packages/harness/src/claude/version.ts` (`MIN_CLAUDE_VERSION = "2.1.331"`, or G1 item 21's older floor), `apps/server/src/agents/runtimes.ts` (imports `versionCheckEnv` from `library/claude-flags.ts`)
- Create: `apps/server/src/library/claude-flags.ts`
- Test: `packages/db/src/schema/library.test.ts` (CI), `apps/server/src/library/claude-flags.test.ts`

**Interfaces (produces):**

```ts
// marketplaces: exactly spec §5.1, including `tags` (no previewSource, previewCommit, error or "failed" state)
export function versionCheckEnv(server: NodeJS.ProcessEnv): Record<string, string>;  // moved from agents/runtimes.ts
export async function assertPluginFloor(bin: string, env): Promise<void>;  // on the harness checkClaudeVersion; throws "Claude Code {found} is too old; update it to {MIN_CLAUDE_VERSION} or later."
export async function checkImageClaudeVersion(image: string, digest: string): Promise<void>;  // docker run --rm --network none --entrypoint claude <image> --version, cached by digest
```

- [ ] **Step 1: Write failing tests:** an unknown `state` is refused by the table (CI); fake Claude with `FAKE_CLAUDE_VERSION=2.1.1` makes `assertPluginFloor` fail with the interpolated message, and at the floor it passes; the image check runs `docker` once per digest (a fake `docker` on `PATH` counts its runs).
- [ ] **Step 2: Run** the local test file → FAIL.
- [ ] **Step 3: Implement.** No `storeLock`, no `StoreRunner`.
- [ ] **Step 4: Run** → PASS (the schema test in CI).
- [ ] **Step 5: Commit** `feat(server): marketplaces table and the Claude Code floor`.

### Task B4: Marketplaces service

Implements spec §7.1 and AC 8. No Claude Code anywhere.

**Files:**
- Create: `apps/server/src/library/marketplaces-service.ts`, `apps/server/src/library/plugin-sources.ts` (external `sha` sources, §7.5)
- Modify: `apps/server/src/library/library-sweep.ts` (marketplace previews, purge of unreferenced checkouts, boot removal of `adding` rows)
- Test: `apps/server/src/library/marketplaces-service.test.ts` (pure parts local, DB parts in CI), `apps/server/src/library/plugin-sources.test.ts`

**Interfaces (produces):**

```ts
export class MarketplacesService {
  preview(b: { kind: "github"; repo } | { kind: "git"; url } | { kind: "directory"; path }): Promise<MarketplacePreview>;  // runGit fetch (§6.2) into a preview; name, commit, plugins with pinnable/refusedReason
  add(previewId: string, by: string): Promise<{ status: 201 | 202; marketplace: MarketplaceDetail }>;  // Library lock; move the preview to state/library/marketplaces/<name>/<sha>/, or re-fetch (202, "adding")
  check(name: string): Promise<MarketplaceDetail>;     // ls-remote (heads and tags); preview fetch; update*, tags, or checkError
  update(name: string, commit: string, by: string): Promise<MarketplaceDetail>;  // moves the Library's commit only
  fetchAt(name: string, ref: string): Promise<{ sha: string }>;  // a pinned commit or tag Skills hasn't read; records the tag; refuses a branch ("Pin acme to a commit or a tag.")
  checkout(name: string, commit?: string): Promise<string | null>;  // the read-only dir, or null when not read
  remove(name: string): Promise<{ undoUntil: string }>; restore(name: string): Promise<MarketplaceDetail>;
}
export async function readPluginSource(src: ExternalSource, sha: string): Promise<string>;  // state/library/plugin-sources/<hash>/<sha>/, read-only, runGit
```

- [ ] **Step 1: Write failing tests** (fixture repo through `FACTORY_GITHUB_URL=file://…`):
  - the preview reads the catalog at the resolved commit; `claude-plugins-official` with a non-Anthropic source is refused; a taken name (ready, adding, or soft-deleted in its window) is refused;
  - add leaves a read-only checkout at `<name>/<sha>/` and a `ready` row; an expired preview re-fetches and returns 202; boot removes a row left `adding`;
  - check stores `update*`; the update view lists plugins whose catalog entry changed and relative plugins whose tree changed, `runsCodeChanged` first; update moves `commit` and changes no template file;
  - preview and check record `tags` (an annotated tag resolves through `^{}`); `fetchAt` creates a checkout at a commit and at a tag (recording it), and refuses a name that is a branch; purge keeps a checkout a declaration or a loaded runtime's `started.library` references, and removes one nothing references;
  - remove is refused with up to three users named while a template declares the marketplace;
  - a marketplace update restarts no agent (CI: a running agent of a template that uses the marketplace has no `config_changed` event);
  - `readPluginSource` fetches an external `git-subdir` source at its `sha` read-only, and refuses userinfo, `?`, `#` and a leading-dash argument;
  - failures are redacted.
- [ ] **Step 2: Run** the pure parts: `pnpm vitest run apps/server/src/library/plugin-sources.test.ts apps/server/src/library/marketplaces-service.test.ts -t pure` → FAIL.
- [ ] **Step 3: Implement** on A4's `git-fetch.ts` and A7's locks; the marketplace checkout cap is the §6.2 50 MB.
- [ ] **Step 4: Run** → PASS (DB parts in CI).
- [ ] **Step 5: Commit** `feat(server): marketplace registry with read-only checkouts per commit`.

### Task B5: Plugin contents, needs from the image, and diffs

Implements spec §7.8 and the diff of §7.5.

**Files:**
- Create: `apps/server/src/library/plugin-contents.ts`
- Test: `apps/server/src/library/plugin-contents.test.ts`

**Interfaces (produces):** `readContents(root: string): Promise<PluginContents>` and `diffContents(a: PluginContents, b: PluginContents): ContentsDiff`, where

```ts
type PluginContents = {
  manifest; hooks: HookRow[]; mcp: McpRow[]; dependencies: string[];
  codeParts: CodePart[];  // lsp, statusLine, monitors, bin, node
  needs: string[];        // program names, sorted, unique (spec §7.8 "Needs from the image")
  provides: { skills; commands; agents; outputStyles };
  unshown: string[]; files: string[]; summary: ContentsSummary;  // summary.needs = needs.length
};
```

- [ ] **Step 1: Write failing tests** on temp plugin dirs:
  - hooks inline and from `hooks/hooks.json`; MCP stdio with env (non-`${…}` values shown) and http with header **names** only; LSP, statusLine, monitors, `bin/` and `package.json`;
  - `needs`: `npx -y x` gives `npx`; `bash -c "uvx tool"` gives `uvx`; an MCP `command: "bun"` gives `bun`; a `package.json` gives `node`; `${CLAUDE_PLUGIN_ROOT}/scripts/x.sh` is not a need;
  - `unshown` for a `hooks.json` link, a 300 KB JSON, bad JSON, a walk stopped at 2,000 files, and an unknown `plugin.json` key;
  - `files` lists only referenced regular files inside the root;
  - `diffContents` reports a hook added, an MCP server removed, a changed dependency and a new need, with code-running changes flagged.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/plugin-contents.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Cache by checkout path.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): plugin contents with needs from the image, and contents diffs`.

### Task B6: Declarations and pins; `plugins:` removed

Implements spec §7.4, §7.7, §8.1 (plugins), §8.2 (plugin lines) and R14.

**Files:**
- Modify:
  - `packages/shared/src/templates.ts`: remove `plugins` from `templateConfigSchema`, `templateYamlShape` and the `normalize` mapping; delete `PLUGIN_REF_MSG` and `pluginRef`;
  - `packages/shared/src/config.ts`: remove `overlayTemplateSchema.plugins`;
  - `packages/shared/src/library.ts`: `pinOf(declaration)` → `{ kind: "commit", sha } | { kind: "tag", name } | { kind: "latest" } | { kind: "live" }`; `checkPinRef(ref)` checks the **shape** only (40-hex, or a name by the §6.2 ref-format rules; `refs/heads/…` refused); whether a name is a recorded tag is the "Skills hasn't read" warning; `effectivePlugins(doc)` (the enabled keys of a config doc) lives here; `OFFICIAL_MARKETPLACES` gains the pin kinds each accepts (from G1 item 4; until then, commit refused for the reserved names, as the docs say); `ROW_STATE_ORDER` loses `add_failed`, `installing`, `install_failed`, `not_pinned` and `not_installed` and gains `refused` and `cant_pin` in spec §10.2's order;
  - `apps/web/src/features/skills/row-state.tsx`: the same states (`refused` → "Can't use", `CircleAlert`; `cant_pin` → "Can't be pinned", `TriangleAlert`);
  - `apps/server/src/agents/config-changes.ts`: `libraryChanged` loses `plugins`, and its comments about marketplace or plugin updates, store locks and a start installing a plugin go (spec §8.3);
  - `apps/server/src/templates/validate.ts`: spec §7.4's errors and warnings; delete "enabledPlugins is ignored: list plugins in template.yaml." and the old `config.plugins` marketplace check; `ref` is now allowed (validated as a pin), `path` stays refused;
  - `packages/shared/src/config-changes.ts`: delete the `listLines(ta.plugins…)` line and the `plugin` kind; fix the `Library.plugins` comment (key → pin, full sha); add "plugin x@y repinned a1b2c3d → e4f5a6b", "plugin x@y now follows the latest acme", "plugin x@y pinned to a1b2c3d", "added plugin x@y", "removed plugin x@y";
  - `apps/server/src/agents/config-resolver.ts`: `Effective.library.plugins` is key → pin string (`commit:<full sha>`, `tag:<name>`, `latest`, `live`) over the enabled keys plus the dependencies read from the Library checkouts at each pin (§8.1; the resolver has no agent plugins dir); `Effective.templatePlugins` deleted.
- Modify (web; the plan is already React-compliant; follow it as written and report any deviation): `apps/web/src/features/agents/template-field.tsx` (`config.plugins.length` gets only a `TemplateConfig`, which has no settings: the template summary the server returns gains `pluginCount`, computed with `effectivePlugins` in `apps/server/src/routes/templates.ts`, and the field reads it), `apps/web/src/features/config/messages.ts` (delete `CONFIG_FIELD_MSG.pluginRef`), and any other reader `pnpm typecheck` finds.
- Test: `packages/shared/src/library.test.ts`, `packages/shared/src/templates.test.ts`, `apps/server/src/templates/validate.test.ts`, `packages/shared/src/config-changes.test.ts`, `apps/web/src/features/skills/row-state.test.tsx`, `apps/server/src/agents/config-changes.test.ts` (CI)

- [ ] **Step 1: Write failing tests.**
  - `plugins:` in `template.yaml` gives "Unknown field.".
  - `test.each` over pin shapes: a 40-hex commit and `v1` pass; `refs/heads/main` and `a..b` are refused ("Pin acme to a commit or a tag."); `v1` with no recorded tag gives the "Skills hasn't read" warning; a commit pin on `claude-plugins-official` is refused with "Claude Code can't pin claude-plugins-official to a commit; use a tag or Latest.".
  - `enabledPlugins` errors: `false`; an undeclared marketplace; an unregistered one (with the `add_from_template` action); a source mismatch (ignoring `ref`); an overlay plugin from a marketplace the template doesn't declare; a refused source; `syncClaudeAiPlugins` in a template; an unpinnable plugin under a pinned declaration ("x@y can't be pinned. Switch acme to Latest to add it.").
  - Warnings: Latest ("Plugin x@y follows the latest acme: new code runs at each restart without review."); a pin Skills hasn't read.
  - `describeChanges`: added and removed plugins; a repin; pinned → Latest and back.
  - Server `config-changes.test.ts` (CI): a template save that moves a pin writes "plugin x@y repinned …" and restarts that template's agents when idle.
- [ ] **Step 2: Run** the four test files → FAIL.
- [ ] **Step 3: Implement.** Fix every reader of `TemplateConfig.plugins` to use `effectivePlugins(doc)`.
- [ ] **Step 4: Run** → PASS, then `pnpm typecheck` (removed fields; finds the readers).
- [ ] **Step 5: Commit** `feat: plugin declarations pin a marketplace by ref; plugins: removed`.

### Task B7: Start with Claude Code installing; delete the factory's installs; the init check

Implements spec §7.2, §7.3 steps 1–2 and 4–8, §6.5 (the plugins-dir class), AC 9, 10, 12, 14 and 15.

**Files:**
- Create: `apps/server/src/library/plugin-settings.ts`
- Modify:
  - `apps/server/src/workspace/paths.ts`: `agentPluginsDir(factoryHome, slug)` = `state/agents/<slug>/plugins`; `pluginsConfigDir` deleted;
  - `apps/server/src/workspace/workspace.ts`: `prepare` builds the closure and the plugin settings; creates `agentPluginsDir`; no `.claude-config/plugins` link; `ensurePlugins`, `readPluginKeys` and `linkPlugins` deleted; `materialize` loses the plugin part;
  - `apps/server/src/workspace/settings.ts`: `SettingsInput` loses `pluginKeys` and `plugins`;
  - `apps/server/src/workspace/mounts.ts`: `pluginsDir` mounts **read-write** and must equal `realpath(<FH>/state/agents/<slug>/plugins)` for this agent; `declaredMarketplaceDirs` becomes the registered directory marketplaces of the closure; the refusal becomes "… isn't this agent's workdir, a registered skill or this agent's plugins dir" (spec §6.5);
  - `apps/server/src/agents/runtimes.ts` (and `agent-runtime.ts` where the start is prepared): local starts call `assertPluginFloor(claudeBin, versionCheckEnv(...))`, replacing today's advisory version check; Docker starts call `checkImageClaudeVersion(image, digest)` before the container is created;
  - `apps/server/src/agents/runtime-spec.ts`: `buildAgentEnv` adds `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `DISABLE_AUTOUPDATER=1`, `FORCE_AUTOUPDATE_PLUGINS=1` when a declaration is Latest, and `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` whenever a declared marketplace is remote (not a directory); `buildRuntimeSpec` takes `settingsJson`;
  - `packages/shared/src/config.ts`: `FACTORY_ENV_NAMES` gains spec §7.3 step 4's names;
  - `packages/harness/src/types.ts` (`AgentRuntimeSpec.settingsJson?: string`), `packages/harness/src/claude/args.ts` (`--settings <json>` when set);
  - `packages/harness/src/claude/mapper.ts` and `packages/shared/src/events.ts` (`harnessEventSchema`): `session_started` gains `plugins` from the first `init`, in the shape G1 item 1 recorded;
  - `apps/server/src/agents/agent-runtime.ts`: on `session_started`, match `plugins` to the closure by path (spec §7.3 step 8); for each missing key append `plugin_not_loaded { key, pin }` and send the Inbox notice (below); keep `loadedPlugins: Record<key, version>` on the runtime, **outside** `started.library`;
  - `apps/server/src/routes/agents.ts` (`GET /api/agents/:slug/config`): the response gains `plugins: { key, pin, loaded? }[]` from the effective config and the runtime's `loadedPlugins`; the shared response schema gains the field;
  - `packages/harness/src/claude/process.ts`: if G1 item 20(e) exceeds 5 s, a longer `initialize` wait for starts with an empty plugins dir or a changed pin, and say so;
  - `packages/shared/src/events.ts`: the `plugin_not_loaded` session event;
  - `apps/server/src/agents/agent-service.ts` (`pluginFailure` deleted), `apps/server/src/spawning/spawn-service.ts` (the `PluginInstallError` branch deleted);
  - `packages/harness/testing/fake-claude.mjs`: delete `FAKE_CLAUDE_PLUGIN_FAIL` and `_SILENT_FAIL`;
  - web (the plan is already React-compliant; follow it as written and report any deviation): `apps/web/src/features/agents/agent-form-state.ts` (delete `pluginOutput`/`setPluginOutput`, the "Installing plugins…" label and the `plugin_install_failed` handling), `apps/web/src/features/agents/show-output.tsx` if nothing else uses it, and the session timeline row for `plugin_not_loaded` (text from spec §7.3 step 8, `CircleAlert`, no new component if the existing notice row fits).
- Delete: `apps/server/src/workspace/plugins.ts` and its test; `PluginInstallError` uses and `502 plugin_install_failed`; the `installPlugins` import in `apps/server/src/logging.test.ts` (and the case that uses it).
- Test:
  - `apps/server/src/library/plugin-settings.test.ts`, `apps/server/src/workspace/settings.test.ts`, `apps/server/src/workspace/workspace.test.ts`, `apps/server/src/workspace/mounts.test.ts`, `apps/server/src/library/claude-flags.test.ts`;
  - `packages/harness/src/claude/args.test.ts`, `packages/harness/src/claude/mapper.test.ts`, `apps/server/src/templates/validate.test.ts` (the env names);
  - `apps/web/src/features/agents/agent-form-state.test.ts`, `apps/web/src/features/agents/new-agent-sheet.test.tsx` (their plugin-output cases go);
  - `apps/server/src/spawning/spawn-service.test.ts`, `apps/server/src/agents/agent-runtime.test.ts` or the start tests that own `session_started` (CI).

**Interfaces (produces):**
- `buildPluginSettings(i: { closure: string[]; declarations: Record<mkt, { source; pin: Pin }>; catalogs: Record<mkt, string[]>; installed: string[]; skillsDirNames: string[] }): { enabledPlugins: Record<string, boolean>; extraKnownMarketplaces: Record<string, { source; autoUpdate: boolean }>; syncClaudeAiPlugins: false }` (the source carries `ref` when pinned);
- `readInstalled(pluginsDir): Promise<{ key: string; manifest?: PluginManifest }[]>` (`lstat`, 256 KB caps, paths must stay inside `pluginsDir`);
- **The not-loaded notice:** `eventStore.createHumanMessage({ kind: "system", notice: "plugin_not_loaded", subjectAgentId: agent.id, to: "all", body: "x@y didn't load for @ana.", urgent: false, createdAt })` with no `inboxKind` (a `system` row's item is a `notice` in the API; a system row needs its subject agent), then `inbox_changed` to each returned user id, once per start (as `credentials/expiry-check.ts` does).

- [ ] **Step 1: Write failing tests.**
  - `plugin-settings.test.ts`: `true` for the closure including readable dependencies; an installed manifest naming a dependency from an undeclared marketplace gets `false`, not `true`; `false` for the other catalog plugins at the pin, for installed keys outside the closure, and for known skills-dir names; a pinned declaration carries `ref` and `autoUpdate: false`; a Latest one has no `ref` and `autoUpdate: true`; the template's own declarations aren't carried over; `syncClaudeAiPlugins: false`.
  - `settings.test.ts`: the workdir settings file carries no plugin keys even when the template declares them.
  - `workspace.test.ts`, with fake Claude (B2): a cold start installs into `state/agents/<slug>/plugins` and `init` lists the plugin; a restart installs nothing; a template repin installs the new version at the next start; the env holds `CLAUDE_CODE_PLUGIN_CACHE_DIR` and `DISABLE_AUTOUPDATER=1`, and `FORCE_AUTOUPDATE_PLUGINS=1` only with a Latest declaration; `materialize` and spawn install nothing; a local agent below the floor fails.
  - `install-fail`: the agent keeps running, the session has `plugin_not_loaded`, and exactly one Inbox notice per user per start; `GET /api/agents/:slug/config` returns the plugins with their pins and, after `init`, the loaded versions.
  - Floor: a local start with fake Claude at 2.1.1 fails with "Claude Code 2.1.1 is too old; update it to 2.1.331 or later."; a `claude --version` that prints nothing fails closed (the harness check returns `tooOld: false` without a version, so `assertPluginFloor` treats unknown as too old); a fake `docker` image at 2.1.1 fails the Docker start.
  - `spawn-service.test.ts` (CI): three spawns return without an install, and each agent's first start installs into its own dir (AC 10).
  - `mounts.test.ts`: the agent's own plugins dir mounts read-write; another agent's plugins dir, the dir swapped for a link, and `state/` are refused.
  - `args.test.ts`: `--settings <json>` only when `settingsJson` is set. `mapper.test.ts`: `session_started.plugins` from the first `init`.
  - `test.each` over every new env name: a template, an overlay, a secret and a project `env` setting it is an error.
- [ ] **Step 2: Run** the local test files above → FAIL.
- [ ] **Step 3: Implement.** Use G1's recorded answer for `FORCE_AUTOUPDATE_PLUGINS` (item 7); `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` is always set when a remote-marketplace plugin is declared (G1 item 8); if item 2 failed, stop and wait for Or (spec P6).
- [ ] **Step 4: Run** → PASS. Then `pnpm typecheck` (no references to deleted symbols remain).
- [ ] **Step 5: Commit** `feat: Claude Code installs plugins per agent at start; the factory's installs removed`.

### Task B8: Host plugins, plugin and marketplace routes

Implements spec §7.6, §9.1 (plugins), §9.3 and §11.1.

**Files:**
- Create: `apps/server/src/library/host-plugins.ts`
- Modify: `apps/server/src/routes/library.ts`, `apps/server/src/app.ts` (wiring; marketplace sweep and boot removal of `adding` rows)
- Test: `apps/server/src/library/host-plugins.test.ts`, `apps/server/src/routes/library.test.ts` (CI)

- [ ] **Step 1: Write failing tests.**
  - `HostPlugins.list()` on a temp host dir in the v2 shape: the newest install by `lastUpdated`; a key whose marketplace is registered is left out; an `installPath` outside `<hostdir>/plugins/cache` gives "Can't show: outside the host's plugin folder."; a host source with userinfo or `ref` gives "The host's record for acme can't be used: …".
  - Add its marketplace: preview then add from the host record; refused when the name is registered with another source.
  - Routes (CI): every plugin and marketplace route returns 401 with an agent token and without a session; `GET /api/library/plugins` groups by marketplace with `pinnable`, `refusedReason`, `usedBy` with pins and `summary.needs`; `GET …/plugins/:key?commit=` reads at that commit; `POST …/plugins/:key/diff` returns the diff between two commits; `POST …/plugins/:key/read` fetches an external source; marketplace preview, add (201 and 202), check, update, fetch, remove and restore; every write publishes `library_changed`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/src/library/host-plugins.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Responses are parsed with the shared schemas; field errors use I4's `fields` shape.
- [ ] **Step 4: Run** → PASS (routes in CI).
- [ ] **Step 5: Commit** `feat(server): host plugins, plugin and marketplace routes`.

### Task B9: Plugins and Marketplaces views, peeks, Add marketplace

Implements spec §10.1–§10.4 (plugins). The plan is already React-compliant; follow it as written and report any deviation.

**Files:**
- Create:
  - `apps/web/src/routes/_app/skills.plugins.tsx`, `skills.marketplaces.tsx`;
  - `apps/web/src/features/skills/plugin-list.tsx`, `marketplace-list.tsx`;
  - `peeks/plugin-peek.tsx`, `peeks/marketplace-peek.tsx`, `peeks/needs-from-image.tsx`;
  - `add-marketplace-sheet.tsx`.
- Modify: `skills-header.tsx` (the switch; a `Select` below about 16rem), `apps/web/src/lib/library.ts` (`pluginsQueryOptions`, `pluginQueryOptions(key, from, commit)`, `marketplacesQueryOptions`), `apps/web/src/features/sheets/sheet-store.ts` (`{ kind: "add-marketplace" }`), `apps/web/src/features/sheets/sheet-bodies.ts`
- Test: `apps/web/src/features/skills/plugin-list.test.tsx`, `peeks/plugin-peek.test.tsx`, `peeks/marketplace-peek.test.tsx`, `add-marketplace-sheet.test.tsx`

React notes (already applied; follow them): `skills.plugins.tsx` and `skills.marketplaces.tsx` use the R-B1 loader with `pluginsQueryOptions` / `marketplacesQueryOptions`; marketplace Check, Update, Fetch, Read contents and Add its marketplace are mutations kept in component state keyed by the marketplace or key and dropped during render on retarget (R-Q1); pending rows render `<Elapsed since hideUnderMs={10_000} />` (R-E1); section components (Runs code, Needs from the image, Provides, Provenance, Used by) are module-level (R-H1); the peek reads its row with a module-level `select` (R-L2).

- [ ] **Step 1: Write failing tests.**
  - The plugin list: one group per marketplace, headed with its commit or "Local folder, live", then "On this host"; the contents line shows the first three kinds then "+N more", with "Parts not shown" first; hex versions show as commits; "2 use Latest" appears only when a user is Latest; states by spec §10.2 precedence, including "Can't use" and "Can't be pinned"; the empty view text and its link.
  - The plugin peek: opening the same plugin at two commits shows each commit's hooks (the query key carries the commit); "Runs code" first; "Needs from the image" lists `node`, `uvx` with the note; skeleton rows from `contentsSummary`; View file from the top; "At a1b2c3d" when opened at a pin; Used by shows each template's pin and the Latest badge's accessible name; a host plugin offers only Add its marketplace; opened `readOnly`, no actions and an "Open in Skills" link.
  - The marketplace peek: Check for updates; the update view lists changed plugins with "Runs code changed" first and its primary "Update Skills to e4f5a6b" with the note about pins; "Pinned by templates" marks older pins; Fetch for a pin Skills hasn't read; Back returns focus to the row and Esc closes; the Remove reason "Templates use plugins from acme. Remove them first.".
  - Add marketplace: the preview shows plugins with "Can't be pinned" or "Can't use: command source"; Add closes the sheet with "Added acme at a1b2c3d." and Undo; a 202 shows the pending row with the server's `since`; a failure toasts "Couldn't add acme.".
  - The header: three views as links with `aria-current`. (The `Select` below the width threshold is checked in the B11 browser evidence.)
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/features/skills` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): Plugins and Marketplaces views, peeks and Add marketplace`.

### Task B10: Plugin picker and the pin control in the Configuration form

Implements spec §10.5 (plugins), §7.4 form writes, AC 9, 12 and 13, and DESIGN.md amendment 7. The plan is already React-compliant; follow it as written and report any deviation.

**Files:**
- Create: `apps/web/src/features/config/plugin-pin.tsx` (the per-marketplace pin control and its in-place reviews), `apps/web/src/features/config/latest-badge.tsx`
- Modify:
  - `apps/web/src/features/config/skills-section.tsx` (replace I2's `name@marketplace` `ListField` with the Library picker, grouped by marketplace);
  - `apps/web/src/features/config/fields.ts` (`FIELD_PATHS.plugins` moves to `["settings","enabledPlugins"]`, an object, so `ListFieldId` loses `"plugins"`);
  - `apps/web/src/features/config/messages.ts` (delete `CONFIG_COPY.pluginsHelp*`; add the picker footers, the pin labels and the Latest risk text to `CONFIG_COPY`);
  - `apps/web/src/features/config/config-page.tsx` (the agent's plugins show "running 1.3.0" and the badge for Latest, from `started.library`);
  - `DESIGN.md` (amendment 7, verbatim from spec §16).
- Test: `apps/web/src/features/config/skills-section.test.tsx`, `apps/web/src/features/config/plugin-pin.test.tsx`, `apps/web/src/features/config/sections.test.tsx`

React notes (already applied; follow them): `agents.$slug_.config.tsx` and `templates.$name.tsx` add `void qc.prefetchQuery(pluginsQueryOptions)` beside the Library prefetch (R-B1, no waterfall); the diff for "Pin to …" is a mutation (`POST …/diff`) started in the menu item's handler, kept in component state keyed by marketplace and target commit, and dropped during render when either changes (R-Q1); the review panels are module-level components that receive primitives (R-H1); the draft writes happen in the primary's click handler; `added` keys follow R-C1; nothing is derived in an effect.

- [ ] **Step 1: Write failing tests.**
  - Template mode: picking a plugin from an undeclared marketplace writes `enabledPlugins[key] = true` and `extraKnownMarketplaces[mkt] = { source, ref: <Library commit> }`; picking another plugin from the same marketplace keeps the existing `ref`; the footer reads "Add marketplaces in Skills"; refused sources are left out and counted.
  - The pin control: shows "Pinned · a1b2c3d" and "Newer in Skills: e4f5a6b"; "Pin to e4f5a6b…" opens the review in place with focus on its heading, shows the diff lines, and writes the new `ref` on its primary; "Use Latest, auto-update…" shows the risk text and, on "Use Latest", removes `ref`; Cancel and the primary return focus to "Change pin"; the badge's words are found with `getByText("Latest")` and `getByText("auto-updates")`; an unpinnable plugin can't be added under a pinned declaration and the live region says why; a directory marketplace shows "Local folder, live" and no Change pin.
  - An official plugin whose marketplace refuses commit pins is pinned to the recorded tag at the Library's commit, or refused with "acme can only be pinned to a tag. Fetch a tag in Skills, or use Latest." when there is none.
  - Agent mode: only the template's marketplaces, with the footer "Only plugins from dev's marketplaces. Add more in the template."; picking writes `settings.enabledPlugins` into the overlay; the template's pin shows read-only with the badge when Latest.
  - Removing the last plugin of a marketplace leaves its declaration. A row's View opens the read-only peek at that pin.
- [ ] **Step 2: Run** the three test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): plugin picker with pins by default and an explicit Latest`.

### Task B11: Finish PR 2

- [ ] **Branch review.** A fresh reviewer on `git diff i5/1-library-skills...i5/2-plugins` against spec §7, §8, §10, §11, §13 and AC 8–15. It checks:
  - the factory never runs `claude plugin` and never writes an agent's plugins dir (grep `"plugin", "install"|marketplace add|StoreRunner|storeLock|plugins-journal|provenance.json|SEED_DIR` finds nothing outside G1 scripts and the reserved-env list);
  - every `git` path is hardened, with argv and env tests;
  - pins: default pinned, Latest explicit, the badge everywhere, validation of pin kinds;
  - the deletions are complete: grep `plugins-config|pluginsConfigDir|readPluginKeys|linkPlugins|ensurePlugins|installPlugins|templatePlugins|pluginFailure|pluginOutput|PluginInstallError|plugin_install_failed|FAKE_CLAUDE_PLUGIN_FAIL|FAKE_CLAUDE_PLUGIN_SILENT_FAIL` finds nothing;
  - ADR 0028 and AGENTS.md testing standards;
  - **the React diff against `vercel-react-best-practices`** (the reviewer invokes the skill first and skips Next-only rules, saying so), using A16's checklist, with R-Q1 (diff, check, fetch and read as mutations), R-Q3 and R-E1 on the plugin views and the pin control.

  Fix the findings.
- [ ] **Full verification, once for the Part**, as in A16, with a fixture marketplace through `file://` for fake Claude.
- [ ] **Real-browser evidence**, as in A16, fake Claude only (it installs into a temp plugins dir; nothing is installed on the host):
  - add `i5b_*.py` checks for AC 8–13 and 15, plus the plugin peek's hooks stacking below `@max-[28rem]`, the Latest badge and the pin review at 390px;
  - worst-case data: a plugin with 12 hooks, a U+202E command and a multi-line `bash -c`; a `hooks.json` link; more than 2,000 files; a plugin needing `node`, `uvx` and `bun`; `rust-analyzer-lsp@claude-plugins-official` with a 12-hex version; two git-URL marketplaces on one host; a template with one pinned and one Latest marketplace; an empty Plugins view.
- [ ] **Push and PR.**
  - Merge `i5/1-library-skills`, then push and get CI green on the branch.
  - Then open the PR **ready for review (not draft)** with base `i5/1-library-skills`, titled `feat: plugins installed per agent by Claude Code, pinned by default`. It links the spec, the plan and #153, Or's G1 report, the reset step, the #56 re-scope note, and says that DB tests run in CI.
  - Confirm `gh pr checks` is green. Never merge; Or merges the stack.

---

# Part C: `i5/3-polish-docs` (PR 3)

Cut it with `git checkout -b i5/3-polish-docs i5/2-plugins`. If the evidence fixes are small, fold this part into PR 2 instead and say so in the PR 2 body.

### Task C1: Evidence fixes

For any apps/web fix: the plan is already React-compliant; follow it as written and report any deviation.

- [ ] Fix each failing evidence item from A16 and B11 as its own commit, run the test files you changed, then re-run the affected browser checks through the harness's `run.sh` lock.

### Task C2: Product docs (for the lead)

- [ ] `docs/product/` is gitignored and lives only in the main checkout. **Don't edit it.** List spec §18 in the PR body and the final report, for the lead:
  - Agent template;
  - Workspace (the layout, per-agent installs by Claude Code, pins and Latest, the read-write plugins mount, residual risk);
  - Administration (a new Skills section, the pin control);
  - ADR 0017 note, ADR 0024 consequences (P1–P6);
  - Data model;
  - Agent runtime (the plugin env, `plugin_not_loaded`);
  - in Workspace and Agent runtime, say plainly: plugin code runs as the host user on the local runtime (supported, not tested), and an agent can edit its own installed plugins;
  - Base image (#160: the 2.1.331 pin, and the plugin runtimes an image must carry);
  - Issue #56: re-scope or close with the measured numbers;
  - I6 path help and README;
  - Factory MCP (I7 note: `RESERVED_SETTINGS_KEYS` is the agent default-deny).

### Task C3: Final whole-branch review, verification, PR

- [ ] **Whole-branch review** of `git diff spec/i5-skills-and-plugins...i5/3-polish-docs` (all of I5) against the whole spec and all 15 acceptance criteria. **The React diff is checked against `vercel-react-best-practices`** with A16's checklist and every R-* rule in Global Constraints: the reviewer invokes the skill, skips Next-only rules and says so.
- [ ] **Full verification, once for the Part**: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and the dev loop from a clean clone.
- [ ] **Real-browser re-check** of every UI acceptance criterion in Chromium and WebKit headless, through the harness `run.sh` lock. Use fake Claude and the `file://` fixture only.
- [ ] **Push and PR.** Push, get CI green, then open the PR **ready for review (not draft)** with base `i5/2-plugins`, titled `chore: Skills evidence fixes and docs list`. Never merge; Or merges the stack.

## Manual steps for Or (the executor never does these)

1. **Gate G1** (Task B1): build or pull the agent image with Claude Code 2.1.331, run `scripts/g1/run.sh` (containers only; nothing is installed on the host), passing `CLAUDE_CODE_OAUTH_TOKEN` from your shell for the session items, and post `report.md` on #153. A throwaway GitHub repo is needed only if item 0 shows Claude Code won't take a `file://` git marketplace. Part B's implementation (B2 onward) starts only after that.
2. **Review the certainty-3-or-lower decisions** listed on #153: Q3, Q7, Q12, Q15, Q18, R5, R12, and the plugin-design ones P1 (one pin per marketplace per template), P3 (an agent can edit its installed plugins), P4 (not-loaded: keep running, notice to everyone) and P6 (the fallback if a headless start doesn't install).
3. **Confirm the re-validation calls** (2026-11-24; the plan and spec already follow them):
   - the old `FACTORY_HOST_SKILLS_DIR` gets S10's `REMOVED_ENV` boot warning (shipped in PR 1);
   - one Claude Code floor, the harness's `MIN_CLAUDE_VERSION`, equal to the pin until G1 item 21 says otherwise;
   - `describeDocChanges` stays for the web's pre-save summary (shipped in PR 1).
