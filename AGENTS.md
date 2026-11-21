# AGENTS.md

## About the project

Open Factory is an open-source, self-hostable system for running an organization of AI agents. A human defines **agent templates** (persona, skills, MCP servers, plugins, model), creates **persistent agents** from them, and arranges them in a **reporting line**. Agents message each other directly, delegate by spawning **ephemeral agents** with fresh context, and track work in lightweight **tasks** when tracking is useful. Every agent has one continuous Claude Code session that the human can watch.

It is engineering-first (repos, worktrees, PRs and CI are native), but non-engineering roles are first-class too. It targets a single developer or small team running on their own machine or one server.

Principles: talk directly, one agent one session, structure is the reporting line only, fresh context is a feature, native to the harness (Claude Code), small surface with honest semantics, your files on your machine.

Stack: a TypeScript pnpm monorepo with Fastify, Postgres (Drizzle, pg-boss), React + Vite, and a bundled CLI, with Zod schemas shared across packages.

## Git worktrees

Create git worktrees under `.worktrees/` at the repo root (for example `git worktree add .worktrees/<branch> -b <branch>`). The directory is gitignored.

## Pull requests

Follow `.github/pull_request_template.md` when creating a PR:

- **Title**: a conventional commit, `type(scope): what changed` in plain words. Types: `feat`, `fix`, `refactor`, `chore`. Leave the scope out if the PR spans several scopes.
- **Body**: fill in every section of the template: What, Why, Approach (one bullet per decision: "<decision>, rather than <alternative>, because <reason>"), and Changes (high level, grouped by area, skipping mechanical edits).
- Link the relevant spec or plan in `docs/` when there is one.
- Remove the template's HTML comments from the final description.
