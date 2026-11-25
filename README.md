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

Then open http://localhost:3000 and sign up: the first person to sign up needs no invite and bootstraps the factory (see "Users and invites"). `npm start` never builds. Run `pnpm build` again after pulling.

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
| `FACTORY_HOST_CLAUDE_DIR` | no | `~/.claude` | the Claude folder on this machine; host skills are read from its `skills/` subfolder (named in a template's `skills:` list), and a leading `~` is expanded |
| `FACTORY_ALLOW_LOCAL_RUNTIME` | no | `false` | `true` lets agents with `runtime: local` start; see "Local runtime" |
| `FACTORY_DEFAULT_IMAGE` | no | `ghcr.io/orlevii/open-factory/base:latest` | container image for Docker agents whose template names none |
| `FACTORY_DOCKER_CLAUDE_BIN` | no | `claude` | path to Claude Code inside the container image |
| `FACTORY_CLI_BUNDLE` | no | `apps/cli/dist/open-factory.js` in the repo | the bundled CLI mounted into containers |
| `FACTORY_AGENT_PORT` | no | `PORT + 1` | port of the agent listener, the separate surface agents call (see "Agent listener") |
| `FACTORY_AGENT_HOST` | no | loopback, plus the Docker bridge gateway on Linux | comma-separated IP addresses the agent listener binds; replaces the default list. The only way to bind `0.0.0.0` or `::` |
| `FACTORY_AGENT_URL` | no | `http://host.docker.internal:${FACTORY_AGENT_PORT}` | how containers reach the agent listener (`OPEN_FACTORY_URL` in the container). Local agents always use `http://127.0.0.1:${FACTORY_AGENT_PORT}` |

The max running agents, the default warm window and the member update debounce are set in the app under Settings → Factory, not in the environment. `FACTORY_MAX_RUNNING_AGENTS` and `FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS` are no longer read; the server logs a warning at boot when either is still set.

## Run an agent

1. Start Postgres and the server: `docker compose -f docker-compose.dev.yml up -d`, then `pnpm dev` (or the Quickstart above), and sign up (the first sign-up bootstraps the factory; later ones need an invite). Docker must be running on the machine that runs the server.
2. In **Settings**, add a credential: Credentials → Add credential → Sign in with Claude (needs python3 on the server); pasting a token still works. Agents never use your own `~/.claude` login; each runs with its own config dir under `FACTORY_HOME`, with the credential you pick for it.
3. Optional: register a project (a git repo on this machine) so agents can be granted access to it.
4. Create a template, in the UI or as a folder under `~/open-factory/templates/<name>/` (see "Templates"). `runtime` defaults to `docker`.
5. Create an agent from the template, pick its credential, and send it a message.

An agent that is idle is hibernated: its process is stopped (a Docker agent's container is stopped, not removed), and the next message wakes it with the same session. An agent stays warm for its template's warm window (`warm_window_minutes`; a template that omits it uses the factory default warm window, Settings → Factory, 70 unless changed) after it becomes idle, and it never hibernates while it is mid-turn, has a background task running or has a cron of its own scheduled.

## Docker runtime

Docker is the default runtime for new templates. Each agent gets one container, created on its first wake, stopped when it hibernates and started again on the next wake. Claude Code runs inside it as a non-root `agent` user, with only the agent's working directory, the projects it was granted and its skills mounted. Files the agent writes in a granted repo are owned by your host user.

- **Image.** A template's `image:` wins, otherwise `FACTORY_DEFAULT_IMAGE` (`ghcr.io/orlevii/open-factory/base:latest`, see the [base image](images/base/README.md)). The factory runs images, it never builds them: the value is any Docker reference, used as written (a bare name such as `playwright` is a local Docker tag). For development, build the image locally and set `FACTORY_DEFAULT_IMAGE=open-factory-base:dev`.
- **Pulls are explicit.** The factory pulls an image only when it is missing locally, once per image reference, when an agent wakes. It never updates a tag that is already present; pull a newer image yourself when you want one. While it pulls, the agent shows as queued ("Pulling the image..."). An image that is missing and can't be pulled fails the start: "Image `<ref>` isn't available locally and couldn't be pulled."
- **No sudo.** Containers run with `no-new-privileges`, so `agent` cannot become root. If an agent needs system packages, build your own image `FROM` the base image with `docker build`, and set it as the template's `image:`.
- **Re-creation wipes `/home/agent`.** The container is removed and re-created on a wake when its grants (mounts) or its image changed. Shell history, `gh` login state, `known_hosts` and caches in `/home/agent` are lost. Keep credentials in secrets, and the working directory is never affected.
- **Reaching the factory.** Containers call the factory's agent listener at `FACTORY_AGENT_URL` (`http://host.docker.internal:<agent port>` by default). See "Agent listener" for Linux, compose, rootless Docker and firewalls.
- **CLI bundle.** The bundled CLI is mounted into containers, so run `pnpm build` first; a Docker agent will not start without it.

`pnpm smoke:docker` is a live check, not part of `pnpm test`: it runs a real Claude in a real container (build the image as `open-factory-base:dev` first) and needs an OAuth token in `~/.open-factory-spike/oauth-token`.

## Agent listener

Agents don't use the human API. They message each other and the humans through the factory MCP (`send_message`, `list_peers`), served on a second, minimal HTTP surface, the agent listener: only `/mcp` and `/api/status`, no cookies, no browser routes. Each agent process gets its own token (`OPEN_FACTORY_AGENT_TOKEN`), valid only while that process runs; a request without a valid token gets `401`, and one carrying an `Origin` header (a browser) gets `403`.

- **Port.** `FACTORY_AGENT_PORT`, `PORT + 1` by default (`3001`).
- **Bind list.** By default `127.0.0.1`, plus, when the server runs on Linux and Docker is reachable, the Docker bridge gateway (for example `172.17.0.1`): the address `host.docker.internal` resolves to in a default-bridge container. The default list never contains `0.0.0.0`. Docker Desktop (macOS, Windows) routes `host.docker.internal` to the host's loopback, so loopback alone works there. Only loopback and the bridge subnet may connect; anything else is closed before a byte is read.
- **Who can reach it.** Other containers on the default bridge can reach the agent listener, not only agents. The per-process token protects it: without a live agent token a request gets `401` and `/api/status` returns only the version.
- **When the gateway can't be used.** The factory binds the gateway Docker reports even while `docker0` has no carrier (no container attached yet, the usual state at boot). When that address is not local to the factory (Docker Desktop for Linux, rootless Docker, a remote `DOCKER_HOST`, the factory itself in a container), or Docker reports no private gateway, the factory logs one warning and stays on loopback. A custom `host-gateway-ip` is not detected: `host.docker.internal` then resolves to an address the factory doesn't listen on. In these cases set `FACTORY_AGENT_HOST` to the address `host.docker.internal` resolves to in your containers. With **rootless Docker** the bridge lives in Docker's own network namespace, so that address is not on a host interface: set `FACTORY_AGENT_HOST` and `FACTORY_AGENT_URL` to an address both sides share. `FACTORY_AGENT_HOST=0.0.0.0` binds every interface; the token is then the only protection and the boot says so. While the local runtime is allowed, `FACTORY_AGENT_HOST` must include `127.0.0.1` (or `0.0.0.0`): local agents call the factory there.
- **The factory in a container.** Not supported yet. Agent containers always run on Docker's default bridge, so they can only reach the factory at an address the default bridge can reach. If you run the factory in a container anyway, publish its agent port and set `FACTORY_AGENT_URL` to that published port as the bridge sees it, for example `FACTORY_AGENT_URL=http://host.docker.internal:<published port>`.
- **Host firewalls.** A firewall that drops traffic from `docker0` blocks agents (their MCP connection fails, so they can't message anyone; the session may say the factory tools didn't connect). With ufw: `ufw allow in on docker0 to any port <agent port>`.
- **Upgrading from an earlier version.** `FACTORY_AGENT_URL` used to point at the human port. If you set it explicitly (for example `http://host.docker.internal:3000`), move it to the agent port (`http://host.docker.internal:3001`) or unset it: the factory logs a warning at boot when its port equals `PORT`, and Docker agents can't reach the factory tools until it is fixed.

`pnpm smoke:messaging` is a live check, not part of `pnpm test`: real Claude (haiku) agents `lead`, `ada` and `bob` with humans `or` and `sam` exercise agent-to-agent messages with a wake, batched member updates, an urgent interrupt, `list_peers` and a message to `@humans`. It runs Docker agents on `open-factory-base:dev` (run `pnpm build` first); `pnpm smoke:messaging --local` runs them on the host instead. It needs Postgres and an OAuth token in `~/.open-factory-spike/oauth-token`, and uses a throwaway database and `FACTORY_HOME`.

## Local runtime

`runtime: local` runs Claude Code directly on your machine as you, with no sandbox, in auto permission mode. It is an opt-in: set `FACTORY_ALLOW_LOCAL_RUNTIME=true`. While it is off, local agents show why instead of starting, and the template validator warns about `runtime: local`. Only the person who runs the server can change it; no API or UI session can.

- `HOME` is yours, so your host git config and credential helpers apply (only the commit name and email are the agent's).
- Push over HTTPS with a token: add it as a secret named `GH_TOKEN` in Settings and grant it in the template. `SSH_AUTH_SOCK` is not passed to agents, so SSH remotes won't authenticate.
- Set `FACTORY_CLAUDE_BIN` if `claude` isn't on your PATH.

## Running agents and the cap

The max running agents setting (Settings → Factory, default 8) limits how many agent processes run at once, warm idle ones included. An agent that wakes while every slot is taken waits in a first-in, first-out queue and shows as queued. To free a slot sooner, the factory hibernates the least recently active idle agent early, before its warm window ends. Agents that are mid-turn, have background tasks or have crons are never chosen.

**Rate limits.** When Claude reports that a credential's limit is rejected, the factory pauses that credential until the reported reset time (30 minutes if none is reported). Agents on it keep their messages queued, and idle ones hibernate. At the reset, an agent that was cut off mid-turn gets a notice from `@factory` that the limit reset, ahead of any pending messages.

**Crashes.** If an agent's process dies with work in flight (an open turn, a background task or a cron), the factory tries one automatic resume, started with a notice from `@factory` that says what was lost. If that fails, or the process was idle, nothing retries on its own: the agent shows as errored and a human acts. If the factory itself restarts while an agent was working, the agent resumes the same way on the next boot.

**Restart and Start a new session.** On an errored agent, **Restart** makes one more attempt with the same session (the agent gets a notice that you restarted it). If the session can't be resumed ("No conversation found"), use **Start a new session** instead (`POST /api/agents/<slug>/reset-session`): pending notices are dropped, and your pending messages become the first turn of a fresh Claude session. The old session file stays on disk. Restart is not offered while the local runtime is disabled for a local agent.

## Templates

A template is a folder under `${FACTORY_HOME}/templates/<name>/`:

```
template.yaml     name, display_name, description, runtime, image, model, skills, projects
AGENTS.md         the persona
settings.json     optional, Claude Code settings (permissions, env, ...)
mcp.json          optional, MCP servers
skills/<name>/    optional, skills only agents from this template have (SKILL.md)
files/            optional, copied into the agent's working directory
```

Template settings apply as written: templates are authored by the factory's operators. The factory owns `permissions.defaultMode`, keeps Claude's default `autoMode` rules (`$defaults`, so autoMode lists extend the defaults and can't replace them), appends granted project paths to `additionalDirectories`, and writes `claudeMdExcludes`.

## Spawning

An agent can spawn a fresh agent for one piece of work with `spawn_agent` (template, optional suffix, description, brief) and end it with `terminate_agent`. The call returns at once. The spawned agent reports to its spawner, gets the brief as its first message, and its text reaches the spawner as updates. It is named `<template>-<suffix>` (four random letters when no suffix is given), and slugs are never reused.

- **Who can spawn.** Only persistent agents whose template lists `can_spawn` (the templates they may spawn from). Only those agents get the two tools. Spawned agents can't spawn, can't be edited and can't be anyone's manager. A spawner with live spawned agents can't be archived until they are terminated.
- **Inheritance.** A spawned agent never holds anything its spawner lacks. It uses its spawner's credential; it gets the projects its template asks for that the spawner is granted, and the secrets its template asks for that the spawner also has; its deny rules are its template's plus its spawner's. A spawner in Docker can't spawn a local agent, an `auto` spawner can't spawn a `bypass` one, and no local agent is spawned while the local runtime is off. When a spawner's credential or project grants change, its live spawned agents follow (and restart). `spawn_agent` returns a `note` naming whatever was not passed on. MCP servers, skills, the image and the model come from the spawned agent's own template.
- **TTL.** A spawned agent with no activity for 3 days (no turn ended, no process started, nothing delivered) is terminated by the factory. Only an agent with no running process and no queued wake is terminated; one waiting on a rate-limit reset is skipped. This is a fixed rule that counts wall-clock time: after the factory has been down or asleep for 3 days or more, idle spawned agents are terminated on the first sweep (every 10 minutes, and once at boot).
- **Terminate.** The spawner, a human (**Terminate** in the UI, `POST /api/agents/<slug>/terminate`) or the TTL ends a spawned agent from any state: its process stops, its container is removed, its pending messages are rejected and its session becomes read-only. Persistent agents are archived, not terminated.
- **Workspace grace and pinning.** A terminated agent's working directory (its files and Claude session files) is deleted 3 days after it was terminated, another fixed wall-clock rule. Its session stays readable in the UI. **Pin** on a terminated agent (`PUT /api/agents/<slug>/workspace-pin`, `DELETE` to unpin) keeps the working directory until you unpin it; unpinning after the 3 days deletes it at the next sweep.
- **Worktrees and branches spawned agents make are never deleted.** They are repo state and may hold unpushed work: clean them up yourself.
- **Ended agents.** The agent list hides archived and terminated agents; `GET /api/agents?ended=only` lists them (`ended=exclude` is the default). This replaces the earlier `archived=` query.

`pnpm smoke:spawning` is a live check, not part of `pnpm test`. A real Claude (haiku) lead spawns an agent, hears its reply and terminates it. Then it runs the full scenario: it spawns a tech lead and a proxy reviewer, who message each other and write `plan.md` into a temp git repo; it terminates both and spawns a developer, who commits on a branch in its own worktree. It runs Docker agents on `open-factory-base:dev` (run `pnpm build` first); `pnpm smoke:spawning --local` runs them on the host instead. It needs Postgres and an OAuth token in `~/.open-factory-spike/oauth-token`, and uses a throwaway database and `FACTORY_HOME`.

## Running on a server

Set `HOST=0.0.0.0` **and** `PUBLIC_URL=https://your.host`, put TLS in front, and open the app at exactly `PUBLIC_URL` (`localhost` is not `127.0.0.1`). Also set `NODE_ENV=production`: development logging uses `pino-pretty` (a devDependency), and `NODE_ENV` also gates trust of `DEV_WEB_ORIGIN`.

### Users and invites

The first person to sign up needs no invite; after that, sign-up needs an invite link from Settings → Users (7-day, single use). Disable a user in Settings → Users to sign them out everywhere.

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
