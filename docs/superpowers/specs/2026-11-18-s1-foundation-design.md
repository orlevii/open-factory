# S1 Foundation — Technical Design

- **Date:** 2026-11-18
- **Status:** approved by owner-proxy (s1-owner), pending Or's review on the low-confidence items (see "Decisions needing Or's call")
- **Roadmap spec:** `docs/product/roadmap/v0.1/s01-foundation.md`
- **Product sources of truth:** `docs/product/architecture/tech-stack.md`, `docs/product/decisions/0013-server-shaped.md`, `docs/product/decisions/0014-typescript-fastify.md`, `docs/product/decisions/0012-mcp-and-cli.md`, `docs/product/behavior/general.md`, `docs/product/concepts/user.md`, `docs/product/architecture/data-model.md`
- **Decision log:** GitHub issue "S1 Foundation: design decisions" (orlevii/open-factory)

> Note: `docs/product/` is currently ignored by git (`docs/product/.gitignore` is `*`), so the product docs exist only in local checkouts. Paths above are relative to the repo root.

## 1. Goal

An empty but real product: a user clones the repo, starts Postgres, installs, builds, runs `npm start`, signs up and lands on an empty dashboard. The toolchain (monorepo, typecheck, lint, tests, build, CI) is in place so S2+ only add features.

Out of scope (from the roadmap): agents, harness, any domain tables beyond users. Also out of scope here: invites and closing sign-up (S10), password reset (no mail transport in v0.1), WebSocket topics/subscriptions (S3), any agent-facing CLI token issuance, the `of-base` image (S2).

## 2. Acceptance criteria

1. Fresh clone → `docker compose -f docker-compose.dev.yml up -d` → `cp .env.example .env` and set `FACTORY_SECRET_KEY` → `pnpm install && pnpm build && npm start` → open `http://localhost:3000` → sign up → land on the empty dashboard (Inbox + Agents panels) per `behavior/general.md`.
   (This rewords the roadmap AC "running `npm start`" to include install + build; see decision Q5.)
2. A second user can sign up with a different email and handle. Both users see the same app; there are no roles.
3. A duplicate handle (or email) is rejected with a clear form error.
4. CI is green: `biome ci`, typecheck, tests, build and the CLI smoke step.
5. `open-factory status` prints the server version (works without login). `open-factory login` / `open-factory status` / `open-factory logout` work against a running server.
6. The AC1 flow is checked manually once before S1 is called done, and the result is noted in the PR.

## 3. Repository layout

```
package.json              root: version (single source), scripts, engines node>=24, packageManager pnpm
pnpm-workspace.yaml
biome.json                lint + format (only tool)
tsconfig.base.json        shared compiler options (strict, ESM, moduleResolution bundler)
.env.example
docker-compose.dev.yml    Postgres only
.github/workflows/ci.yml
apps/server               Fastify app (bundled with esbuild)
apps/web                  React + Vite SPA
apps/cli                  `open-factory` CLI (bundled with esbuild to one file)
packages/shared           Zod schemas + types shared by server, web, CLI
packages/db               Drizzle schema, migrations, migrate(), db client
packages/harness          empty placeholder (package.json + index.ts exporting nothing)
```

- All packages are ESM (`"type": "module"`), Node >= 24.
- **Internal packages pattern:** `packages/*` have no build step. Their `package.json` `exports` point at `.ts` source. Vite, tsx and esbuild consume TS directly.
- **Typecheck:** TypeScript (latest, currently 7.x). Each package has its own `tsconfig.json` extending `tsconfig.base.json` with the right environment (`lib: DOM` + Vite types for web; `@types/node` for server, CLI, db, shared). Root `typecheck` = `pnpm -r --parallel exec tsc --noEmit` (no root solution file). TS 7 has no stable JS API yet: any tool that loads the `typescript` package programmatically must be checked against it at scaffold time.
- **Bundling:** esbuild bundles `apps/server` and `apps/cli`. Vite builds `apps/web`.
  - **Server:** workspace packages (`@open-factory/*`) are **bundled** (they are TS source); third-party packages stay **external**. The external list is built from `apps/server/package.json` `dependencies`, excluding `workspace:*` entries. Every runtime third-party dependency of `packages/db` and `packages/shared` (e.g. `drizzle-orm`, `postgres`, `zod`) is **also** a direct dependency of `apps/server`, so pnpm makes it resolvable from `apps/server/dist`.
  - **CLI:** everything bundled into one file with a `#!/usr/bin/env node` banner.
  - If esbuild cannot handle something the server needs, fall back to tsdown — only after showing the concrete failure.
- **TanStack Router route tree:** `apps/web/src/routeTree.gen.ts` is committed (and excluded in `biome.json`), so typecheck works before a build. The Vite plugin regenerates it in dev/build.
- **Lint/format:** Biome only. ESLint is added only if a rule we actually need is missing from Biome.
- **Tests:** Vitest (root config with `test.projects`), Testing Library for web components.
- **Versions rule:** every dependency added with `pnpm add <pkg>@latest`, verified with `npm view <pkg> version` (tech-stack.md). Nothing in this spec pins versions except the Postgres major (see §9).

Root scripts: `dev` (server `tsx watch` + `vite` in parallel), `build`, `start`, `test`, `typecheck`, `lint` (`biome check`), `lint:fix` (`biome check --write`, covers formatting — no separate `format` script), `lint:ci` (`biome ci .`, used by CI), `db:generate` (drizzle-kit).

Vitest uses `test.projects` in the root `vitest.config.ts` (Vitest 5 has no workspace file): `jsdom` environment for `apps/web`, `node` for everything else.

`npm start` runs only the already-built server: `node --env-file-if-exists=.env apps/server/dist/index.js`. It never builds or installs.

## 4. Configuration (apps/server)

Env vars only, parsed once at boot by one Zod schema (`apps/server/src/config.ts`). On failure, print **every** missing/invalid var at once and exit non-zero. Local dev loads `.env` via Node's `--env-file-if-exists` (no dotenv). `.env.example` is committed and matches the compose file.

| Var                  | Required | Default                    | Notes                                                                                                                                                                                          |
| -------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | —                          | Postgres URL                                                                                                                                                                                   |
| `FACTORY_SECRET_KEY` | yes      | —                          | min 32 chars; root key, see below. The literal placeholder from `.env.example` (`change-me-to-a-random-string-of-32-chars-or-more`) is rejected with a hint to run `openssl rand -base64 32`   |
| `FACTORY_HOME`       | no       | `~/open-factory`           | non-empty string; leading `~` expanded, then `path.resolve`d to absolute. Existence is not checked and the directory is **not created in S1** (the first spec that writes there creates it)    |
| `PUBLIC_URL`         | no       | `http://localhost:${PORT}` | must parse as an http(s) URL; its origin is used for better-auth base URL, trusted origins and the WS origin check. Users must open the app at exactly this origin (`127.0.0.1` ≠ `localhost`) |
| `DEV_WEB_ORIGIN`     | no       | `http://localhost:5173`    | Vite dev server origin, trusted (better-auth + WS) only when `NODE_ENV !== "production"`                                                                                                       |
| `PORT`               | no       | `3000`                     |                                                                                                                                                                                                |
| `HOST`               | no       | `127.0.0.1`                | fail-closed default; servers set `HOST=0.0.0.0` explicitly (README says so)                                                                                                                    |
| `LOG_LEVEL`          | no       | `info`                     | pino level                                                                                                                                                                                     |
| `NODE_ENV`           | no       | —                          | `production` disables pretty logs and the dev origin allowance                                                                                                                                 |

`DOCKER_HOST` is not read in S1.

**Key derivation.** One helper (`apps/server/src/crypto/keys.ts`) derives purpose-specific subkeys from `FACTORY_SECRET_KEY` with HKDF-SHA256 (`node:crypto.hkdfSync`, fixed salt, `info` = purpose label, 32-byte output): `"better-auth"` (base64url-encoded and passed as better-auth's `secret` string) and `"secret-encryption"` (exported for later specs; unused in S1). Limitation, documented in the README: rotating `FACTORY_SECRET_KEY` invalidates all sessions and requires re-encrypting stored secrets.

## 5. Database (packages/db)

- Drizzle ORM on Postgres with the `postgres` (postgres.js) driver.
- **Schema ownership:** generate better-auth's tables once with better-auth's schema-generation CLI into `packages/db/src/schema/auth.ts`, then own that file. The auth options used by the generator live in a module that can be imported **without** env/config (pure options factory taking `secret`, `baseURL`, etc. as parameters), so the generator doesn't trip the config fail-fast. better-auth is configured with `usePlural: true`, so tables are `users`, `sessions`, `accounts`, `verifications` (matching data-model.md and the plural style of future tables). Add `handle` to `users`:
  - `handle text not null`, with a **unique index** in the database (not only an app check).
  - Format and length are validated by the shared Zod schema (§6); the DB enforces uniqueness.
- **Migrations:** SQL files generated by `drizzle-kit generate` (`pnpm db:generate`), committed in `packages/db/migrations/`. better-auth never runs its own migrations.
- **`migrate()`**: one exported function in `packages/db` (wraps drizzle-orm's migrator) that applies pending migrations. Called at server boot before listening, and by the test setup. No advisory lock (one factory process per deployment, ADR 0013). No `db:migrate` script.
- The server bundle must find the migrations folder at runtime: the build copies `packages/db/migrations` to `apps/server/dist/migrations`, and `migrate()` takes the folder path as an argument.
- Until v0.1 is released, the initial migration may be edited/regenerated instead of stacking fix-up migrations.
- References to users from future tables use the user `id`, never the handle.

## 6. Shared schemas (packages/shared)

- `RESERVED_HANDLES = ["humans", "me", "scheduler"]`: the addresses the product docs use (`@humans`, `@me`, `@scheduler`). Later specs that introduce a new address add it here.
- `handleSchema`: length 2–32, regex `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` (lowercase letters, digits, inner hyphens), not in `RESERVED_HANDLES`. The server rejects anything not already lowercase; the sign-up form lowercases as the user types. Used by the form and the server.
- `signUpSchema`: `{ name, handle, email, password (min 8) }`.
- `meSchema`: `{ id, email, name, handle }`.
- `statusSchema`: `{ version: string, db: "ok" | "error" }`.
- `apiErrorSchema`: `{ error: { code: string, message: string } }`.
- WebSocket messages (`ws.ts`): Zod discriminated unions on `type`.
  - client → server: `{ type: "ping" }`.
  - server → client: `{ type: "hello", userId }`, `{ type: "pong" }`, `{ type: "error", code, message }`.
  - Later specs (S3) add variants; S1 has no topics or subscriptions.
- A tiny typed fetch helper (`apiFetch(path, { schema, ... })`) that parses responses with the given Zod schema and turns non-2xx into a typed `ApiError`. Used by web and CLI. It takes the base URL and optional bearer token as parameters (the web passes none and relies on cookies).

## 7. Server (apps/server)

### 7.1 Bootstrap

`index.ts`: load config → `migrate()` → build app (`buildApp(config, db)`, a factory so tests can create instances) → `listen({ host, port })`. Graceful shutdown on SIGINT/SIGTERM (close Fastify, close DB pool).

### 7.2 Logging

Fastify's built-in pino. JSON in production; `pino-pretty` transport in dev only (devDependency). `redact` covers `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, and any `password` fields. Request bodies are not logged.

### 7.3 HTTP API

- Everything under `/api`. Validation and serialization through `fastify-type-provider-zod` using the schemas in `packages/shared`.
- One error handler producing `{ error: { code, message } }` for all factory routes. **Exception:** `/api/auth/*` keeps better-auth's own error format (`{ code, message }`), which its React client expects; the web and CLI map better-auth codes themselves (§7.4). Validation errors → 400 `validation_error`. Unknown or forbidden resources → 404 `not_found` (never 403 leaks). Unknown `/api/*` paths → JSON 404, never `index.html`.
- Routes in S1:
  - `GET /api/status` (public): `{ version, db }`. `db` is `"ok"` if `select 1` succeeds, else `"error"`. This is also the health endpoint (always HTTP 200 while the process is up, so the CLI can show the DB state).
  - `GET /api/me` (auth): `meSchema`; 401 `unauthorized` without a valid session.
  - `/api/auth/*`: better-auth handler mounted via a Fastify catch-all route that builds a Web `Request` (URL from `PUBLIC_URL` + path, headers via better-auth's `fromNodeHeaders`, body re-serialized from the parsed JSON when present), calls `auth.handler`, and copies status, headers (including multiple `set-cookie`) and body back. Note: Fastify rejects a `Content-Type: application/json` request with an empty body, so clients (the CLI's sign-out) send `{}`.

### 7.4 Auth (better-auth)

- `emailAndPassword` enabled, `minPasswordLength: 8`, email verification off, no password reset (no mail transport — tracked as a GH issue).
- Drizzle adapter on the `packages/db` schema; `user.additionalFields.handle` (required, `input: true`, `validator: { input: handleSchema }` for format).
- **Handle uniqueness:** better-auth swallows adapter errors during user creation into a generic `422 FAILED_TO_CREATE_USER`, so the DB unique error can't drive the UI. Instead a `hooks.before` middleware on path `/sign-up/email` looks up the handle and throws `APIError` 422 with code `HANDLE_TAKEN`. The DB unique index stays as the race backstop (a concurrent duplicate then surfaces as the generic failure).
- Error codes the sign-up form maps to fields: `HANDLE_TAKEN` → handle; `VALIDATION_ERROR` (400, which better-auth's `additionalFields` validator throws with the first Zod issue message and no field name; handle is the only validated additional field) → handle; `handleSchema` must stay synchronous (no async refinements), or better-auth throws `ASYNC_VALIDATION_NOT_SUPPORTED`; `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` → email; `PASSWORD_TOO_SHORT` → password; anything else → form-level message.
- `autoSignIn` on sign-up stays enabled (default). Turning it off or enabling email verification makes duplicate-email sign-ups return a fake success, which would break AC1/AC3.
- `secret` = HKDF `"better-auth"` subkey; `baseURL` = `PUBLIC_URL`; `trustedOrigins` = `[PUBLIC_URL origin]` plus `DEV_WEB_ORIGIN` when not in production. (Bearer requests without an Origin header, e.g. CLI sign-out, pass better-auth's origin check.)
- `bearer` plugin enabled: sign-in returns a session token the CLI stores; the server accepts `Authorization: Bearer <token>` as well as the session cookie.
- Session defaults (7 days, rolling).
- **One auth check:** `requireUser` (Fastify `preHandler` / decorator) calls `auth.api.getSession({ headers })`, which handles both cookie and bearer, and sets `request.user`. Used by `/api/me` and the WS upgrade. No second auth path.
- Sign-up is open (always on in S1). Closing sign-up and invites belong to S10 (GH issue).

### 7.5 WebSocket skeleton

- `@fastify/websocket`, route `GET /api/ws`.
- Upgrade checks, in a `preValidation` hook before the socket is accepted:
  1. **Origin:** if an `Origin` header is present it must equal `PUBLIC_URL`'s origin (or `DEV_WEB_ORIGIN` when not in production). Mismatch → 401, no socket.
  2. **No Origin header** is allowed only when the request carries `Authorization: Bearer`.
  3. **Session:** `requireUser`. No session → 401, no socket.
- On connect: server sends `hello { userId }`. On `ping` → `pong`. Invalid message → `error` (socket stays open). No server-side heartbeat in S1: an idle socket dropped by a proxy simply reconnects.
- The session is checked only at upgrade in S1. An open socket survives sign-out/expiry until it disconnects; on reconnect the upgrade fails with 401. Browsers don't expose the handshake status (a rejected upgrade looks like close code 1006, same as server down), so the web client handles it as described in §8. (Revoking live sockets on sign-out is left to the spec that first streams sensitive data, S3.)
- Deferred to S3 (with the first real stream): a per-user socket registry / fan-out and a heartbeat. The S1 seam is the shared Zod message union.

### 7.6 Static web

In production the server serves `apps/web/dist` via `@fastify/static`. `GET` requests not under `/api` and not matching a file fall back to `index.html` (SPA). The root `build` copies `apps/web/dist` to `apps/server/dist/public` (like migrations), and the server serves from the path relative to its own bundle. If that folder is missing (e.g. web not built, or `pnpm dev` where Vite serves the UI), the server logs one warning and serves the API only.

### 7.7 Version and bundle mode

Root `package.json` `version` (0.1.0) is the single source. esbuild `define` injects it as `__FACTORY_VERSION__` into the server and CLI bundles; dev (tsx) reads it from the root package.json. The server bundle also gets `__BUNDLED__ = true` via `define`; `index.ts` branches on it (bundled → migrations/web dist next to the bundle; source mode → `MIGRATIONS_DIR` exported by `@open-factory/db`) instead of inferring the mode from file names.

## 8. Web (apps/web)

- React + Vite, TanStack Router (file-based, Vite plugin), TanStack Query, Tailwind + shadcn/ui. better-auth React client for sign-in/up/out and session.
- Routes:
  - `/sign-in`, `/sign-up` (public; signed-in users are redirected to `/`).
  - Authenticated layout (guard in `beforeLoad`: `queryClient.ensureQueryData` of the session query, redirect to `/sign-in` if absent; sign-in, sign-up and sign-out invalidate/reset that query before navigating, so the guard never acts on a stale session) with sidebar nav **Inbox, Agents, Tasks, Templates, Schedules, Settings** and a user menu (name, `@handle`, Sign out).
  - `/` dashboard: two panels, Inbox and Agents, each empty.
  - `/inbox`, `/agents`, `/tasks`, `/templates`, `/schedules`, `/settings`: each shows a one-line plain-language empty state: "Nothing in your inbox.", "No agents yet.", "No tasks yet.", "No templates yet.", "No schedules yet.", "Nothing to configure yet." (dashboard panels reuse the Inbox and Agents lines). No "coming soon" teasers, no internals.
- Sign-up form fields: name, handle, email, password. Client-side validation via the shared schemas; server errors mapped to fields per §7.4. After sign-up the user lands on `/` (no onboarding wizard).
- Theme follows the system (light/dark) via CSS `@media (prefers-color-scheme: dark)` only; no toggle, no JS theme switching. No toast library in S1.
- **WS client:** one reconnecting client module (`lib/ws.ts`) opened by the authenticated layout, exponential backoff with jitter (cap ~30s), parses messages with the shared Zod union, exposes connection status. On any close (including one before the socket opened), it re-fetches the session query: no session → invalidate it and route to `/sign-in` (stop reconnecting); session present → keep backing off. S1 uses it only to establish the authenticated connection; later specs add handlers.
- **Dev:** Vite dev server proxies `/api` (including WS upgrade) to the Fastify dev server.

### 8.1 Markdown components

- `<Markdown source>`: `react-markdown` + `remark-gfm` (tables, task lists, strikethrough, autolinks). No raw HTML (no `rehype-raw`), default URL sanitizing kept. External links get `target="_blank" rel="noopener noreferrer"`.
- Styled with Tailwind's `@tailwindcss/typography` (`prose`).
- Code blocks: Shiki, lazy-loaded, theme follows light/dark; plain `<pre>` until loaded. Fenced blocks without a language still render as a block inside `<pre>`; only inline code renders as bare `<code>`.
- ` ```mermaid ` blocks: `mermaid` dynamically imported only when such a block is present, initialized with `securityLevel: "strict"` (rendered content will later include untrusted agent output). Render errors show the source in a code block with a short error note.
- `<MarkdownEditor value onChange>`: a plain `<textarea>` (raw markdown) with Write / Preview tabs; Preview uses `<Markdown>`.
- Not mounted on any S1 route. Verified by component tests only (§10).

## 9. Dev compose, production run, README

- `docker-compose.dev.yml`: one `postgres:18` service (current major, pinned; the CI service uses the same tag), port 5432, user/password/db `factory`, named volume. `.env.example`'s `DATABASE_URL` matches.
- README quickstart:

  ```
  docker compose -f docker-compose.dev.yml up -d
  cp .env.example .env   # set FACTORY_SECRET_KEY
  pnpm install && pnpm build && npm start
  ```

  plus: prerequisites (Node 24, pnpm via `corepack enable`, Docker for Postgres); for servers set `HOST=0.0.0.0` **and** `PUBLIC_URL` to the public origin (put TLS in front); open the app at exactly `PUBLIC_URL`; the key-rotation limitation; `pnpm dev` for development; CLI usage.

## 10. CLI (apps/cli)

- esbuild single-file ESM bundle `apps/cli/dist/open-factory.js` with a shebang. No CLI framework: `node:util` `parseArgs` + a small command table (`{ name, summary, run }`) — the table is the seam for future commands.
- Commands:
  - `open-factory help` / no args: plain usage list. `open-factory --version`: CLI version.
  - `open-factory login [--url <url>]`: prompts for URL (default from config or `http://localhost:3000`), email, password (hidden input via `node:readline` with muted output). Calls `POST /api/auth/sign-in/email`, reads the bearer token from the `set-auth-token` response header, verifies it with `/api/me`, saves config. Prints `Logged in as @handle`.
  - `open-factory logout`: calls `POST /api/auth/sign-out` with the bearer token and body `{}` (revokes the server session), then removes the token from the config file. Succeeds (with a note) if the server is unreachable — the local token is still removed.
  - `open-factory status`: prints server URL, server version (`/api/status`), DB state, CLI version, and `Logged in as @handle` (via `/api/me`) or `Not logged in`. Not logged in → exit 0. Server unreachable → plain message, exit 1.
- Config file: `${XDG_CONFIG_HOME:-~/.config}/open-factory/cli.json` = `{ url, token }`, written with mode `0600` (dir `0700`).
- Env overrides `OPEN_FACTORY_URL` and `OPEN_FACTORY_TOKEN` take precedence over the file.

## 11. Testing

Real Postgres everywhere: locally from the compose file, in CI from a `services: postgres` container with the same image tag.

- **Test DB harness:** per test file, create a database with a random name, run `migrate()`, build the app with `buildApp`, drop the database afterwards. Uses `DATABASE_URL`'s server with an admin connection.
- **Server integration tests** (Fastify `inject()`, plus a real `listen` on port 0 for WS) — one or two thorough tests per behaviour:
  - sign-up succeeds and `/api/me` returns `{ id, email, name, handle }`; duplicate handle → `HANDLE_TAKEN`; invalid and reserved handles rejected;
  - `/api/me` with cookie works, with bearer works, without → 401;
  - `/api/status` returns version and `db: "ok"`;
  - unknown `/api/x` → JSON 404; non-API GET → `index.html` (when a web dist fixture is present);
  - WS: authenticated upgrade gets `hello` and ping/pong; no session → 401; bad Origin → 401; no Origin without bearer → 401;
  - config: missing/invalid vars are all reported together; HKDF derives distinct, stable subkeys.
- **CLI tests:** command parsing and config-file read/write (0600, XDG, env overrides); login/status/logout against a test server instance.
- **Web component tests** (Vitest + Testing Library, jsdom): `<Markdown>` renders a GFM table, a task list, a highlighted code block, a mermaid block (mermaid mocked or rendered to SVG), and does **not** render raw HTML/`<script>`; external link rel attributes; `<MarkdownEditor>` Write → Preview → Write round-trip keeps the text.
- No Playwright in S1.

## 12. CI (`.github/workflows/ci.yml`)

One job on `push` to `main` and on `pull_request`: Ubuntu, Node 24, pnpm via `pnpm/action-setup`, pnpm store cache, `services: postgres` (`postgres:18`, health-checked). Steps:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint:ci` (`biome ci .`)
3. `pnpm typecheck`
4. `pnpm test` (with `DATABASE_URL` pointing at the service)
5. `pnpm build`
6. **CLI smoke:** start the built server in the background with a test `FACTORY_SECRET_KEY`, wait for `/api/status`, run `node apps/cli/dist/open-factory.js status`, assert that the **server version line** (e.g. `Server version: 0.1.0`) matches the root `package.json` version (not just any occurrence, since the CLI version line contains it too).

## 13. Error handling summary

| Situation                     | Behaviour                                                        |
| ----------------------------- | ---------------------------------------------------------------- |
| Bad/missing env               | All problems listed, exit 1 before touching the DB               |
| DB unreachable at boot        | `migrate()` fails → logged, exit 1                               |
| DB down while running         | `/api/status` reports `db: "error"`; auth routes return 500 JSON |
| Validation error              | 400 `{ error: { code: "validation_error", message } }`           |
| No session                    | 401 `unauthorized` (REST) / 401 on WS upgrade                    |
| Unknown API route or resource | 404 JSON                                                         |
| CLI: server unreachable       | plain message, exit 1 (logout still clears local token)          |

## 14. Follow-up issues to open (not S1 work)

1. **Close open sign-up before v0.1 ships** (owner: S10). Once agents and credentials exist, open sign-up on a reachable server makes anyone an admin.
2. **No password reset** in v0.1 (no mail transport) — recorded limitation.
3. **Roadmap AC wording:** `docs/product/roadmap/v0.1/s01-foundation.md` AC should read "fresh clone → start Postgres → copy `.env.example` and set `FACTORY_SECRET_KEY` → install, build, `npm start`" (the product docs are not tracked in git; update the local copy).

Note: `fastify-type-provider-zod` lists `@fastify/swagger` and `openapi-types` as peers; expect pnpm peer warnings or auto-installs. That is not an OpenAPI feature (Q9 decided no OpenAPI).

## 15. Decisions needing Or's call (owner-proxy certainty 3/5)

- Q2: handle chosen at sign-up (vs derived from email).
- Q5: `npm start` does not build; AC reworded.
- Q8: esbuild bundles the server too; internal packages have no build step.
- Q12: markdown components verified by tests only, not mounted on a route.
- Q15: `open-factory logout` included.
- Q7 (sub-decision): single `FACTORY_SECRET_KEY` with HKDF subkeys.

Full question/option/rationale log: the GitHub issue "S1 Foundation: design decisions".
