# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary:** a single developer, or a small team, running AI agent "teammates" on their own machine or one server. They know terminals, editors, git and CI well, and they already work in tools like GitHub, Linear and VS Code.
- **Situation:** the web app stays open in a browser tab next to the editor for hours, day and night. They create a task, hand it to a persistent team lead, and then watch agents spawn helpers, write specs and plans, and open PRs. Most of the time goes to two things: watching a live agent session and working through the inbox.
- **Job:** define agents (templates with a persona, skills, MCP servers, plugins and a model), arrange them in a reporting line, give them work, and see exactly what each one is doing without babysitting it.
- **Secondary audience:** developers evaluating the project, who reach it through the GitHub repository and the docs. They decide whether to self-host it.

## Product Purpose

Open Factory is an open-source, self-hostable system for running an organization of AI agents. It turns Claude Code sessions into a team. Persistent agents message each other and the human directly, delegate by spawning ephemeral agents with fresh context, and track work in lightweight tasks only when tracking is useful. Every agent has one continuous session that the human can watch.

Success: the core workflow feels natural. A human assigns a task to a lead. The lead spawns a tech lead and a proxy reviewer to write a spec and a plan, then a fresh developer to implement it, and the human can follow every step in each agent's session.

Engineering-first: repositories, worktrees, PRs and CI are native. Non-engineering roles (PM, designer, marketing) are first-class members of the same organization, not add-ons.

## Positioning

Positioned against the "everything is a ticket" model of agent orchestration (Paperclip is the reference system; see `docs/product/paperclip-comparison.md`):

- **Direct conversation instead of tickets.** A per-agent mailbox is the backbone, and tasks are optional pointers.
- **Live sessions instead of heartbeat runs.** Each agent keeps a warm, long-lived Claude Code process, and its one session *is* its DM.
- **Fresh context as the way to delegate.** Agents spawn short-lived helpers per phase of work, with no approval flow.
- **Native to the harness.** It uses Claude Code as-is, with typed MCP tools instead of a protocol encoded in prompts.
- **Far less machinery.** There are no budgets, approvals, tenants or permission matrices. The only structure is the reporting line.
- **Your files on your machine.** Working directories are real host paths you can open in your editor.

## Operating Context

- Self-hosted with Docker or a local runtime. There is one factory per deployment, and every signed-in user is an equal admin.
- Main surfaces:
  - **Web app** (`apps/web`). Navigation: Inbox, Agents, Tasks, Templates, Schedules, Settings. Content updates live without a refresh. Every session event and comment has a deep link.
  - **Bundled CLI** (`apps/cli`).
  - **Docs site:** published product and install docs. Planned.
  - **GitHub presence:** README, social preview, release notes.
- Markdown everywhere: task bodies, comments, messages and agent output render as GitHub-flavored markdown (code highlighting, tables, task lists, mermaid). Editors are raw markdown with a preview toggle.
- Theme follows the system (light/dark) with no in-app toggle. Dark mode is an equal citizen because the product is used at night.

## Capabilities and Constraints

- Core concepts and their terms (use them consistently): agent template, persistent agent, ephemeral agent, reporting line (`reports_to`), session, message, task, schedule, project, credential. Defined in `docs/product/concepts/`.
- v0.1 non-goals: multi-tenancy, roles and permissions, budgets, approvals, channels, teams, non-Claude harnesses, taking over a live session.
- Stack: TypeScript pnpm monorepo. Fastify and Postgres (Drizzle, pg-boss) on the server, React + Vite with shadcn/Radix and Tailwind v4 on the web, and Zod schemas shared across packages.
- Open product questions: onboarding beyond "sign up → dashboard", and whether there are starter templates. The factory starts blank, with no templates or agents.

## Brand Commitments

- **Name:** Open Factory, written in sentence case as "open factory" in the wordmark.
- **Logo:** variation **a, "Sawtooth"** (chosen). A factory roofline drawn as one continuous line with an open floor, with teeth that rise left to right at an exact 30° pitch. The wordmark is Archivo Bold, converted to outlines, and the top of the *t* is cut at the same 30° pitch. Its usage rules are binding:
  - Never retype the wordmark.
  - Never close the shape or add a floor line.
  - Never flip it.
  - No effects.
  - Clear space is 2× the roofline stroke on every side.
  - Use the small cut below 32 px.
  - Use the reversed (slightly thinner) files for light-on-dark work.
- **Logo colours:** Signal Orange `#FF5A1F`, Ink `#16140F`, Paper `#F4F1EA`.
- **Logo source files:** `../logo-design-skill/out/open-factory/a/` (SVG masters, `export/` PNGs, favicon set, `site.webmanifest`, `USAGE.md`). These live outside this repo for now; bring them into the repo before shipping them.
- **Voice, on every surface (app, CLI, docs, README):** a calm senior engineer. Plain, short and specific. Sentence case, no exclamation marks, no "Oops", no emoji, and the reader is "you". Errors name the problem and the way out, and buttons name their action.
- **Open items:** trademark clearance has not been done.

## Evidence on Hand

- Product docs: `docs/product/` (vision, concepts, architecture, behavior, decisions, roadmap).
- Logo package as listed above.
- There are no users, testimonials, benchmarks, adoption numbers, case studies or press yet. Do not invent any.

## Product Principles

1. **Talk directly.** Conversation between agents and humans is the main interaction. Tasks are optional.
2. **One agent, one session.** Opening an agent shows its single continuous session, and nothing is hidden from the human.
3. **Structure is the reporting line, nothing more.** No teams, departments or permission matrices.
4. **Fresh context is a feature.** Spawning ephemeral agents per phase of work is the main way to delegate.
5. **Small surface, honest semantics.** Fewer concepts, each with one clear behavior. Prefer "not in v0.1" to a half-built feature.

## Accessibility & Inclusion

WCAG 2.2 AA on every surface: contrast, visible focus, labelling, and reduced-motion support. Status is never shown by colour alone.
