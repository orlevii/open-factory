# Open Factory

Self-hosted workspace where people and agents build software together. Design: [S1 foundation spec](docs/superpowers/specs/2026-11-18-s1-foundation-design.md).

Agent containers use the [base image](images/base/README.md) (`ghcr.io/orlevii/open-factory/base`).

## Prerequisites

- Node 24
- pnpm via `corepack enable`
- Docker (for Postgres)

## Quickstart

```
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env   # set FACTORY_SECRET_KEY: openssl rand -base64 32
pnpm install && pnpm build && npm start
```

Then open http://localhost:3000 and sign up. `npm start` never builds. Run `pnpm build` again after pulling.

## Configuration

Environment variables (`npm start` loads `.env` if present):

| Var                  | Required | Default                    | Notes                                                                                                                                        |
| -------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | none                       | Postgres URL                                                                                                                                 |
| `FACTORY_SECRET_KEY` | yes      | none                       | min 32 chars; root key, see "Secret key". The placeholder from `.env.example` is rejected; generate one with `openssl rand -base64 32`       |
| `FACTORY_HOME`       | no       | `~/open-factory`           | leading `~` expanded, resolved to an absolute path. Not created in this version                                                              |
| `PUBLIC_URL`         | no       | `http://localhost:${PORT}` | http(s) URL; its origin is the better-auth base URL and trusted origin. Open the app at exactly this origin (`127.0.0.1` is not `localhost`) |
| `DEV_WEB_ORIGIN`     | no       | `http://localhost:5173`    | Vite dev server origin, trusted only when `NODE_ENV` is not `production`                                                                     |
| `PORT`               | no       | `3000`                     |                                                                                                                                              |
| `HOST`               | no       | `127.0.0.1`                | fail-closed default; servers set `HOST=0.0.0.0` explicitly                                                                                   |
| `LOG_LEVEL`          | no       | `info`                     | pino level                                                                                                                                   |
| `NODE_ENV`           | no       | none                       | `production` disables pretty logs and the dev origin allowance                                                                               |
| `CLAUDE_CODE_OAUTH_TOKEN` | no | none | Claude Code OAuth token (`claude setup-token`). Optional for boot, required to start an agent. Never logged                                       |
| `FACTORY_CLAUDE_BIN` | no       | `claude`                   | path to the `claude` executable agents run                                                                                                   |
| `FACTORY_DEV_MODEL`  | no       | none                       | model for the dev agent (e.g. `haiku`); a stopgap until templates exist                                                                      |

## Run the dev agent (S3 walking skeleton)

1. Get a Claude Code OAuth token: `claude setup-token`, and put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`.
   Agents never use your own `~/.claude` login; each runs with its own config dir under `FACTORY_HOME`.
2. `pnpm seed:dev-agent` (creates the `dev` agent and `~/open-factory/agents/dev/`).
3. `pnpm dev`, sign in, open **Agents -> Dev agent** and send a message.

The dev agent runs on the **local runtime, unsandboxed**: Claude Code runs directly on your machine in
auto permission mode. Optional: `FACTORY_DEV_MODEL=haiku` (a stopgap until templates exist),
`FACTORY_CLAUDE_BIN` if `claude` isn't on your PATH. If the agent's session is lost
("No conversation found"), stop the server and run `pnpm seed:dev-agent --reset-session`.

## Running on a server

Set `HOST=0.0.0.0` **and** `PUBLIC_URL=https://your.host`, put TLS in front, and open the app at exactly `PUBLIC_URL` (`localhost` is not `127.0.0.1`). Also set `NODE_ENV=production`: development logging uses `pino-pretty` (a devDependency), and `NODE_ENV` also gates trust of `DEV_WEB_ORIGIN`. Sign-up is open in this version (see #1).

Behind a reverse proxy, login rate limiting and session IP addresses see the proxy's IP, not the client's: the server uses the socket address and ignores any `X-Forwarded-For` the client sends. All clients behind the proxy then share one rate-limit bucket. This stays the case until a trust-proxy setting exists.

## Secret key

`FACTORY_SECRET_KEY` derives the session-signing key and the future secret-encryption key. Rotating it signs everyone out and requires re-encrypting stored secrets.

## Development

- `pnpm dev`: server on :3000, Vite on :5173 with a proxy. Open :5173.
- `pnpm test`: needs the compose Postgres.
- `pnpm typecheck`
- `pnpm lint` / `pnpm lint:fix`
- `pnpm db:generate` after schema changes.

## CLI

```
node apps/cli/dist/open-factory.js login|status|logout|help
```

Config lives at `${XDG_CONFIG_HOME:-~/.config}/open-factory/cli.json` (mode 0600). `OPEN_FACTORY_URL` and `OPEN_FACTORY_TOKEN` override the file.

`login` must use the server's exact `PUBLIC_URL` origin (`localhost` is not `127.0.0.1`): the CLI sends that origin to satisfy better-auth's origin checks.

## Limitations

- No password reset (#2).
