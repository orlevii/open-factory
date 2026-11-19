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
| `FACTORY_CLAUDE_BIN` | no       | `claude`                   | path to the `claude` executable agents run                                                                                                   |
| `FACTORY_HOST_SKILLS_DIR` | no | `~/.claude/skills` | where host skills named in a template's `skills:` list are read from; a leading `~` is expanded |

## Run an agent

1. Start Postgres and the server: `docker compose -f docker-compose.dev.yml up -d`, then `pnpm dev` (or the Quickstart above), and sign up.
2. In **Settings**, add a credential: run `claude setup-token` and paste the token. Agents never use your own `~/.claude` login; each runs with its own config dir under `FACTORY_HOME`, with the credential you pick for it.
3. Optional: register a project (a git repo on this machine) so agents can be granted access to it.
4. Create a template, in the UI or as a folder under `~/open-factory/templates/<name>/` with `runtime: local` in `template.yaml` (see "Templates").
5. Create an agent from the template, pick its credential, and send it a message.

The local runtime is **unsandboxed**: Claude Code runs directly on your machine as you, in auto permission mode.

- `HOME` is yours, so your host git config and credential helpers apply (only the commit name and email are the agent's).
- Push over HTTPS with a token: add it as a secret named `GH_TOKEN` in Settings and grant it in the template. `SSH_AUTH_SOCK` is not passed to agents, so SSH remotes won't authenticate.
- Set `FACTORY_CLAUDE_BIN` if `claude` isn't on your PATH.

If an agent's session can't be resumed ("No conversation found"), use **Start a new session** on the agent (`POST /api/agents/<slug>/reset-session`): its pending messages become the first turn of a fresh Claude session.

## Templates

A template is a folder under `${FACTORY_HOME}/templates/<name>/`:

```
template.yaml     name, display_name, description, runtime, model, skills, projects
AGENTS.md         the persona
settings.json     optional, Claude Code settings (permissions, env, ...)
mcp.json          optional, MCP servers
skills/<name>/    optional, skills only agents from this template have (SKILL.md)
files/            optional, copied into the agent's working directory
```

Template settings apply as written: templates are authored by the factory's operators. The factory owns `permissions.defaultMode`, keeps Claude's default `autoMode` rules (`$defaults`, so autoMode lists extend the defaults and can't replace them), appends granted project paths to `additionalDirectories`, and writes `claudeMdExcludes`.

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
