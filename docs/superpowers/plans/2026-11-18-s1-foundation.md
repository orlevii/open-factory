# S1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an empty but real Open Factory: a pnpm TypeScript monorepo with a Fastify server, Postgres/Drizzle, better-auth email/password sign-up with handles, an authenticated WebSocket skeleton, a React shell with empty screens, markdown components, the `open-factory` CLI (`login`/`status`/`logout`), and green CI.

**Architecture:** One Node process (Fastify) serves `/api` (REST, better-auth at `/api/auth/*`, WebSocket at `/api/ws`) and the built SPA. Workspace packages (`packages/shared`, `packages/db`) are TS source with no build step. esbuild bundles the server and the CLI, and Vite builds the web app. Migrations run at boot through one `migrate()`.

**Tech Stack:** Node 24, pnpm, TypeScript (latest, 7.x), Fastify 5, better-auth (bearer plugin), Drizzle ORM + drizzle-kit + postgres.js, Zod 4, fastify-type-provider-zod, @fastify/websocket, @fastify/static, React 19, Vite, TanStack Router (file-based) + Query, Tailwind 4 + shadcn/ui, react-markdown + remark-gfm + Shiki + mermaid, esbuild, Vitest + Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-11-18-s1-foundation-design.md` (read it first; it wins over this plan on any conflict). Decision log: https://github.com/orlevii/open-factory/issues/3. Follow-ups that are NOT S1 work: #1 (close sign-up), #2 (password reset).

## Global Constraints

- **Versions rule:** add every dependency with `pnpm add <pkg>@latest` (or `pnpm add -D <pkg>@latest`), and verify with `npm view <pkg> version` that the lockfile has the latest. Never hand-pin versions. The only pinned version is the Docker image `postgres:18` (compose and CI).
- **API drift:** the code in this plan targets the versions current on 2026-11-18 (fastify 5.12, better-auth 1.7.25, drizzle-orm 0.45, zod 4.6, vite 8, vitest 5.1, @tanstack/react-router 1.170, tailwindcss 4.3, typescript 7.0). If a snippet doesn't compile against the installed latest, check the library docs (context7 `query-docs`) and adapt it. Keep the behavior; don't change the design.
- All packages are ESM (`"type": "module"`), `engines.node >= 24`. Package scope: `@open-factory/*`.
- `packages/*` have no build step. `exports` point at `.ts` source.
- Biome is the only lint/format tool. No ESLint or Prettier.
- No dotenv. Node `--env-file-if-exists=.env` loads env.
- Env vars: `DATABASE_URL` (required), `FACTORY_SECRET_KEY` (required, >= 32 chars, the placeholder is rejected), `FACTORY_HOME` (default `~/open-factory`, resolved, not created), `PUBLIC_URL` (default `http://localhost:${PORT}`), `DEV_WEB_ORIGIN` (default `http://localhost:5173`, trusted only when `NODE_ENV !== "production"`), `PORT` (default 3000), `HOST` (default `127.0.0.1`), `LOG_LEVEL` (default `info`), `NODE_ENV`.
- Placeholder secret in `.env.example`: `change-me-to-a-random-string-of-32-chars-or-more`.
- Factory error shape: `{ error: { code, message } }`. `/api/auth/*` keeps better-auth's own `{ code, message }`.
- Handles: 2–32 chars, `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, not in `RESERVED_HANDLES = ["humans", "me", "scheduler"]`, synchronous schema only.
- better-auth tables are plural (`usePlural: true`): `users`, `sessions`, `accounts`, `verifications`. `users.handle` is `text not null` with a unique index.
- Empty-state copy (exact): Inbox "Nothing in your inbox.", Agents "No agents yet.", Tasks "No tasks yet.", Templates "No templates yet.", Schedules "No schedules yet.", Settings "Nothing to configure yet."
- CLI config: `${XDG_CONFIG_HOME:-~/.config}/open-factory/cli.json`, file mode 0600, dir 0700. `OPEN_FACTORY_URL` and `OPEN_FACTORY_TOKEN` override the file.
- Out of scope: invites, closing sign-up, password reset, WS topics/subscriptions, agent tokens, Playwright, OpenAPI, a `db:migrate` script, creating `FACTORY_HOME`, a dev route for markdown.
- Commit after every task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
package.json                     root: name open-factory, version 0.1.0, private, scripts, engines, packageManager
pnpm-workspace.yaml              apps/*, packages/*
tsconfig.base.json               strict ESM base
biome.json                       lint+format; ignores dist, routeTree.gen.ts, migrations meta
vitest.config.ts                 test.projects (node + web jsdom)
.env.example / .gitignore / docker-compose.dev.yml / README.md
.github/workflows/ci.yml
scripts/smoke-cli.sh             CI smoke: built server + `open-factory status`
scripts/build.mjs                root build orchestration (server, cli, web, copy assets)

packages/shared/src/
  index.ts                       re-exports
  handle.ts                      RESERVED_HANDLES, handleSchema
  schemas.ts                     signUpSchema, meSchema, statusSchema, apiErrorSchema
  ws.ts                          clientMessageSchema, serverMessageSchema
  api-fetch.ts                   apiFetch, ApiError
  *.test.ts

packages/db/
  drizzle.config.ts
  migrations/                    generated SQL (committed)
  src/index.ts                   re-exports
  src/schema/auth.ts             users/sessions/accounts/verifications (+ handle)
  src/schema/index.ts
  src/client.ts                  createDb(url) -> { db, sql }
  src/migrate.ts                 migrate(url, migrationsFolder)
  src/testing.ts                 createTestDatabase() for tests
  src/migrate.test.ts

packages/harness/src/index.ts    `export {};`

apps/server/
  build.mjs                      esbuild bundle
  src/index.ts                   boot
  src/version.ts                 FACTORY_VERSION
  src/config.ts                  loadConfig(env)
  src/crypto/keys.ts             deriveKey(root, purpose)
  src/auth/options.ts            authOptions(params) — pure, no env
  src/auth/auth.ts               createAuth(config, db)
  src/auth/require-user.ts       requireUser + getUser
  src/routes/auth.ts             /api/auth/* bridge
  src/routes/status.ts           GET /api/status
  src/routes/me.ts               GET /api/me
  src/ws/route.ts                GET /api/ws
  src/static.ts                  SPA serving
  src/errors.ts                  error + not-found handlers
  src/app.ts                     buildApp(config, deps)
  src/test/helpers.ts            makeTestApp, signUp helper
  src/**/*.test.ts

apps/web/
  index.html, vite.config.ts, components.json, src/main.tsx, src/styles.css
  src/routeTree.gen.ts           committed
  src/lib/auth-client.ts, src/lib/session.ts, src/lib/ws.ts, src/lib/utils.ts
  src/routes/__root.tsx, sign-in.tsx, sign-up.tsx, _app.tsx, _app/index.tsx,
             _app/inbox.tsx, _app/agents.tsx, _app/tasks.tsx, _app/templates.tsx,
             _app/schedules.tsx, _app/settings.tsx
  src/components/empty-state.tsx, app-sidebar.tsx, auth-error.ts
  src/components/markdown/markdown.tsx, code-block.tsx, mermaid-block.tsx, markdown-editor.tsx, *.test.tsx
  src/components/ui/*            shadcn-generated

apps/cli/
  build.mjs
  src/index.ts                   entry: parse + dispatch
  src/commands.ts                command table
  src/config-store.ts            read/write cli.json
  src/client.ts                  resolveTarget, http helpers
  src/prompt.ts                  ask, askHidden
  src/commands/{login,logout,status,help}.ts
  src/*.test.ts
```

---

### Task 1: Workspace scaffold, toolchain, dev Postgres

**Files:**

- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.dev.yml`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`, `packages/db/{package.json,tsconfig.json,src/index.ts}`, `packages/harness/{package.json,tsconfig.json,src/index.ts}`, `apps/server/{package.json,tsconfig.json,src/index.ts}`, `apps/cli/{package.json,tsconfig.json,src/index.ts}` (stubs; apps/web is created in Task 8)
- Test: `packages/shared/src/sanity.test.ts` (deleted in Task 2)

**Interfaces:**

- Produces: root scripts `typecheck`, `lint`, `lint:fix`, `lint:ci`, `test`. Package names `@open-factory/shared`, `@open-factory/db`, `@open-factory/harness`, `@open-factory/server`, `@open-factory/cli`.

- [ ] **Step 1: Root files**

`package.json`:

```json
{
  "name": "open-factory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "pnpm --parallel --filter @open-factory/server --filter @open-factory/web dev",
    "build": "node scripts/build.mjs",
    "start": "node --env-file-if-exists=.env apps/server/dist/index.js",
    "test": "vitest run",
    "typecheck": "pnpm -r --parallel exec tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "lint:ci": "biome ci .",
    "db:generate": "pnpm --filter @open-factory/db generate"
  }
}
```
Then run `corepack use pnpm@latest`, which sets the `packageManager` field (verify with `npm view pnpm version`). Leave `scripts/build.mjs` for Task 7. Until then `pnpm build` fails, which is expected.

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  }
}
```

`.gitignore`:

```
node_modules/
dist/
.env
*.tsbuildinfo
coverage/
```

`.env.example`:

```
DATABASE_URL=postgres://factory:factory@localhost:5432/factory
# Generate with: openssl rand -base64 32
FACTORY_SECRET_KEY=change-me-to-a-random-string-of-32-chars-or-more
# FACTORY_HOME=~/open-factory
# PUBLIC_URL=http://localhost:3000
# PORT=3000
# HOST=127.0.0.1
# LOG_LEVEL=info
```

`docker-compose.dev.yml`:

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: factory
      POSTGRES_PASSWORD: factory
      POSTGRES_DB: factory
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U factory"]
      interval: 2s
      timeout: 5s
      retries: 20
volumes:
  pgdata:
```
(Postgres 18 images keep data under `/var/lib/postgresql`. Mounting the old `/var/lib/postgresql/data` path makes the container refuse to start.)

- [ ] **Step 2: Package stubs**

Each `packages/<name>/package.json`, here `shared` (same shape for `db`, `harness`):

```json
{
  "name": "@open-factory/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```
Each package `tsconfig.json` (non-web):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"], "lib": ["es2024"] },
  "include": ["src", "*.ts"]
}
```
`packages/harness/src/index.ts`: `export {};`. `packages/shared/src/index.ts` and `packages/db/src/index.ts`: `export {};` for now.
`apps/server/package.json` and `apps/cli/package.json`: same shape with name `@open-factory/server` / `@open-factory/cli`, without `exports`, `src/index.ts` = `export {};`.

- [ ] **Step 3: Install toolchain at latest**

```bash
pnpm add -Dw typescript@latest @types/node@latest vitest@latest @biomejs/biome@latest tsx@latest esbuild@latest
npm view typescript version && npm view vitest version && npm view @biomejs/biome version
pnpm biome init
```
Then edit `biome.json`. Keep the generated `$schema` line and merge in the following, adapting key names if the installed Biome version renamed them:

```json
{
  "files": {
    "includes": [
      "**",
      "!**/dist",
      "!**/node_modules",
      "!**/routeTree.gen.ts",
      "!packages/db/migrations/meta",
      "!apps/web/src/components/ui"
    ]
  },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

- [ ] **Step 4: Vitest projects + sanity test**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/server/src/**/*.test.ts",
            "apps/cli/src/**/*.test.ts",
          ],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      "apps/web",
    ],
  },
});
```
(The `apps/web` project is created in Task 8. Leave this entry out until then, because Vitest errors on a missing project. Task 8 adds it back.)

`packages/shared/src/sanity.test.ts`:

```ts
import { expect, test } from "vitest";
test("toolchain runs", () => expect(1 + 1).toBe(2));
```

- [ ] **Step 5: Verify**

```bash
pnpm install && pnpm test && pnpm typecheck && pnpm lint:ci
docker compose -f docker-compose.dev.yml up -d && docker compose -f docker-compose.dev.yml ps
```
Expected: 1 test passes, typecheck and lint clean, postgres healthy.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm workspace, toolchain and dev postgres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared schemas, WS messages and `apiFetch`

**Files:**

- Create: `packages/shared/src/{handle.ts,schemas.ts,ws.ts,api-fetch.ts}`, tests `handle.test.ts`, `ws.test.ts`, `api-fetch.test.ts`
- Modify: `packages/shared/src/index.ts`. Delete `sanity.test.ts`.

**Interfaces:**

- Produces:
  - `RESERVED_HANDLES: readonly ["humans","me","scheduler"]`, `handleSchema: z.ZodString-like` (sync)
  - `signUpSchema` `{ name: string; handle: string; email: string; password: string }`, `meSchema` `{ id; email; name; handle }` (type `Me`), `statusSchema` `{ version: string; db: "ok"|"error" }` (type `Status`), `apiErrorSchema` (type `ApiErrorBody`)
  - `clientMessageSchema` (`{type:"ping"}`), `serverMessageSchema` (`hello{userId}` | `pong` | `error{code,message}`), types `ClientMessage`, `ServerMessage`
  - `class ApiError extends Error { status: number; code: string }`, `apiFetch<T>(path: string, opts: { baseUrl?: string; token?: string; method?: string; body?: unknown; schema: z.ZodType<T>; fetchImpl?: typeof fetch }): Promise<T>`

- [ ] **Step 1: Install zod**

`pnpm --filter @open-factory/shared add zod@latest && npm view zod version`

- [ ] **Step 2: Failing tests**

`packages/shared/src/handle.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { RESERVED_HANDLES, handleSchema } from "./handle.ts";

describe("handleSchema", () => {
  test.each(["or", "or-levi", "a1", "x".repeat(32), "9lives"])("accepts %s", (h) => {
    expect(handleSchema.safeParse(h).success).toBe(true);
  });
  test.each(["a", "x".repeat(33), "Or", "-or", "or-", "or_levi", "or levi", "", "élan"])(
    "rejects %s",
    (h) => expect(handleSchema.safeParse(h).success).toBe(false),
  );
  test("rejects reserved handles", () => {
    for (const h of RESERVED_HANDLES) expect(handleSchema.safeParse(h).success).toBe(false);
    expect(RESERVED_HANDLES).toEqual(["humans", "me", "scheduler"]);
  });
  test("is synchronous (better-auth rejects async validators)", () => {
    expect(() => handleSchema.parse("ok-handle")).not.toThrow();
  });
});
```

`packages/shared/src/ws.test.ts`:

```ts
import { expect, test } from "vitest";
import { clientMessageSchema, serverMessageSchema } from "./ws.ts";

test("parses client ping and rejects unknown types", () => {
  expect(clientMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
  expect(clientMessageSchema.safeParse({ type: "subscribe", topic: "x" }).success).toBe(false);
});

test("parses server messages", () => {
  expect(serverMessageSchema.parse({ type: "hello", userId: "u1" }).type).toBe("hello");
  expect(serverMessageSchema.parse({ type: "pong" }).type).toBe("pong");
  expect(serverMessageSchema.parse({ type: "error", code: "bad_message", message: "x" }).type).toBe(
    "error",
  );
});
```

`packages/shared/src/api-fetch.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch } from "./api-fetch.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("parses a 2xx body with the schema and sends bearer + json body", async () => {
  const fetchImpl = vi.fn(async () => json(200, { ok: true }));
  const out = await apiFetch("/api/x", {
    baseUrl: "http://h:1",
    token: "t",
    method: "POST",
    body: { a: 1 },
    schema: z.object({ ok: z.boolean() }),
    fetchImpl,
  });
  expect(out).toEqual({ ok: true });
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://h:1/api/x");
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe("Bearer t");
  expect(headers.get("content-type")).toBe("application/json");
  expect(init.body).toBe('{"a":1}');
});

test("turns factory error bodies into ApiError", async () => {
  const fetchImpl = vi.fn(async () =>
    json(404, { error: { code: "not_found", message: "Not found" } }),
  );
  const err = await apiFetch("/api/x", { schema: z.any(), fetchImpl }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 404, code: "not_found", message: "Not found" });
});

test("turns better-auth error bodies into ApiError", async () => {
  const fetchImpl = vi.fn(async () =>
    json(422, { code: "HANDLE_TAKEN", message: "Handle is taken" }),
  );
  const err = await apiFetch("/api/auth/sign-up/email", { schema: z.any(), fetchImpl }).catch(
    (e) => e,
  );
  expect(err).toMatchObject({ status: 422, code: "HANDLE_TAKEN" });
});

test("non-json errors get code http_<status>", async () => {
  const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 }));
  const err = await apiFetch("/api/x", { schema: z.any(), fetchImpl }).catch((e) => e);
  expect(err).toMatchObject({ status: 502, code: "http_502" });
});
```

- [ ] **Step 3: Run, expect FAIL** (`pnpm vitest run packages/shared`): modules not found.

- [ ] **Step 4: Implement**

`packages/shared/src/handle.ts`:

```ts
import { z } from "zod";

/** Addresses the product uses (@humans, @me, @scheduler). Specs that add an address add it here. */
export const RESERVED_HANDLES = ["humans", "me", "scheduler"] as const;

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Must stay synchronous: better-auth's additionalFields validator rejects async schemas.
export const handleSchema = z
  .string()
  .min(2, "Handle must be at least 2 characters")
  .max(32, "Handle must be at most 32 characters")
  .regex(HANDLE_PATTERN, "Use lowercase letters, digits and inner hyphens")
  .refine((h) => !(RESERVED_HANDLES as readonly string[]).includes(h), "This handle is reserved");
```

`packages/shared/src/schemas.ts`:

```ts
import { z } from "zod";
import { handleSchema } from "./handle.ts";

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  handle: handleSchema,
  email: z.email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  handle: z.string(),
});
export type Me = z.infer<typeof meSchema>;

export const statusSchema = z.object({ version: z.string(), db: z.enum(["ok", "error"]) });
export type Status = z.infer<typeof statusSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
```

`packages/shared/src/ws.ts`:

```ts
import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), userId: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
```

`packages/shared/src/api-fetch.ts`:

```ts
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions<T> {
  baseUrl?: string;
  token?: string;
  method?: string;
  body?: unknown;
  schema: z.ZodType<T>;
  fetchImpl?: typeof fetch;
}

export async function apiFetch<T>(path: string, opts: ApiFetchOptions<T>): Promise<T> {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? ""}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "include",
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const d = data as
      | { error?: { code?: string; message?: string }; code?: string; message?: string }
      | undefined;
    const code = d?.error?.code ?? d?.code ?? `http_${res.status}`;
    const message = d?.error?.message ?? d?.message ?? (res.statusText || `HTTP ${res.status}`);
    throw new ApiError(res.status, code, message);
  }
  return opts.schema.parse(data);
}
```

`packages/shared/src/index.ts`:

```ts
export * from "./api-fetch.ts";
export * from "./handle.ts";
export * from "./schemas.ts";
export * from "./ws.ts";
```

- [ ] **Step 5: Run, expect PASS**: `pnpm vitest run packages/shared && pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**: `feat(shared): handle, api, ws schemas and apiFetch`

---

### Task 3: DB package — auth schema, migrations, `migrate()`, test databases

**Files:**

- Create: `packages/db/drizzle.config.ts`, `packages/db/src/schema/{auth.ts,index.ts}`, `packages/db/src/{client.ts,migrate.ts,testing.ts,migrate.test.ts}`, `packages/db/migrations/*` (generated)
- Modify: `packages/db/package.json`, `packages/db/src/index.ts`

**Interfaces:**

- Produces:
  - `schema` (namespace export): `users`, `sessions`, `accounts`, `verifications` Drizzle tables. `users` has `handle`.
  - `createDb(url: string): { db: Db; sql: postgres.Sql; close(): Promise<void> }`, `type Db = PostgresJsDatabase<typeof schema>`
  - `migrate(url: string, migrationsFolder: string): Promise<void>`
  - `MIGRATIONS_DIR: string` (absolute path to `packages/db/migrations`, valid when running from source)
  - `createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }>` from `@open-factory/db/testing` (reads `process.env.DATABASE_URL`, default `postgres://factory:factory@localhost:5432/factory`)

- [ ] **Step 1: Install**

```bash
pnpm --filter @open-factory/db add drizzle-orm@latest postgres@latest
pnpm --filter @open-factory/db add -D drizzle-kit@latest
npm view drizzle-orm version && npm view drizzle-kit version && npm view postgres version
```
`packages/db/package.json` gets:

```json
"exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
"scripts": { "generate": "drizzle-kit generate" }
```

- [ ] **Step 2: Auth schema**

Generate better-auth's Drizzle schema once with better-auth's CLI (today the npm package `auth`, formerly `@better-auth/cli`; verify `npm view auth version` matches `npm view better-auth version`). The generator needs an auth config file. Task 5 creates the real `authOptions`, so for generation write a throwaway config in `$TMPDIR` that sets `usePlural: true`, `emailAndPassword.enabled`, the bearer plugin and `user.additionalFields.handle`, run `pnpm dlx auth@latest generate --config <tmp> --output packages/db/src/schema/auth.ts`, then delete the throwaway file. Hand-edit the output so it matches the code below exactly. If the generator fails, writing the file by hand is fine. The code below is the source of truth:

`packages/db/src/schema/auth.ts`:

```ts
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    handle: text("handle").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("users_handle_unique").on(t.handle)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);
```
If the generator output for the installed better-auth has extra or renamed columns, keep the generator's columns (better-auth needs them) and add only `handle` + `users_handle_unique`.

`packages/db/src/schema/index.ts`: `export * from "./auth.ts";`

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
```

- [ ] **Step 3: Generate the initial migration**

`pnpm db:generate`. Expected: `packages/db/migrations/0000_*.sql` creates the 4 tables and `users_handle_unique`, plus `migrations/meta/`. Read the SQL and confirm the unique index exists.

- [ ] **Step 4: Failing test**

`packages/db/src/migrate.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./client.ts";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";
import { createTestDatabase } from "./testing.ts";

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.drop();
});

test("migrate creates auth tables and is idempotent; handle is unique", async () => {
  await migrate(tdb.url, MIGRATIONS_DIR);
  await migrate(tdb.url, MIGRATIONS_DIR); // second run is a no-op
  const { sql, close } = createDb(tdb.url);
  try {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["accounts", "sessions", "users", "verifications"]),
    );
    await sql`insert into users (id, name, email, handle) values ('1', 'A', 'a@x.io', 'dup')`;
    await expect(
      sql`insert into users (id, name, email, handle) values ('2', 'B', 'b@x.io', 'dup')`,
    ).rejects.toThrow(/users_handle_unique/);
  } finally {
    await close();
  }
});
```

- [ ] **Step 5: Run, expect FAIL** (`pnpm vitest run packages/db`).

- [ ] **Step 6: Implement**

`packages/db/src/client.ts`:

```ts
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string) {
  const sql = postgres(url, { onnotice: () => {} });
  const db: Db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
```

`packages/db/src/migrate.ts`:

```ts
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Valid when running from source (tests, tsx). The server bundle passes its own copied folder. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** The one place pending migrations are applied: server boot and test setup. */
export async function migrate(url: string, migrationsFolder: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await drizzleMigrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
```

`packages/db/src/testing.ts`:

```ts
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const DEFAULT_URL = "postgres://factory:factory@localhost:5432/factory";

/** Creates a throwaway database on DATABASE_URL's server. Call drop() in afterAll. */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const base = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  const name = `of_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const a = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists "${name}" with (force)`);
      await a.end();
    },
  };
}
```

`packages/db/src/index.ts`:

```ts
export * from "./client.ts";
export * from "./migrate.ts";
export * as schema from "./schema/index.ts";
```

- [ ] **Step 7: Run, expect PASS**: `pnpm vitest run packages/db && pnpm typecheck && pnpm lint`

- [ ] **Step 8: Commit**: `feat(db): auth schema with unique handle, migrations and migrate()`

---

### Task 4: Server config and key derivation

**Files:**

- Create: `apps/server/src/config.ts`, `apps/server/src/crypto/keys.ts`, `apps/server/src/version.ts`, tests `config.test.ts`, `crypto/keys.test.ts`

**Interfaces:**

- Produces:
  - `interface Config { databaseUrl: string; secretKey: string; factoryHome: string; publicUrl: string; publicOrigin: string; devWebOrigin: string; port: number; host: string; logLevel: string; isProduction: boolean }`
  - `loadConfig(env: NodeJS.ProcessEnv): Config`, which throws `ConfigError` (`.issues: string[]`) listing every problem
  - `PLACEHOLDER_SECRET = "change-me-to-a-random-string-of-32-chars-or-more"`
  - `deriveKey(root: string, purpose: "better-auth" | "secret-encryption"): Buffer` (32 bytes), `authSecret(root: string): string` (base64url of the `"better-auth"` key)
  - `FACTORY_VERSION: string`

- [ ] **Step 1: Install**: `pnpm --filter @open-factory/server add zod@latest`

- [ ] **Step 2: Failing tests**

`apps/server/src/config.test.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError, PLACEHOLDER_SECRET, loadConfig } from "./config.ts";

const ok = { DATABASE_URL: "postgres://u:p@localhost:5432/db", FACTORY_SECRET_KEY: "x".repeat(32) };

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig(ok);
    expect(c).toMatchObject({
      port: 3000,
      host: "127.0.0.1",
      logLevel: "info",
      publicUrl: "http://localhost:3000",
      publicOrigin: "http://localhost:3000",
      devWebOrigin: "http://localhost:5173",
      isProduction: false,
      factoryHome: path.join(os.homedir(), "open-factory"),
    });
  });
  test("PUBLIC_URL defaults follow PORT; FACTORY_HOME expands ~ and resolves", () => {
    const c = loadConfig({ ...ok, PORT: "4000", FACTORY_HOME: "~/x/../y" });
    expect(c.publicUrl).toBe("http://localhost:4000");
    expect(c.factoryHome).toBe(path.join(os.homedir(), "y"));
  });
  test("reports every problem at once", () => {
    let err: unknown;
    try {
      loadConfig({ FACTORY_SECRET_KEY: "short", PORT: "nope", PUBLIC_URL: "ftp://x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).issues.join("\n");
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/FACTORY_SECRET_KEY/);
    expect(msg).toMatch(/PORT/);
    expect(msg).toMatch(/PUBLIC_URL/);
  });
  test("rejects the .env.example placeholder with a hint", () => {
    expect(() => loadConfig({ ...ok, FACTORY_SECRET_KEY: PLACEHOLDER_SECRET })).toThrow(
      /openssl rand -base64 32/,
    );
  });
  test("production flag", () => {
    expect(loadConfig({ ...ok, NODE_ENV: "production" }).isProduction).toBe(true);
  });
});
```

`apps/server/src/crypto/keys.test.ts`:

```ts
import { expect, test } from "vitest";
import { authSecret, deriveKey } from "./keys.ts";

test("subkeys are 32 bytes, stable, and distinct per purpose and root", () => {
  const root = "r".repeat(32);
  const a1 = deriveKey(root, "better-auth");
  expect(a1).toHaveLength(32);
  expect(deriveKey(root, "better-auth").equals(a1)).toBe(true);
  expect(deriveKey(root, "secret-encryption").equals(a1)).toBe(false);
  expect(deriveKey("s".repeat(32), "better-auth").equals(a1)).toBe(false);
  expect(authSecret(root)).toBe(a1.toString("base64url"));
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement**

`apps/server/src/config.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const PLACEHOLDER_SECRET = "change-me-to-a-random-string-of-32-chars-or-more";

export interface Config {
  databaseUrl: string;
  secretKey: string;
  factoryHome: string;
  publicUrl: string;
  publicOrigin: string;
  devWebOrigin: string;
  port: number;
  host: string;
  logLevel: string;
  isProduction: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const httpUrl = z.url({ protocol: /^https?$/, message: "must be an http(s) URL" });

const envSchema = z.object({
  DATABASE_URL: z.string({ message: "is required" }).min(1, "is required"),
  FACTORY_SECRET_KEY: z
    .string({ message: "is required" })
    .min(32, "must be at least 32 characters")
    .refine(
      (v) => v !== PLACEHOLDER_SECRET,
      "is still the .env.example placeholder; generate one with `openssl rand -base64 32`",
    ),
  FACTORY_HOME: z.string().min(1).default("~/open-factory"),
  PUBLIC_URL: httpUrl.optional(),
  DEV_WEB_ORIGIN: httpUrl.default("http://localhost:5173"),
  PORT: z.coerce.number({ message: "must be a port number" }).int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.string().optional(),
});

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`));
  }
  const e = parsed.data;
  const publicUrl = (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, "");
  return {
    databaseUrl: e.DATABASE_URL,
    secretKey: e.FACTORY_SECRET_KEY,
    factoryHome: expandHome(e.FACTORY_HOME),
    publicUrl,
    publicOrigin: new URL(publicUrl).origin,
    devWebOrigin: new URL(e.DEV_WEB_ORIGIN).origin,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    isProduction: e.NODE_ENV === "production",
  };
}
```

`apps/server/src/crypto/keys.ts`:

```ts
import { hkdfSync } from "node:crypto";

export type KeyPurpose = "better-auth" | "secret-encryption";
const SALT = "open-factory/v1";

/** The one place subkeys are derived from FACTORY_SECRET_KEY (HKDF-SHA256, 32 bytes). */
export function deriveKey(root: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", root, SALT, purpose, 32));
}

export function authSecret(root: string): string {
  return deriveKey(root, "better-auth").toString("base64url");
}
```

`apps/server/src/version.ts`:

```ts
import { readFileSync } from "node:fs";

declare const __FACTORY_VERSION__: string | undefined;

function readRootVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** Injected by esbuild in the bundle; read from the root package.json when running from source. */
export const FACTORY_VERSION: string =
  typeof __FACTORY_VERSION__ === "string" ? __FACTORY_VERSION__ : readRootVersion();
```

- [ ] **Step 5: Run, expect PASS**: `pnpm vitest run apps/server && pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**: `feat(server): env config with fail-fast and HKDF key derivation`

---

### Task 5: Fastify app — errors, logging, `/api/status`, better-auth, `/api/me`

**Files:**

- Create: `apps/server/src/{app.ts,errors.ts}`, `src/routes/{status.ts,me.ts,auth.ts}`, `src/auth/{options.ts,auth.ts,require-user.ts}`, `src/test/helpers.ts`, tests `src/routes/status.test.ts`, `src/auth/auth.test.ts`
- Modify: `apps/server/package.json`

**Interfaces:**

- Consumes: `Config`, `loadConfig`, `authSecret`, `FACTORY_VERSION` (Task 4); `createDb`, `Db`, `schema`, `migrate`, `MIGRATIONS_DIR`, `createTestDatabase` (Task 3); `meSchema`, `statusSchema`, `handleSchema` (Task 2).
- Produces:
  - `buildApp(config: Config, deps: { db: Db; sql: postgres.Sql; webRoot?: string; logger?: boolean | object }): Promise<FastifyInstance>`
  - `authOptions(p: { secret: string; baseURL: string; trustedOrigins: string[]; database: BetterAuthOptions["database"] }): BetterAuthOptions` (pure, imports no config)
  - `createAuth(config: Config, db: Db): Auth` and `type Auth = ReturnType<typeof createAuth>`
  - `requireUser` Fastify preHandler; `request.user: { id: string; email: string; name: string; handle: string }`
  - app decorations: `app.auth: Auth`, `app.config: Config`
  - Test helpers: `makeTestApp(opts?: { webRoot?: string }): Promise<{ app; config; close(): Promise<void> }>`, `signUp(app, input?: Partial<SignUpInput>): Promise<{ cookie: string; token: string; user: Me; input: SignUpInput }>`

- [ ] **Step 1: Install**

```bash
pnpm --filter @open-factory/server add fastify@latest better-auth@latest fastify-type-provider-zod@latest drizzle-orm@latest postgres@latest "@open-factory/shared@workspace:*" "@open-factory/db@workspace:*"
pnpm --filter @open-factory/server add -D pino-pretty@latest
npm view fastify version && npm view better-auth version && npm view fastify-type-provider-zod version
```
`drizzle-orm`, `postgres` and `zod` are direct server deps on purpose: the bundle keeps them external (spec §3). Accept pnpm's peer auto-install or warnings for `@fastify/swagger`/`openapi-types` (spec §14 note). Do not use them.

- [ ] **Step 2: Test helpers**

`apps/server/src/test/helpers.ts`:

```ts
import { createDb, migrate, MIGRATIONS_DIR } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { Me, SignUpInput } from "@open-factory/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";

export const TEST_ORIGIN = "http://localhost:3000";

export async function makeTestApp(opts: { webRoot?: string } = {}) {
  const tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const config = loadConfig({
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "t".repeat(40),
    PORT: "3000",
    LOG_LEVEL: "silent",
  });
  const { db, sql, close: closeDb } = createDb(tdb.url);
  const app = await buildApp(config, { db, sql, webRoot: opts.webRoot, logger: false });
  return {
    app,
    config,
    async close() {
      await app.close();
      await closeDb();
      await tdb.drop();
    },
  };
}

let n = 0;
export async function signUp(app: FastifyInstance, input: Partial<SignUpInput> = {}) {
  n += 1;
  const body: SignUpInput = {
    name: `User ${n}`,
    handle: `user-${n}-${Date.now() % 100000}`,
    email: `u${n}-${Date.now()}@example.com`,
    password: "password123",
    ...input,
  };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: TEST_ORIGIN },
    payload: body,
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed ${res.statusCode}: ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
    .map((c) => c.split(";")[0])
    .join("; ");
  const token = String(res.headers["set-auth-token"] ?? "");
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  return { cookie, token, user: me.json() as Me, input: body };
}
```

- [ ] **Step 3: Failing tests**

`apps/server/src/routes/status.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { FACTORY_VERSION } from "../version.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

test("GET /api/status is public and reports version + db", async () => {
  const res = await t.app.inject({ method: "GET", url: "/api/status" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ version: FACTORY_VERSION, db: "ok" });
});

test("unknown /api path is a JSON 404", async () => {
  const res = await t.app.inject({ method: "GET", url: "/api/nope" });
  expect(res.statusCode).toBe(404);
  expect(res.headers["content-type"]).toMatch(/application\/json/);
  expect(res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
});
```

`apps/server/src/auth/auth.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEST_ORIGIN, makeTestApp, signUp } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: "POST",
    url,
    headers: { origin: TEST_ORIGIN, ...headers },
    payload: payload as object,
  });

describe("sign-up and /api/me", () => {
  test("sign-up returns a session; /api/me works with cookie and with bearer", async () => {
    const { cookie, token, user, input } = await signUp(t.app, { handle: "alice", name: "Alice" });
    expect(user).toMatchObject({ handle: "alice", name: "Alice", email: input.email });
    expect(user.id).toEqual(expect.any(String));
    expect(token).not.toBe("");
    const viaBearer = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaBearer.statusCode).toBe(200);
    expect(viaBearer.json()).toEqual(user);
    const viaCookie = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(viaCookie.json()).toEqual(user);
  });

  test("/api/me without a session is 401 in the factory error shape", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "Not signed in" } });
  });

  test("a second user can sign up; duplicate handle is HANDLE_TAKEN; duplicate email rejected", async () => {
    const first = await signUp(t.app, { handle: "bob" });
    const dupHandle = await post("/api/auth/sign-up/email", {
      name: "B2",
      handle: "bob",
      email: "other@example.com",
      password: "password123",
    });
    expect(dupHandle.statusCode).toBe(422);
    expect(dupHandle.json()).toMatchObject({ code: "HANDLE_TAKEN" });
    const dupEmail = await post("/api/auth/sign-up/email", {
      name: "B3",
      handle: "bob-two",
      email: first.input.email,
      password: "password123",
    });
    expect(dupEmail.statusCode).toBeGreaterThanOrEqual(400);
    expect(dupEmail.json()).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
  });

  test.each(["Bob", "-x", "humans", "me", "scheduler", "a"])(
    "invalid or reserved handle %s is rejected",
    async (handle) => {
      const res = await post("/api/auth/sign-up/email", {
        name: "X",
        handle,
        email: `${handle}-${Date.now()}@example.com`,
        password: "password123",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    },
  );

  test("sign-out with bearer and {} body revokes the token", async () => {
    const { token } = await signUp(t.app);
    const out = await post("/api/auth/sign-out", {}, { authorization: `Bearer ${token}` });
    expect(out.statusCode).toBe(200);
    const me = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });
});
```
(The sign-out test sends an `origin` header through the helper. Sign-out without an Origin header is covered by Task 10's `cli.test.ts` logout case: Node fetch sends no Origin, and the test asserts `/api/me` → 401 afterwards.)

- [ ] **Step 4: Run, expect FAIL.**

- [ ] **Step 5: Implement**

`apps/server/src/auth/options.ts` (pure, so better-auth's schema generator can import it without env):

```ts
import { handleSchema } from "@open-factory/shared";
import { APIError, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";

export interface AuthOptionParams {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  database: BetterAuthOptions["database"];
  /** Returns true if the handle is already used. */
  handleExists?: (handle: string) => Promise<boolean>;
}

export function authOptions(p: AuthOptionParams) {
  return {
    secret: p.secret,
    baseURL: p.baseURL,
    basePath: "/api/auth",
    trustedOrigins: p.trustedOrigins,
    database: p.database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        handle: { type: "string", required: true, input: true, validator: { input: handleSchema } },
      },
    },
    plugins: [bearer()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || !p.handleExists) return;
        const handle = (ctx.body as { handle?: unknown } | undefined)?.handle;
        if (typeof handle === "string" && (await p.handleExists(handle))) {
          throw new APIError("UNPROCESSABLE_ENTITY", {
            code: "HANDLE_TAKEN",
            message: "That handle is already taken",
          });
        }
      }),
    },
  } satisfies BetterAuthOptions;
}
```
If the installed better-auth's `APIError` doesn't accept a custom `code` in the body, look up its documented way to return a custom error code (context7) and make the response body have `code: "HANDLE_TAKEN"`.

`apps/server/src/auth/auth.ts`:

```ts
import { type Db, schema } from "@open-factory/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import { authSecret } from "../crypto/keys.ts";
import { authOptions } from "./options.ts";

export function createAuth(config: Config, db: Db) {
  const trustedOrigins = [
    config.publicOrigin,
    ...(config.isProduction ? [] : [config.devWebOrigin]),
  ];
  return betterAuth(
    authOptions({
      secret: authSecret(config.secretKey),
      baseURL: config.publicUrl,
      trustedOrigins,
      database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
      handleExists: async (handle) =>
        (
          await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.handle, handle))
            .limit(1)
        ).length > 0,
    }),
  );
}
export type Auth = ReturnType<typeof createAuth>;
```

`apps/server/src/auth/require-user.ts`:

```ts
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface RequestUser {
  id: string;
  email: string;
  name: string;
  handle: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

/** The one session check: better-auth getSession handles both cookie and Authorization: Bearer. */
export async function getUser(request: FastifyRequest): Promise<RequestUser | null> {
  const session = await request.server.auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) return null;
  const u = session.user as { id: string; email: string; name: string; handle: string };
  return { id: u.id, email: u.email, name: u.name, handle: u.handle };
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getUser(request);
  if (!user) {
    return reply.code(401).send({ error: { code: "unauthorized", message: "Not signed in" } });
  }
  request.user = user;
}
```

`apps/server/src/errors.ts`:

```ts
import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export function registerErrorHandlers(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err) || err.validation) {
      return reply.code(400).send({ error: { code: "validation_error", message: err.message } });
    }
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) request.log.error({ err }, "unhandled error");
    return reply.code(status).send({
      error: {
        code: status === 500 ? "internal_error" : (err.code ?? "bad_request"),
        message: status === 500 ? "Internal error" : err.message,
      },
    });
  });
}

export const notFoundBody = { error: { code: "not_found", message: "Not found" } } as const;
```

`apps/server/src/routes/status.ts`:

```ts
import { statusSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type postgres from "postgres";
import { FACTORY_VERSION } from "../version.ts";

export const statusRoutes: FastifyPluginAsyncZod<{ sql: postgres.Sql }> = async (app, { sql }) => {
  app.get("/api/status", { schema: { response: { 200: statusSchema } } }, async () => {
    let db: "ok" | "error" = "ok";
    try {
      await sql`select 1`;
    } catch {
      db = "error";
    }
    return { version: FACTORY_VERSION, db };
  });
};
```

`apps/server/src/routes/me.ts`:

```ts
import { meSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/me",
    { preHandler: requireUser, schema: { response: { 200: meSchema } } },
    async (req) => req.user!,
  );
};
```

`apps/server/src/routes/auth.ts` (bridge to better-auth's Web handler):

```ts
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";

export async function authRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, app.config.publicUrl);
      const headers = fromNodeHeaders(request.headers);
      const hasBody = request.body !== undefined && request.body !== null;
      const req = new Request(url, {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
      });
      const res = await app.auth.handler(req);
      reply.status(res.status);
      const cookies = res.headers.getSetCookie();
      res.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
    },
  });
}
```

`apps/server/src/app.ts`:

```ts
import type { Db } from "@open-factory/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type postgres from "postgres";
import { type Auth, createAuth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import { notFoundBody, registerErrorHandlers } from "./errors.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";
import { statusRoutes } from "./routes/status.ts";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
    config: Config;
  }
}

export interface AppDeps {
  db: Db;
  sql: postgres.Sql;
  webRoot?: string;
  logger?: boolean | object;
}

export function loggerOptions(config: Config) {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "*.password",
        "password",
      ],
      censor: "[redacted]",
    },
    ...(config.isProduction ? {} : { transport: { target: "pino-pretty" } }),
  };
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? loggerOptions(config),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("config", config);
  app.decorate("auth", createAuth(config, deps.db));
  registerErrorHandlers(app);

  await app.register(statusRoutes, { sql: deps.sql });
  await app.register(authRoutes);
  await app.register(meRoutes);
  // Task 6 registers the WebSocket route here; Task 7 registers static serving here.

  app.setNotFoundHandler((request, reply) => reply.code(404).send(notFoundBody));
  return app;
}
```
Fastify's default logger does not log request bodies. Keep it that way.

- [ ] **Step 6: Run, expect PASS**: `pnpm vitest run apps/server`. If better-auth's codes differ from the ones asserted (`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, `VALIDATION_ERROR`), check the installed version's error codes and update **both** the test and the spec's §7.4 mapping in the same commit. Do not loosen the HANDLE_TAKEN assertion.

- [ ] **Step 7: Typecheck, lint, commit**: `feat(server): fastify app with status, better-auth (bearer, handle) and /api/me`

---

### Task 6: WebSocket skeleton

**Files:**

- Create: `apps/server/src/ws/{route.ts,ws.test.ts}`
- Modify: `apps/server/src/app.ts` (register the route)

**Interfaces:**

- Consumes: `getUser` (Task 5), `clientMessageSchema`, `ServerMessage` (Task 2), `app.config`.
- Produces: `wsRoutes(app)`. (No socket registry and no heartbeat in S1. Both are deferred to S3.)

- [ ] **Step 1: Install**: `pnpm --filter @open-factory/server add @fastify/websocket@latest && pnpm --filter @open-factory/server add -D ws@latest @types/ws@latest`

- [ ] **Step 2: Failing test** `apps/server/src/ws/ws.test.ts`:
```ts
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { TEST_ORIGIN, makeTestApp, signUp } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let session: Awaited<ReturnType<typeof signUp>>;
beforeAll(async () => {
  t = await makeTestApp();
  session = await signUp(t.app);
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/ws`;
});
afterAll(async () => {
  await t.close();
});

function open(headers: Record<string, string>) {
  return new Promise<{ ws: WebSocket; first: unknown }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("message", (d) => resolve({ ws, first: JSON.parse(String(d)) }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

test("cookie + matching origin: hello, then ping/pong, invalid message gets error", async () => {
  const { ws, first } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  expect(first).toEqual({ type: "hello", userId: session.user.id });
  const next = () =>
    new Promise<unknown>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ type: "ping" }));
  expect(await next()).toEqual({ type: "pong" });
  ws.send("not json");
  expect(await next()).toMatchObject({ type: "error", code: "bad_message" });
  ws.close();
});

test("bearer without origin is accepted", async () => {
  const { ws, first } = await open({ authorization: `Bearer ${session.token}` });
  expect(first).toMatchObject({ type: "hello" });
  ws.close();
});

test.each([
  ["no session", { origin: TEST_ORIGIN }],
  ["bad origin", { cookie: "", origin: "http://evil.example" }],
  ["no origin without bearer", { cookie: "" }],
])("rejects %s with 401", async (_name, headers) => {
  const h = { ...headers } as Record<string, string>;
  if ("cookie" in h) h.cookie = session.cookie;
  await expect(open(h)).rejects.toThrow("status 401");
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement**

`apps/server/src/ws/route.ts`:

```ts
import websocket from "@fastify/websocket";
import { clientMessageSchema, type ServerMessage } from "@open-factory/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUser } from "../auth/require-user.ts";

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).send({ error: { code: "unauthorized", message: "Not signed in" } });

export async function wsRoutes(app: FastifyInstance) {
  await app.register(websocket);
  const allowed = new Set([
    app.config.publicOrigin,
    ...(app.config.isProduction ? [] : [app.config.devWebOrigin]),
  ]);

  async function checkUpgrade(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return unauthorized(reply);
    if (origin === undefined && !/^Bearer\s+\S+/i.test(request.headers.authorization ?? ""))
      return unauthorized(reply);
    const user = await getUser(request);
    if (!user) return unauthorized(reply);
    request.user = user;
  }

  app.get("/api/ws", { websocket: true, preValidation: checkUpgrade }, (socket, request) => {
    const userId = request.user!.id;
    const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
    socket.on("message", (raw) => {
      let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
      try {
        parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)));
      } catch {
        return send({ type: "error", code: "bad_message", message: "Message is not valid JSON" });
      }
      if (!parsed.success)
        return send({ type: "error", code: "bad_message", message: "Unknown message" });
      if (parsed.data.type === "ping") send({ type: "pong" });
    });
    send({ type: "hello", userId });
  });
}
```
In `app.ts`, register `await app.register(wsRoutes);` after `meRoutes`, and remove that line from the Task 6 placeholder comment.

- [ ] **Step 5: Run, expect PASS**: `pnpm vitest run apps/server/src/ws` and the full server suite.

- [ ] **Step 6: Typecheck, lint, commit**: `feat(server): authenticated websocket skeleton with origin check`

---

### Task 7: Static SPA serving, boot entry, server bundle, root build

**Files:**

- Create: `apps/server/src/{static.ts,static.test.ts}`, `apps/server/build.mjs`, `scripts/build.mjs`
- Modify: `apps/server/src/index.ts`, `apps/server/src/app.ts`, `apps/server/package.json`

**Interfaces:**

- Consumes: `buildApp`, `loadConfig`, `ConfigError`, `migrate`, `createDb`.
- Produces: `registerStatic(app, webRoot: string | undefined)`; build outputs `apps/server/dist/index.js`, `apps/server/dist/migrations/`, `apps/server/dist/public/`; root `pnpm build` = `node scripts/build.mjs`; `apps/server` `dev` script.

- [ ] **Step 1: Install**: `pnpm --filter @open-factory/server add @fastify/static@latest`

- [ ] **Step 2: Failing test** `apps/server/src/static.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "./test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "of-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=app></div>");
  writeFileSync(path.join(dir, "app.js"), "console.log(1)");
  t = await makeTestApp({ webRoot: dir });
});
afterAll(async () => {
  await t.close();
});

test("serves files, falls back to index.html for app routes, keeps /api 404 as JSON", async () => {
  expect((await t.app.inject({ url: "/app.js" })).body).toBe("console.log(1)");
  const deep = await t.app.inject({ url: "/agents" });
  expect(deep.statusCode).toBe(200);
  expect(deep.headers["content-type"]).toMatch(/text\/html/);
  const api = await t.app.inject({ url: "/api/missing" });
  expect(api.statusCode).toBe(404);
  expect(api.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement**

`apps/server/src/static.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { notFoundBody } from "./errors.ts";

/** Serves the built SPA. Returns false (API-only) when the folder is missing. */
export async function registerStatic(
  app: FastifyInstance,
  webRoot: string | undefined,
): Promise<boolean> {
  if (!webRoot || !existsSync(path.join(webRoot, "index.html"))) {
    app.log.warn({ webRoot }, "web UI build not found; serving the API only");
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFoundBody));
    return false;
  }
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api"))
      return reply.sendFile("index.html");
    return reply.code(404).send(notFoundBody);
  });
  return true;
}
```
In `app.ts`, replace the trailing `app.setNotFoundHandler(...)` with `await registerStatic(app, deps.webRoot);`. In tests without `webRoot`, it logs nothing visible because the logger is off.

`apps/server/src/index.ts`:

```ts
import { fileURLToPath } from "node:url";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// esbuild defines __BUNDLED__ in build.mjs; it is undefined under tsx (pnpm dev).
declare const __BUNDLED__: boolean | undefined;
const bundled = typeof __BUNDLED__ !== "undefined" && __BUNDLED__;
// In the bundle, migrations and public/ sit next to index.js. From source, use the db package's folder.
const migrationsDir = bundled ? here("./migrations") : MIGRATIONS_DIR;
const webRoot = bundled ? here("./public") : undefined;

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  await migrate(config.databaseUrl, migrationsDir);
  const { db, sql, close } = createDb(config.databaseUrl);
  const app = await buildApp(config, { db, sql, webRoot });
  const shutdown = async () => {
    await app.close();
    await close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

`apps/server/build.mjs`:

```js
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
// Third-party deps stay external (resolved from apps/server/node_modules); workspace packages are bundled.
const external = Object.entries(pkg.dependencies ?? {})
  .filter(([, v]) => !String(v).startsWith("workspace:"))
  .flatMap(([name]) => [name, `${name}/*`]);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external,
  define: { __FACTORY_VERSION__: JSON.stringify(rootPkg.version), __BUNDLED__: "true" },
  sourcemap: true,
  logLevel: "info",
});
```
`apps/server/package.json` scripts:

```json
"scripts": {
  "build": "node build.mjs",
  "dev": "node --env-file-if-exists=../../.env --import tsx --watch src/index.ts"
}
```
(`version.ts` reads `../../../package.json` relative to `src/version.ts`, which resolves to the repo root when running from source. In the bundle, `define` wins and the read never runs.)

`scripts/build.mjs`:

```js
import { execSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
rmSync("apps/server/dist", { recursive: true, force: true });
run("pnpm --filter @open-factory/server build");
run("pnpm --filter @open-factory/cli build");
if (existsSync("apps/web/package.json")) run("pnpm --filter @open-factory/web build");
cpSync("packages/db/migrations", "apps/server/dist/migrations", { recursive: true });
if (existsSync("apps/web/dist"))
  cpSync("apps/web/dist", "apps/server/dist/public", { recursive: true });
```
(The CLI and web builds come in later tasks. Until Task 10, guard the CLI line the same way: `if (existsSync("apps/cli/build.mjs"))`.)

- [ ] **Step 5: Run tests, expect PASS**: `pnpm vitest run apps/server`

- [ ] **Step 6: Verify the bundle boots against real Postgres**

```bash
pnpm build
cp -n .env.example .env && sed -i.bak "s|^FACTORY_SECRET_KEY=.*|FACTORY_SECRET_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak
npm start &   # expect "web UI build not found; serving the API only" until Task 8
sleep 2 && curl -s localhost:3000/api/status && kill %1
```
Expected: `{"version":"0.1.0","db":"ok"}`. Then check the placeholder rejection: `FACTORY_SECRET_KEY=change-me-to-a-random-string-of-32-chars-or-more DATABASE_URL=x node apps/server/dist/index.js` exits 1 and prints the openssl hint. If the bundle fails with ERR_MODULE_NOT_FOUND, a db/shared runtime dep is missing from `apps/server` dependencies: add it.

- [ ] **Step 7: Lint, typecheck, commit**: `feat(server): boot entry, SPA serving, esbuild bundle and root build`

---

### Task 8: Web app shell — auth pages, guarded layout, empty screens, WS client

> **Refined by the UI design** (`docs/superpowers/designs/2026-11-18-s1-ui-design.md`, applied in a follow-up commit): the screens render a shared `PageHeader` (the dashboard is titled "Home") instead of their own `h1`, the auth pages drop the card, `connectWs` gains an optional `onStatus` callback that drives a reconnect strip, and the router gets pending, error (Retry) and not-found components. Where the code below differs, the design doc wins.

**Files:**

- Create: everything under `apps/web/` listed in File Structure, except `components/markdown/*` (Task 9)
- Modify: `vitest.config.ts` (re-add the `"apps/web"` project), `scripts/build.mjs` (unchanged if the guard is in place)

**Interfaces:**

- Consumes: `signUpSchema`, `handleSchema`, `serverMessageSchema` (Task 2); server routes `/api/auth/*`, `/api/me`, `/api/ws`.
- Produces: `authClient` (better-auth React client); `sessionQueryOptions` (TanStack Query options, key `["session"]`, returns the session or `null`); `connectWs(opts: { onUnauthenticated(): void }): { close(): void; status(): "connecting" | "open" | "closed" }`; `<EmptyState text>`; `mapAuthError(code: string): { field?: "name" | "handle" | "email" | "password"; message: string }`.

- [ ] **Step 1: Scaffold with latest versions**

```bash
mkdir -p apps/web && cd apps/web
pnpm init   # then set name "@open-factory/web", private, type module, version 0.1.0
pnpm add react@latest react-dom@latest @tanstack/react-router@latest @tanstack/react-query@latest better-auth@latest zod@latest "@open-factory/shared@workspace:*"
pnpm add -D vite@latest @vitejs/plugin-react@latest @tanstack/router-plugin@latest tailwindcss@latest @tailwindcss/vite@latest @types/react@latest @types/react-dom@latest jsdom@latest @testing-library/react@latest @testing-library/user-event@latest @testing-library/jest-dom@latest
npm view vite version && npm view @tanstack/react-router version && npm view tailwindcss version
```
Scripts: `"dev": "vite"`, `"build": "vite build"`.

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["es2024", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "@testing-library/jest-dom"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3000", ws: true, changeOrigin: false } },
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
```
`apps/web/src/test-setup.ts`: `import "@testing-library/jest-dom/vitest";`
Re-add `"apps/web"` to `projects` in the root `vitest.config.ts`.

Then initialize shadcn (`pnpm dlx shadcn@latest init` in `apps/web`, choosing the Vite + Tailwind 4 setup with alias `@`), and add the components: `pnpm dlx shadcn@latest add button input label card sidebar dropdown-menu tabs textarea`. The generated files live in `src/components/ui/` (excluded from Biome in Task 1). Dark mode follows the system through CSS only: in `src/styles.css`, put shadcn's dark tokens under `@media (prefers-color-scheme: dark) { :root { ... } }` instead of a `.dark` class, and point Tailwind's `dark:` variant at the same media query (`@custom-variant dark (@media (prefers-color-scheme: dark));`). No JS theme switching and no toggle.

- [ ] **Step 2: Auth client, session query, error mapping**

`apps/web/src/lib/auth-client.ts`:

```ts
import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [inferAdditionalFields({ user: { handle: { type: "string", required: true } } })],
});
```

`apps/web/src/lib/session.ts`:

```ts
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { authClient } from "./auth-client";

export const sessionQueryOptions = queryOptions({
  queryKey: ["session"],
  queryFn: async () => (await authClient.getSession()).data ?? null,
  staleTime: 60_000,
});

/** Call after sign-in, sign-up and sign-out, before navigating, so the route guard never sees a stale session. */
export async function refreshSession(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: ["session"] });
  return qc.fetchQuery(sessionQueryOptions);
}
```

`apps/web/src/components/auth-error.ts`:

```ts
type Field = "name" | "handle" | "email" | "password";
export function mapAuthError(
  code: string | undefined,
  message: string,
): { field?: Field; message: string } {
  switch (code) {
    case "HANDLE_TAKEN":
      return { field: "handle", message: "That handle is already taken." };
    case "VALIDATION_ERROR":
      return { field: "handle", message }; // handle is the only validated additional field (spec §7.4)
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return { field: "email", message: "An account with this email already exists." };
    case "PASSWORD_TOO_SHORT":
      return { field: "password", message: "Password must be at least 8 characters." };
    case "INVALID_EMAIL_OR_PASSWORD":
      return { message: "Wrong email or password." };
    default:
      return { message: message || "Something went wrong. Try again." };
  }
}
```
Test `apps/web/src/components/auth-error.test.ts`: assert each of the four codes maps to its field, and that an unknown code becomes a form-level message (no field).

- [ ] **Step 3: WS client (TDD)**

Failing test `apps/web/src/lib/ws.test.ts`, using a fake `WebSocket` class injected through an option:

```ts
import { expect, test, vi } from "vitest";
import { connectWs } from "./ws";

class FakeWs {
  static instances: FakeWs[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
}

test("on close with no session it calls onUnauthenticated and stops reconnecting", async () => {
  vi.useFakeTimers();
  const onUnauthenticated = vi.fn();
  connectWs({
    onUnauthenticated,
    hasSession: async () => false,
    WebSocketImpl: FakeWs as never,
    url: "ws://x/api/ws",
  });
  FakeWs.instances[0]!.onclose?.();
  await vi.runAllTimersAsync();
  expect(onUnauthenticated).toHaveBeenCalledOnce();
  expect(FakeWs.instances).toHaveLength(1);
  vi.useRealTimers();
});

test("on close with a session it reconnects with backoff", async () => {
  vi.useFakeTimers();
  FakeWs.instances = [];
  connectWs({
    onUnauthenticated: vi.fn(),
    hasSession: async () => true,
    WebSocketImpl: FakeWs as never,
    url: "ws://x/api/ws",
  });
  FakeWs.instances[0]!.onclose?.();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(FakeWs.instances.length).toBe(2);
  vi.useRealTimers();
});
```
Implement `apps/web/src/lib/ws.ts`:

```ts
import { type ServerMessage, serverMessageSchema } from "@open-factory/shared";

export interface WsOptions {
  onUnauthenticated(): void;
  hasSession(): Promise<boolean>;
  onMessage?(m: ServerMessage): void;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

/** One reconnecting socket per tab. A rejected upgrade (401) is indistinguishable from "server down"
 *  in browsers (close 1006), so every close re-checks the session. */
export function connectWs(opts: WsOptions) {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const url =
    opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
  let attempt = 0;
  let stopped = false;
  let state: "connecting" | "open" | "closed" = "connecting";
  let ws: WebSocket;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    state = "connecting";
    ws = new Impl(url);
    ws.onopen = () => {
      attempt = 0;
      state = "open";
    };
    ws.onmessage = (e) => {
      let data: unknown;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return; // ignore non-JSON frames
      }
      const parsed = serverMessageSchema.safeParse(data);
      if (parsed.success) opts.onMessage?.(parsed.data);
    };
    ws.onclose = async () => {
      state = "closed";
      if (stopped) return;
      if (!(await opts.hasSession())) {
        stopped = true;
        opts.onUnauthenticated();
        return;
      }
      const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      timer = setTimeout(open, delay);
    };
  };
  open();
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    },
    status: () => state,
  };
}
```
Run `pnpm vitest run apps/web`. The tests pass.

- [ ] **Step 4: Routes**

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const queryClient = new QueryClient();
const router = createRouter({ routeTree, context: { queryClient } });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```
`index.html`: a standard Vite html with `<div id="root"></div>`, `<script type="module" src="/src/main.tsx">` and `<title>Open Factory</title>`.

`src/routes/__root.tsx`: `createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: () => <Outlet /> })`.

`src/routes/_app.tsx` (pathless authenticated layout):

```tsx
import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { connectWs } from "@/lib/ws";
import { sessionQueryOptions } from "@/lib/session";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session) throw redirect({ to: "/sign-in" });
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const conn = connectWs({
      hasSession: async () => {
        await qc.invalidateQueries({ queryKey: ["session"] });
        return Boolean(await qc.fetchQuery(sessionQueryOptions));
      },
      onUnauthenticated: () => navigate({ to: "/sign-in" }),
    });
    return () => conn.close();
  }, [qc, navigate]);
  return (
    <SidebarProvider>
      <AppSidebar />
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
```

`src/components/app-sidebar.tsx`: shadcn `Sidebar` with `Link`s to `/inbox`, `/agents`, `/tasks`, `/templates`, `/schedules`, `/settings`, labeled exactly Inbox, Agents, Tasks, Templates, Schedules, Settings. The footer holds a `DropdownMenu` showing `session.user.name` and `@{session.user.handle}` (from `useSuspenseQuery(sessionQueryOptions)` or the `_app` route context), plus a "Sign out" item that runs `await authClient.signOut(); await refreshSession(qc); navigate({ to: "/sign-in" })`.

`src/components/empty-state.tsx`:

```tsx
export function EmptyState({ text }: { text: string }) {
  return <p className="text-muted-foreground text-sm">{text}</p>;
}
```

Screens, one file each. Pattern (`src/routes/_app/agents.tsx`):

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/_app/agents")({
  component: () => (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Agents</h1>
      <EmptyState text="No agents yet." />
    </section>
  ),
});
```
Write the same shape for `inbox.tsx` ("Inbox", "Nothing in your inbox."), `tasks.tsx` ("Tasks", "No tasks yet."), `templates.tsx` ("Templates", "No templates yet."), `schedules.tsx` ("Schedules", "No schedules yet."), `settings.tsx` ("Settings", "Nothing to configure yet."). `src/routes/_app/index.tsx` (`/`, the dashboard) renders two shadcn `Card`s titled "Inbox" and "Agents" with `<EmptyState text="Nothing in your inbox." />` and `<EmptyState text="No agents yet." />`.

`src/routes/sign-up.tsx`: in `beforeLoad`, `ensureQueryData(sessionQueryOptions)` and redirect to `/` if a session exists. The form has fields name, handle (onChange lowercases the value), email and password (type password). On submit:

```tsx
const parsed = signUpSchema.safeParse(values);
if (!parsed.success) { /* show parsed.error.issues per field (issue.path[0]) */ return; }
const { error } = await authClient.signUp.email(parsed.data);
if (error) { const m = mapAuthError(error.code, error.message ?? ""); /* set field or form error */ return; }
await refreshSession(qc);
navigate({ to: "/" });
```
It links to `/sign-in`. `src/routes/sign-in.tsx` follows the same pattern with email and password, calls `authClient.signIn.email`, maps errors, refreshes the session, navigates to `/`, and links to `/sign-up`.

- [ ] **Step 5: Generate and commit the route tree, then verify**

```bash
pnpm --filter @open-factory/web build          # generates src/routeTree.gen.ts and dist/
git add apps/web/src/routeTree.gen.ts
pnpm typecheck && pnpm lint && pnpm vitest run apps/web
pnpm build                                     # root build now copies web dist to apps/server/dist/public
```
Manual smoke check: run `npm start`, open http://localhost:3000. You're redirected to `/sign-in`. Sign up as `alice` and land on the dashboard with two empty panels. Each nav item shows its empty line. A duplicate handle shows "That handle is already taken." under the handle field. Sign out returns to `/sign-in`. In devtools, `/api/ws` is connected and received `hello`.

- [ ] **Step 6: Commit**: `feat(web): auth pages, guarded shell with empty screens, reconnecting ws client`

---

### Task 9: Markdown renderer and editor

> **Refined by the UI design** (§7): the wrapper class is `prose prose-sm prose-of max-w-none` (no `dark:prose-invert`), mermaid also gets `theme: "neutral"` on a light `.md-diagram` card, and the render error note reads "Couldn't render this diagram." followed by the parser message. Where the code below differs, the design doc wins.

**Files:**

- Create: `apps/web/src/components/markdown/{markdown.tsx,code-block.tsx,mermaid-block.tsx,markdown-editor.tsx,markdown.test.tsx,markdown-editor.test.tsx}`

**Interfaces:**

- Produces: `<Markdown source: string />`, `<MarkdownEditor value: string onChange(v: string) />`. Not mounted on any route (Q12).

- [ ] **Step 1: Install**: `pnpm --filter @open-factory/web add react-markdown@latest remark-gfm@latest shiki@latest mermaid@latest && pnpm --filter @open-factory/web add -D @tailwindcss/typography@latest`, then add `@plugin "@tailwindcss/typography";` to `src/styles.css`.

- [ ] **Step 2: Failing tests**

`markdown.test.tsx`:

````tsx
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Markdown } from "./markdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>' })),
  },
}));

test("renders GFM tables and task lists", () => {
  render(<Markdown source={"| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo"} />);
  expect(screen.getByRole("table")).toBeInTheDocument();
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).toBeChecked();
});

test("does not render raw HTML or scripts", () => {
  const { container } = render(<Markdown source={'<script>alert(1)</script><b id="x">bold</b>'} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("#x")).toBeNull();
});

test("external links open safely", () => {
  render(<Markdown source={"[x](https://example.com)"} />);
  const a = screen.getByRole("link", { name: "x" });
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
});

test("unlabeled fenced blocks render inside <pre>, inline code does not", () => {
  const { container } = render(<Markdown source={"Use `x` here.\n\n```\nplain block\n```"} />);
  const pre = container.querySelector("pre");
  expect(pre).toBeInTheDocument();
  expect(pre).toHaveTextContent("plain block");
  const inline = screen.getByText("x");
  expect(inline.tagName).toBe("CODE");
  expect(inline.closest("pre")).toBeNull();
});

test("highlights code blocks once shiki loads", async () => {
  const { container } = render(<Markdown source={"```ts\nconst a = 1;\n```"} />);
  expect(container.querySelector("pre")).toBeInTheDocument();
  await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument(), {
    timeout: 10_000,
  });
});

test("renders mermaid blocks with strict security", async () => {
  render(<Markdown source={"```mermaid\ngraph TD; A-->B\n```"} />);
  await waitFor(() => expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument());
  const mermaid = (await import("mermaid")).default;
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: "strict" }),
  );
});
````

`markdown-editor.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

function Harness() {
  const [v, setV] = useState("");
  return <MarkdownEditor value={v} onChange={setV} />;
}

test("write -> preview -> write keeps the text", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.type(screen.getByRole("textbox"), "# Hello");
  await user.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Write" }));
  expect(screen.getByRole("textbox")).toHaveValue("# Hello");
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement**

`markdown.tsx`:

```tsx
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";
import { MermaidBlock } from "./mermaid-block";

const components: Components = {
  a: ({ href, children }) => {
    const external = typeof href === "string" && /^https?:\/\//.test(href);
    return external ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <a href={href}>{children}</a>
    );
  },
  // Fenced blocks arrive as <pre><code>: `pre` owns block rendering, `code` stays inline-only.
  pre: ({ node }) => {
    const codeEl = node?.children[0];
    const props = codeEl && codeEl.type === "element" ? codeEl.properties : {};
    const classes = Array.isArray(props.className) ? props.className.map(String) : [];
    const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
    const text =
      codeEl && codeEl.type === "element"
        ? codeEl.children
            .map((c) => (c.type === "text" ? c.value : ""))
            .join("")
            .replace(/\n$/, "")
        : "";
    if (lang === "mermaid") return <MermaidBlock source={text} />;
    if (lang) return <CodeBlock code={text} lang={lang} />;
    return (
      <pre>
        <code>{text}</code>
      </pre>
    );
  },
  code: ({ className, children }) => <code className={className}>{children}</code>,
};

/** GFM markdown, no raw HTML (no rehype-raw), default URL sanitizing. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
```
(`prose` comes from `@tailwindcss/typography`, installed in Step 1.)

`code-block.tsx`:

```tsx
import { useEffect, useState } from "react";

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark" } }),
      )
      .then((h) => live && setHtml(h))
      .catch(() => {}); // unknown language: keep the plain block
    return () => {
      live = false;
    };
  }, [code, lang]);
  // Shiki output is generated from escaped code tokens, not user HTML.
  if (html) return <div dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
```
Shiki's dual-theme output switches through CSS, in line with the CSS-only dark mode. Add this to `src/styles.css`:

```css
@media (prefers-color-scheme: dark) {
  .shiki,
  .shiki span {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg) !important;
  }
}
```

`mermaid-block.tsx`:

```tsx
import { useEffect, useId, useState } from "react";

export function MermaidBlock({ source }: { source: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      try {
        const out = await mermaid.render(id, source);
        if (live) setSvg(out.svg);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Invalid diagram");
      }
    });
    return () => {
      live = false;
    };
  }, [id, source]);
  if (error)
    return (
      <div>
        <p className="text-destructive text-sm">Diagram error: {error}</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  // securityLevel "strict" makes mermaid sanitize its SVG output.
  if (svg) return <div dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <pre>
      <code>{source}</code>
    </pre>
  );
}
```

`markdown-editor.tsx`:

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";

export function MarkdownEditor({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <Tabs defaultValue="write">
      <TabsList>
        <TabsTrigger value="write">Write</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>
      <TabsContent value="write">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-40 font-mono"
        />
      </TabsContent>
      <TabsContent value="preview">
        <Markdown source={value} />
      </TabsContent>
    </Tabs>
  );
}
```
Biome flags `dangerouslySetInnerHTML`. Add a `// biome-ignore lint/security/noDangerouslySetInnerHtml: <reason>` comment on those two lines, with the reasons given in the code comments above.

- [ ] **Step 5: Run, expect PASS**: `pnpm vitest run apps/web && pnpm typecheck && pnpm lint`. If Shiki can't load in jsdom within the timeout, mock `shiki` in that one test to return `<pre class="shiki">` and note it. The real lazy load is covered by the build.

- [ ] **Step 6: Commit**: `feat(web): GFM markdown renderer and raw markdown editor`

---

### Task 10: `open-factory` CLI

**Files:**

- Create: `apps/cli/src/{config-store.ts,client.ts,prompt.ts,commands.ts,commands/help.ts,commands/login.ts,commands/logout.ts,commands/status.ts}`, `apps/cli/build.mjs`, tests `config-store.test.ts`, `cli.test.ts`
- Modify: `apps/cli/src/index.ts`, `apps/cli/package.json`, `scripts/build.mjs` (drop the CLI guard)

**Interfaces:**

- Consumes: `apiFetch`, `ApiError`, `meSchema`, `statusSchema` (Task 2); server routes.
- Produces:
  - `configPath(env): string`; `readConfig(env): Promise<CliConfig>`; `writeConfig(env, c: CliConfig): Promise<void>` where `CliConfig = { url?: string; token?: string }`
  - `resolveTarget(env, cfg): { url: string; token?: string }` (`OPEN_FACTORY_URL`/`OPEN_FACTORY_TOKEN` win, then the file, then `http://localhost:3000`)
  - `interface Io { out(s: string): void; err(s: string): void; ask(q: string, def?: string): Promise<string>; askHidden(q: string): Promise<string>; env: NodeJS.ProcessEnv; fetch: typeof fetch }`
  - `run(argv: string[], io: Io): Promise<number>` (exit code)
  - `CLI_VERSION`

- [ ] **Step 1: Package setup**: `pnpm --filter @open-factory/cli add "@open-factory/shared@workspace:*"`. Scripts: `"build": "node build.mjs"`. Add `"bin": { "open-factory": "./dist/open-factory.js" }`.

- [ ] **Step 2: Failing tests**

`apps/cli/src/config-store.test.ts`:

```ts
import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { configPath, readConfig, resolveTarget, writeConfig } from "./config-store.ts";

test("XDG path, 0600 file, 0700 dir, round trip", async () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "of-xdg-"));
  const env = { XDG_CONFIG_HOME: xdg };
  expect(configPath(env)).toBe(path.join(xdg, "open-factory", "cli.json"));
  expect(await readConfig(env)).toEqual({});
  await writeConfig(env, { url: "http://h:1", token: "t" });
  expect(await readConfig(env)).toEqual({ url: "http://h:1", token: "t" });
  expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(configPath(env))).mode & 0o777).toBe(0o700);
});

test("defaults to ~/.config without XDG_CONFIG_HOME", () => {
  expect(configPath({})).toBe(path.join(os.homedir(), ".config", "open-factory", "cli.json"));
});

test("env overrides win over the file", () => {
  expect(
    resolveTarget(
      { OPEN_FACTORY_URL: "http://e", OPEN_FACTORY_TOKEN: "et" },
      { url: "http://f", token: "ft" },
    ),
  ).toEqual({ url: "http://e", token: "et" });
  expect(resolveTarget({}, { url: "http://f/", token: "ft" })).toEqual({
    url: "http://f",
    token: "ft",
  });
  expect(resolveTarget({}, {})).toEqual({ url: "http://localhost:3000", token: undefined });
});
```

`apps/cli/src/cli.test.ts` (against a real test server):

```ts
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp, signUp } from "../../server/src/test/helpers.ts";
import { run } from "./commands.ts";
import { readConfig } from "./config-store.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let creds: { email: string; password: string; handle: string };
beforeAll(async () => {
  t = await makeTestApp();
  const s = await signUp(t.app, { handle: "cli-user" });
  creds = { email: s.input.email, password: s.input.password, handle: "cli-user" };
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await t.close();
});

function io(answers: string[] = [], extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { XDG_CONFIG_HOME: mkdtempSync(path.join(os.tmpdir(), "of-cli-")), ...extraEnv };
  return {
    out,
    err,
    env,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      ask: async (_q: string, def?: string) => answers.shift() || def || "",
      askHidden: async () => answers.shift() ?? "",
      env,
      fetch,
    },
  };
}

test("status before login: server version, not logged in, exit 0", async () => {
  const h = io([], { OPEN_FACTORY_URL: url });
  expect(await run(["status"], h.io)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toMatch(/^Server version: 0\.1\.0$/m);
  expect(text).toMatch(/^Database: ok$/m);
  expect(text).toMatch(/^CLI version: 0\.1\.0$/m);
  expect(text).toMatch(/^Not logged in$/m);
});

test("login -> status -> logout", async () => {
  const h = io([creds.email, creds.password]);
  expect(await run(["login", "--url", url], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("Logged in as @cli-user");
  const cfg = await readConfig(h.env);
  expect(cfg.url).toBe(url);
  expect(cfg.token).toBeTruthy();

  h.out.length = 0;
  expect(await run(["status"], h.io)).toBe(0);
  expect(h.out.join("\n")).toMatch(/^Logged in as @cli-user$/m);

  expect(await run(["logout"], h.io)).toBe(0);
  expect((await readConfig(h.env)).token).toBeUndefined();
  const me = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${cfg.token}` } });
  expect(me.status).toBe(401); // server session revoked
});

test("login with a wrong password fails with exit 1", async () => {
  const h = io([creds.email, "wrong-password"]);
  expect(await run(["login", "--url", url], h.io)).toBe(1);
  expect(h.err.join("\n")).toMatch(/Wrong email or password|INVALID_EMAIL_OR_PASSWORD/);
});

test("unreachable server: status exits 1 with a plain message; logout still clears the token", async () => {
  const h = io([], { OPEN_FACTORY_URL: "http://127.0.0.1:1" });
  expect(await run(["status"], h.io)).toBe(1);
  expect(h.err.join("\n")).toMatch(/Cannot reach server at http:\/\/127\.0\.0\.1:1/);
  expect(await run(["logout"], h.io)).toBe(0);
});

test("help and --version", async () => {
  const h = io();
  expect(await run([], h.io)).toBe(0);
  expect(h.out.join("\n")).toMatch(/login[\s\S]*logout[\s\S]*status/);
  h.out.length = 0;
  expect(await run(["--version"], h.io)).toBe(0);
  expect(h.out).toEqual(["0.1.0"]);
  expect(await run(["nope"], h.io)).toBe(1);
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement**

`apps/cli/src/config-store.ts`:

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  url?: string;
  token?: string;
}
type Env = Record<string, string | undefined>;

export const configPath = (env: Env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "open-factory", "cli.json");

export async function readConfig(env: Env): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(configPath(env), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(env: Env, c: CliConfig): Promise<void> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeFile(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export function resolveTarget(
  env: Env,
  cfg: CliConfig,
): { url: string; token: string | undefined } {
  return {
    url: (env.OPEN_FACTORY_URL || cfg.url || "http://localhost:3000").replace(/\/$/, ""),
    token: env.OPEN_FACTORY_TOKEN || cfg.token || undefined,
  };
}
```

`apps/cli/src/client.ts`:

```ts
import { ApiError } from "@open-factory/shared";

export class UnreachableError extends Error {}

/** Wraps fetch so network failures become UnreachableError (exit 1, plain message). */
export const guardedFetch =
  (f: typeof fetch, url: string): typeof fetch =>
  async (input, init) => {
    try {
      return await f(input, init);
    } catch {
      throw new UnreachableError(`Cannot reach server at ${url}`);
    }
  };

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;
```

`apps/cli/src/prompt.ts` (real terminal I/O; not unit-tested):

```ts
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export function ask(question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(def ? `${question} (${def}): ` : `${question}: `, (a) => {
      rl.close();
      resolve(a.trim() || def || "");
    }),
  );
}

export function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(`${question}: `, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
    muted = true;
  });
}
```

`apps/cli/src/commands.ts`:

```ts
import { readFileSync } from "node:fs";
import { help } from "./commands/help.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";
import { UnreachableError } from "./client.ts";

declare const __FACTORY_VERSION__: string | undefined;
// Injected by esbuild in the bundle (the readFileSync branch is then dead code); read from the root package.json from source.
export const CLI_VERSION: string =
  typeof __FACTORY_VERSION__ === "string"
    ? __FACTORY_VERSION__
    : (
        JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
          version: string;
        }
      ).version;

export interface Io {
  out(s: string): void;
  err(s: string): void;
  ask(q: string, def?: string): Promise<string>;
  askHidden(q: string): Promise<string>;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

export interface Command {
  name: string;
  summary: string;
  run(args: string[], io: Io): Promise<number>;
}

/** The command table: the seam for future commands. */
export const COMMANDS: Command[] = [
  {
    name: "login",
    summary: "Log in to a factory server: open-factory login [--url <url>]",
    run: login,
  },
  { name: "logout", summary: "Log out and forget the stored token", run: logout },
  { name: "status", summary: "Show server, version and login state", run: status },
  { name: "help", summary: "Show this help", run: async (_a, io) => help(io) },
];

export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--version" || name === "-v") {
    io.out(CLI_VERSION);
    return 0;
  }
  if (!name || name === "--help" || name === "-h") return help(io);
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    io.err(`Unknown command: ${name}\n`);
    help(io);
    return 1;
  }
  try {
    return await cmd.run(rest, io);
  } catch (e) {
    if (e instanceof UnreachableError) {
      io.err(e.message);
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
```
`apps/cli/src/commands/help.ts`:

```ts
import { COMMANDS, type Io } from "../commands.ts";

export function help(io: Io): number {
  io.out("Usage: of <command> [options]\n\nCommands:");
  for (const c of COMMANDS) io.out(`  ${c.name.padEnd(8)} ${c.summary}`);
  io.out("\nEnvironment: OPEN_FACTORY_URL, OPEN_FACTORY_TOKEN override the stored config.");
  return 0;
}
```

`apps/cli/src/commands/login.ts`:

```ts
import { parseArgs } from "node:util";
import { ApiError, apiFetch, meSchema } from "@open-factory/shared";
import { guardedFetch } from "../client.ts";
import type { Io } from "../commands.ts";
import { readConfig, resolveTarget, writeConfig } from "../config-store.ts";

export async function login(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { url: { type: "string" } } });
  const cfg = await readConfig(io.env);
  const url = (values.url ?? (await io.ask("Server URL", resolveTarget(io.env, cfg).url))).replace(
    /\/$/,
    "",
  );
  const email = await io.ask("Email");
  const password = await io.askHidden("Password");
  const f = guardedFetch(io.fetch, url);
  const res = await f(`${url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    io.err(
      body.code === "INVALID_EMAIL_OR_PASSWORD"
        ? "Wrong email or password."
        : `Login failed: ${body.message ?? res.status}`,
    );
    return 1;
  }
  const token = res.headers.get("set-auth-token");
  if (!token) {
    io.err("Login failed: server did not return a token.");
    return 1;
  }
  try {
    const me = await apiFetch("/api/me", { baseUrl: url, token, schema: meSchema, fetchImpl: f });
    await writeConfig(io.env, { url, token });
    io.out(`Logged in as @${me.handle}`);
    return 0;
  } catch (e) {
    io.err(e instanceof ApiError ? `Login failed: ${e.message}` : String(e));
    return 1;
  }
}
```

`apps/cli/src/commands/logout.ts`:

```ts
import { guardedFetch, UnreachableError } from "../client.ts";
import type { Io } from "../commands.ts";
import { readConfig, resolveTarget, writeConfig } from "../config-store.ts";

export async function logout(_args: string[], io: Io): Promise<number> {
  const cfg = await readConfig(io.env);
  const { url, token } = resolveTarget(io.env, cfg);
  if (token) {
    try {
      await guardedFetch(io.fetch, url)(`${url}/api/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}", // Fastify rejects an empty JSON body
      });
    } catch (e) {
      if (!(e instanceof UnreachableError)) throw e;
      io.err(`${e.message}; removed the local token anyway.`);
    }
  }
  await writeConfig(io.env, { url: cfg.url });
  io.out("Logged out");
  return 0;
}
```

`apps/cli/src/commands/status.ts`:

```ts
import { apiFetch, meSchema, statusSchema } from "@open-factory/shared";
import { guardedFetch, isUnauthorized } from "../client.ts";
import { CLI_VERSION, type Io } from "../commands.ts";
import { readConfig, resolveTarget } from "../config-store.ts";

export async function status(_args: string[], io: Io): Promise<number> {
  const { url, token } = resolveTarget(io.env, await readConfig(io.env));
  const fetchImpl = guardedFetch(io.fetch, url);
  const s = await apiFetch("/api/status", { baseUrl: url, schema: statusSchema, fetchImpl });
  io.out(`Server: ${url}`);
  io.out(`Server version: ${s.version}`);
  io.out(`Database: ${s.db}`);
  io.out(`CLI version: ${CLI_VERSION}`);
  if (!token) {
    io.out("Not logged in");
    return 0;
  }
  try {
    const me = await apiFetch("/api/me", { baseUrl: url, token, schema: meSchema, fetchImpl });
    io.out(`Logged in as @${me.handle}`);
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    io.out("Not logged in");
  }
  return 0;
}
```

`apps/cli/src/index.ts`:

```ts
import { run } from "./commands.ts";
import { ask, askHidden } from "./prompt.ts";

const code = await run(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  ask,
  askHidden,
  env: process.env,
  fetch,
});
process.exit(code);
```

`apps/cli/build.mjs`:

```js
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/open-factory.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  define: { __FACTORY_VERSION__: JSON.stringify(rootPkg.version) },
  logLevel: "info",
});
```
Remove the CLI guard in `scripts/build.mjs`.

- [ ] **Step 5: Run, expect PASS**: `pnpm vitest run apps/cli`. Then run the bundle by hand: `pnpm build && npm start &`, then `node apps/cli/dist/open-factory.js status` prints `Server version: 0.1.0`. Next, run `node apps/cli/dist/open-factory.js login` interactively, check that the password isn't echoed, then run `logout`.

- [ ] **Step 6: Typecheck, lint, commit**: `feat(cli): open-factory login/status/logout with XDG config and env overrides`

---

### Task 11: README, CI workflow and CLI smoke

**Files:**

- Create: `.github/workflows/ci.yml`, `scripts/smoke-cli.sh`
- Modify: `README.md`

**Interfaces:**

- Consumes: root scripts, built server and CLI.

- [ ] **Step 1: Smoke script** `scripts/smoke-cli.sh`:
```bash
#!/usr/bin/env bash
# Starts the built server, runs the built `open-factory status`, and checks the server version line.
set -euo pipefail
expected="$(node -p "require('./package.json').version")"
node apps/server/dist/index.js > /tmp/of-server.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${PORT:-3000}/api/status" > /dev/null && break
  sleep 0.5
done
out="$(OPEN_FACTORY_URL="http://127.0.0.1:${PORT:-3000}" node apps/cli/dist/open-factory.js status)"
echo "$out"
echo "$out" | grep -qx "Server version: ${expected}" || { echo "server version line mismatch"; cat /tmp/of-server.log; exit 1; }
```
Run `chmod +x scripts/smoke-cli.sh`, then test it locally with `.env` loaded: `set -a; . ./.env; set +a; pnpm build && scripts/smoke-cli.sh`.

- [ ] **Step 2: CI** `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_USER: factory
          POSTGRES_PASSWORD: factory
          POSTGRES_DB: factory
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U factory"
          --health-interval 2s --health-timeout 5s --health-retries 20
    env:
      DATABASE_URL: postgres://factory:factory@localhost:5432/factory
      FACTORY_SECRET_KEY: ci-only-secret-key-that-is-long-enough-123
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint:ci
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - name: CLI smoke
        run: scripts/smoke-cli.sh
```
Use the latest major tags of the actions (check each action's README). `pnpm/action-setup` reads `packageManager` from `package.json`.

- [ ] **Step 3: README** (replace the current one-line file). Sections:
  1. What it is: one line plus a link to the spec.
  2. Prerequisites: Node 24, pnpm via `corepack enable`, Docker (for Postgres).
  3. Quickstart, verbatim:

     ```
     docker compose -f docker-compose.dev.yml up -d
     cp .env.example .env   # set FACTORY_SECRET_KEY: openssl rand -base64 32
     pnpm install && pnpm build && npm start
     ```

     Then open http://localhost:3000 and sign up. `npm start` never builds. Run `pnpm build` again after pulling.
  4. Configuration: the env table from spec §4.
  5. Running on a server: set `HOST=0.0.0.0` **and** `PUBLIC_URL=https://your.host`, put TLS in front, and open the app at exactly `PUBLIC_URL` (`localhost` ≠ `127.0.0.1`). Sign-up is open in this version (see #1).
  6. Secret key: `FACTORY_SECRET_KEY` derives the session-signing key and the future secret-encryption key. Rotating it signs everyone out and requires re-encrypting stored secrets.
  7. Development: `pnpm dev` (server on :3000, Vite on :5173 with proxy; open :5173), `pnpm test` (needs the compose Postgres), `pnpm typecheck`, `pnpm lint` / `lint:fix`, `pnpm db:generate` after schema changes.
  8. CLI: `node apps/cli/dist/open-factory.js login|status|logout|help`, the config path, and `OPEN_FACTORY_URL`/`OPEN_FACTORY_TOKEN`.
  9. Limitations: no password reset (#2).

- [ ] **Step 4: Verify everything locally the way CI does**: `pnpm install --frozen-lockfile && pnpm lint:ci && pnpm typecheck && pnpm test && pnpm build && scripts/smoke-cli.sh`

- [ ] **Step 5: Commit, then push only if authorized**: commit `ci: github actions workflow with cli smoke; docs: readme quickstart`. Push the branch and open a PR to `main` **only if the team lead has authorized it for this workflow**; then confirm CI is green with `gh pr checks --watch`. Otherwise stop at the locally green run from Step 4 and hand off.

---

### Task 12: Manual acceptance check (recorded in the PR)

**Files:** none (PR description only).

- [ ] **Step 1: Fresh-clone run.** In a new temp dir: `git clone <repo> && cd open-factory && git checkout <impl-branch>`, then do exactly the README quickstart with a clean Postgres volume (`docker compose -f docker-compose.dev.yml down -v` first).
- [ ] **Step 2: Walk the ACs (spec §2) and note each result:**
  1. Open http://localhost:3000. Sign up as `alice`. You land on the dashboard with empty Inbox and Agents panels.
  2. In a private window, sign up as `bob` with a different email. Same app, no role differences.
  3. Sign up again with handle `alice`: a handle-field error. With alice's email: an email-field error. With handle `humans`: rejected.
  4. CI on the PR is green (link the run).
  5. `node apps/cli/dist/open-factory.js status` shows the server version and "Not logged in". `login` as alice, then `status` shows "Logged in as @alice". `logout`, then `status` shows "Not logged in".
  6. Every nav item shows its empty-state line. Sign out returns to `/sign-in`. Visiting `/agents` while signed out redirects to `/sign-in`.
- [ ] **Step 3:** Paste the checklist with ✅/❌ and any notes into the PR description under "Manual acceptance check". Mention that roadmap AC1 wording differs (install + build + `.env` step, decision Q5 in #3) and that the local `docs/product/roadmap/v0.0.1/s01-foundation.md` should be updated to match (the product docs are not tracked in git).
