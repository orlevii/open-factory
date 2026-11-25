# AGENTS.md

## About the project

Open Factory is an open-source, self-hostable system for running an organization of AI agents. A human defines **agent templates** (persona, skills, MCP servers, plugins, model), creates **persistent agents** from them, and arranges them in a **reporting line**. Agents message each other directly, delegate by spawning **ephemeral agents** with fresh context, and track work in lightweight **tasks** when tracking is useful. Every agent has one continuous Claude Code session that the human can watch.

It is engineering-first (repos, worktrees, PRs and CI are native), but non-engineering roles are first-class too. It targets a single developer or small team running on their own machine or one server.

Principles: talk directly, one agent one session, structure is the reporting line only, fresh context is a feature, native to the harness (Claude Code), small surface with honest semantics, your files on your machine.

Stack: a TypeScript pnpm monorepo with Fastify, Postgres (Drizzle, pg-boss), React + Vite, and a bundled CLI, with Zod schemas shared across packages.

## Pre-release: break freely

Open Factory is pre-release (roadmap v0.0.x; see `docs/product/decisions/0028-pre-release-no-compatibility.md`). Code, REST APIs, MCP tools, the CLI, files on disk, env vars and the database schema may all break.

- No backward compatibility: no shims, aliases, deprecated paths, fallbacks for old shapes or flags for the old behaviour. Replace the old thing and delete it.
- No data migration: a schema change ships as the generated schema migration only, without backfilling or converting existing rows. Resetting local data is fine.
- Prefer clean, maintainable code over branchy code. If keeping old data or callers working would add a branch, break them instead.

## Testing standards

A test earns its place by failing when a behaviour a user, caller or operator relies on breaks. Before adding a test, name the regression it would catch; if you can't, don't add it.

- **Test observable behaviour.** Assert what a caller sees: HTTP status and body, rows written, events and messages published, files on disk, text and state on screen, focus, what the agent process was sent. Not how the code gets there.
- **Cover the failure cases.** Validation errors, refused permissions, missing or ended targets, server errors, timeouts and races sit next to the happy path. Security boundaries (auth, permission checks, secret redaction) always have a test that tries to cross them.
- **No existence-only tests.** Don't assert that a file, export, key, column, enum value, constant or element merely exists, and don't compare a constant to its own literal. The type checker and the behavioural tests already catch those. Test the rule the value encodes (a schema test feeds bad input and expects a refusal).
- **No implementation details.** Don't assert call counts of internal helpers, private method calls, DOM structure or incidental copy.
- **Don't assert CSS classes or styling.** No `toHaveClass`, class-name strings, inline styles or design tokens. Test behaviour and accessible output instead: roles, accessible names, text, focus, `aria-*` and state attributes (`data-state`, `aria-current`, `disabled`), and what an interaction does. Layout and look are checked in the browser, not in jsdom.
- **Every test can fail.** No assertion-free tests, no `expect(true)`, no assertions on values or mocks the test set up itself, no `toContain("")`. When you write or strengthen a test, break the behaviour once (or reason it through) and see it fail for the right reason.
- **Mock only boundaries.** Fake the network, Docker, the Claude process (fake Claude) and the clock; keep the real path in between. Server tests run against a real Postgres. An over-mocked test that never runs the real code protects nothing.
- **One behaviour per test, named for it.** The name says the behaviour and the outcome ("a terminated agent's input is refused with 409"), and the body checks everything the name promises. Use `test.each` for the same behaviour over several inputs instead of near-copies.
- **One home per behaviour.** Test a rule once, at the cheapest level that can fail for the right reason: a pure function in a unit test, an HTTP contract in a route test, a flow across screens in an app-level test. Higher levels check the wiring, not every case again.
- **A bug fix ships with its regression test**, one that fails without the fix. Name it for the behaviour, not the ticket.
- **Keep tests fast and independent.** No real sleeps: use fake timers or wait for the condition. Share expensive fixtures (databases, apps) per file, but never depend on another test's state or order.
- **No tombstones.** Pre-release, a deleted route, component or field needs no test that it stays deleted.

## Git worktrees

Create git worktrees under `.worktrees/` at the repo root (for example `git worktree add .worktrees/<branch> -b <branch>`). The directory is gitignored.

## Pull requests

Follow `.github/pull_request_template.md` when creating a PR:

- **Title**: a conventional commit, `type(scope): what changed` in plain words. Types: `feat`, `fix`, `refactor`, `chore`. Leave the scope out if the PR spans several scopes.
- **Body**: fill in every section of the template: What, Why, Approach (one bullet per decision: "<decision>, rather than <alternative>, because <reason>"), and Changes (high level, grouped by area, skipping mechanical edits).
- Link the relevant spec or plan in `docs/` when there is one.
- Remove the template's HTML comments from the final description.
