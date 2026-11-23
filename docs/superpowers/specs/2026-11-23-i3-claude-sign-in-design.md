# I3 Sign in with Claude: Technical Design

- **Date:** 2026-11-23
- **Status:** draft, before review. The owner-proxy (owner-i3) answered Q1–Q13. For Or (certainty 3 or a deviation from the task spec or an ADR): **Q1** (host only, no container path; amends ADR 0027), **Q5** (no expiry field for pasted tokens; drops "unless the user enters it"), **Q8** (a flat three-way choice instead of "I already have a token"), **Q9** (global cap of 3).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/roadmap/v0.0.2/i3-claude-sign-in.md` (the task), `roadmap/v0.0.2/scope.md`, `roadmap/v0.0.2/index.md`, `decisions/0027-claude-sign-in.md`, `decisions/0010-config-dir-and-credentials.md`, `decisions/0028-pre-release-no-compatibility.md`, `concepts/credential.md`, `behavior/administration.md`, `behavior/inbox.md`, `architecture/base-image.md`, `architecture/agent-runtime.md`, `ui-review/decisions.md`.
- **Builds on:** `spec/i2-agent-config` (I4's `useFieldErrors`, `FieldNote`, `FormOutcome`, `useOutcome` and the `MSG`/`FIELD_MSG`/`FORM_MSG` constants are merged below it; I1 changes the Inbox to chat rows plus `items`).
- **Reference implementation read (not copied):** Paperclip `packages/adapters/claude-local/src/server/setup-token-{parse,runner}.ts` and `server/src/services/local-ai-browser-login.ts` (MIT), read through `gh api` on 2026-11-23. Behaviour is ported; the code is our own.
- **Decision log:** GitHub issue "I3: Sign in with Claude — design". Q1–Q13 are the proxy's answers; D1–D16 are tech-lead decisions (§13).

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Web paths are relative to `apps/web/src/`, server paths to `apps/server/src/`, unless they start with `apps/` or `packages/`.

## 1. Goal

Adding a Claude credential takes a click, a sign-in in the user's own browser and a paste, instead of "open a terminal, run `claude setup-token`, copy a secret". The factory runs `claude setup-token` itself in a pseudo-terminal, shows the sign-in URL, writes the pasted code back, reads the one-year token the CLI prints, verifies it with today's verification turn and stores it as today's `oauth_token` credential. Expiry is tracked: the credential knows when a signed-in token runs out, the Inbox says so 14 days ahead, and **Sign in again** replaces the token in place.

### 1.1 Deviations from the task spec and ADR 0027 (owner-proxy approved, for Or)

- **Host only (Q1, certainty 3).** The task and ADR 0027 say "inside a throwaway base-image container when Docker is available, otherwise the host". This design runs `claude setup-token` on the host only, through a python3 PTY bridge. Reasons: credential verification (`credentials/verify.ts`) already runs the **host** `claude` (`FACTORY_CLAUDE_BIN`) for every add, replace and re-verify, so a host `claude` is already required; the token belongs to the account, not to a CLI build, so "the same `claude` the agents use" buys nothing; two transports double the cleanup paths. ADR 0027 gets a one-line amendment (§12).
- **No expiry date for pasted tokens (Q5, certainty 3).** The task says pasted tokens have an unknown expiry "unless the user enters it". There is no such field: a hand-typed date produces wrong notices. Pasted tokens show "Expiry unknown" and never notify.
- **A flat three-way choice (Q8, certainty 3).** The task's "**I already have a token** keeps today's paste field" reads as a link inside the sign-in panel. This design makes the form's Kind a three-way choice, "Sign in with Claude" (default), "Paste a token", "API key", so every path is visible and nothing is nested.

## 2. Acceptance criteria

Default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked. Server tests that need Postgres run only in CI (the local Postgres role is unavailable).

1. **Sign in creates a credential.** On a factory with no credential, Add credential → Sign in with Claude → Start sign-in shows the URL; submitting a Name and the code creates an `oauth_token` credential that verified, with `expires_at` = mint time + 365 days; an agent created with it starts. (Server: runner + attempt tests against the fake CLI, CI. Browser: the evidence pass with the fake `claude setup-token`. Manual: Or's real sign-in, §11.3.)
2. **Reload.** Reloading mid-attempt (Add credential sheet or Settings) shows the same URL and the code field; a reload while the code is being exchanged shows "Signing in…" and then the same outcome as the original request (§5.4). (Attempt-store unit tests; evidence pass.)
3. **Expiry of an attempt.** 10 minutes after Start the process is killed, its temp dir removed, and the panel shows "Sign-in timed out. Start again." (unit tests with an injected clock; evidence pass with a short TTL).
4. **Cancel.** Cancel (and closing the sheet with Discard, and a new Start) kills the process (the bridge's whole process group) and removes its temp dir (unit tests on the bridge and the store; a CI test that no child survives).
5. **No secrets leave the attempt.** No URL, code or token appears in server logs, events, the database (beyond the encrypted credential value), error responses or process argv. Checked by a test that runs a full attempt against the fake CLI with a capturing logger and asserts the synthetic URL, code and token strings never appear in the log output, any response body other than `GET`/`POST start` (which carry the URL to its owner only), or the spawn arguments; and by the fixed-message rule (§6.3).
6. **Isolation.** Every attempt route acts on the caller's own attempt, found by the session's user id; another user's attempt is never reachable (route tests: a second user's GET sees none, their cancel and code are 404 `sign_in_not_found`).
7. **Parser fails closed.** The prompt and token parsers pass every case in §7.3 (synthetic fixture until Or records the real one, then both).
8. **Expiry notice.** A credential whose `expires_at` is within 14 days produces exactly one `@factory` Inbox item per user (two concurrent checks, a boot check and an hourly check never double it); its pane offers Sign in again; Sign in again replaces the token, keeps the credential's id, name and assignments, sets a new `expires_at` and re-arms the notice (CI DB tests; evidence pass for the pane).
9. **Row states.** The credential row shows "Expires about 12 Nov 2027", "Expires in 9 days" (warning), "Expired 12 Nov 2027" (crimson) or "Expiry unknown" from `expires_at` and now; Sign in again is a visible ghost button only when rejected, within 14 days or expired, and always in the ⋯ menu for OAuth credentials (component tests; evidence pass).
10. **Fallbacks.** Without `python3` on the host, Start sign-in answers "Sign-in needs python3 on the server." and the form keeps Paste a token and API key working (route test with a missing interpreter; component test).
11. **Form rules.** Every new message is at most 40 characters, a constant in `FIELD_MSG`/`FORM_MSG`/`MSG`, never interpolated; every new field reserves its note line; the form outcome sits on I4's `FormOutcome` line (I4's length and template-literal tests cover the new constants).

## 3. Scope

**In:** the PTY bridge (`pty-bridge.py`), the setup-token parsers and runner, the host transport, the attempt store and its routes; `credentials.expires_at`, `expiry_notified_at`, `rejected_at`; replace-in-place from a sign-in; the expiry check and its Inbox item (`messages.subject_credential_id`, inbox kind `credential`); the Add credential form's three-way choice and sign-in panel; the Sign in again sheet; the credential row's expiry line and Sign in again button; the Inbox row and pane for the notice; the fake CLI's `setup-token` mode; product docs (§12).

**Out:** our own OAuth client; refresh tokens; non-Claude providers; a container transport (Q1); an expiry field for pasted tokens (Q5); marking a credential rejected from an agent's failed turn (Q6, follow-up issue); I8's first-run step and desktop notification (I8 builds on §8 and §9).

**Breaking (ADR 0028):** `credentials` gains three columns and `messages` one, generated migration only, no backfill: existing OAuth credentials have `expires_at` null ("Expiry unknown") until they are signed in again. `CredentialSummary` gains `expiresAt` and `rejected`; `lastError` is unchanged. `INBOX_KINDS` gains `credential`, and the inbox item's `link` union gains `{ kind: "credential", name }`. `CredentialService.create` and `replace` take an `expiresAt`. Existing local data needs no reset.

## 4. Inventory (what exists today)

| Piece | Where | Today |
|---|---|---|
| Credential model | `packages/db/src/schema/factory.ts` `credentials` | `id`, `name` (unique), `kind` (`oauth_token` \| `api_key`), `value_enc` (vault, AAD `credentials:<id>`), `last_verified_at`, `last_error`, rate-limit columns, timestamps |
| Service | `credentials/credential-service.ts` | `list`, `create` (name pre-check, verify, insert), `replace` (verify, update in place, `requestRestart` each active user), `reverify` (writes `last_error` text), `remove` |
| Verification | `credentials/verify.ts` | One haiku turn through the **host** `claude` (`config.claudeBin`), env exactly `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` (mkdtemp) and the credential var; fixed messages only; 60 s timeout |
| Routes | `routes/credentials.ts` | `GET/POST /api/credentials`, `PUT /:name/value`, `POST /:name/verify`, `DELETE /:name`; `requireUser` on every route |
| Logging | `app.ts` `loggerOptions` | pino redact paths for auth headers, `*.value`, `*.token`, `*.env`, the two credential env vars |
| Add credential form | `features/settings/forms/add-credential-form.tsx` | Name, Kind (OAuth token / API key radios), `TokenField`; `useFieldErrors` + `useOutcome` (I4); frames `inline` (Settings) and `sheet` (stacked over New/Edit agent via `setup-sheets.tsx`) |
| Credential row | `features/settings/credentials-section.tsx` | Name, kind, `VerificationState` ("Verified 3 days ago" / "Last check failed: …"), rate-limit line, usage; Verify button; ⋯ with Replace token and Delete; inline `ReplaceForm` |
| Inbox items | `inbox_items.kind` `message \| mention \| task_event`; `messages` `kind = 'system'` with `notice` and `subject_agent_id` (`@factory` facts); `EventStore.createHumanMessage` fans out to every user; `bus.publishToUser(…, inbox_changed)` | `link` is `session` or `task` |
| Periodic work | `spawning/reaper.ts`, `uploads/sweep.ts` | In-memory `setInterval` classes started after boot, stopped at shutdown |
| PTY | none | Node has no PTY API. `node-pty` would be a native build dependency. The base image has python3 and `claude`, but this design doesn't use the image (Q1) |
| Host tools | dev machine | `python3` 3.12, `claude` 2.1.327; `claude setup-token --help` prints only `-h` |
| Fake CLI | `packages/harness/testing/fake-claude.mjs`; the U4 harness wraps it as `FACTORY_CLAUDE_BIN` | No `setup-token` mode |

No new npm dependency: the PTY is python3's standard-library `pty`.

## 5. Server

### 5.1 The PTY bridge (`credentials/sign-in/pty-bridge.py`)

A fixed Python file in the repo, inlined into the server bundle with esbuild's text loader (`loader: { ".py": "text" }` in `apps/server/build.mjs`; vitest gets the same through a tiny plugin or `?raw` import) and run as:

```
python3 -I -S -c <PTY_BRIDGE> <claudeBin> setup-token
```

`-I` (isolated: no user site, no `PYTHON*` env, no script dir on the path) and `-S` (no `site`) so nothing from the host's Python setup is imported. argv carries only the fixed script, the configured `claude` path and the literal `setup-token`; no user input ever reaches argv (Q1, D2). `claudeBin` comes only from server config (`FACTORY_CLAUDE_BIN` or its default), never from a request, and the spawn takes an argument array with no shell.

The script:
1. `pid, fd = pty.fork()`; the child `os.execvp(argv[1], argv[1:])` (env inherited from the bridge, which already holds only the allow-list, §5.2); `os._exit(127)` if exec fails.
2. Sets the window to 200 columns × 50 rows with `TIOCSWINSZ` (a zero-size PTY makes Ink wrap every character; 200 is what Paperclip characterized).
3. Puts the child in its own process group (`pty.fork` already makes it a session leader) so a kill takes the CLI and anything it spawned.
4. Loops on `select([fd, 0])`: bytes from stdin go to the PTY master; bytes from the master go to stdout. EOF on stdin (the server closed it), `SIGTERM` or `SIGHUP` → `os.killpg(pid, SIGKILL)` and exit 1. `EIO` on the master (the child closed the terminal) ends the loop.
5. `waitpid` and exits with the child's exit code.

Nothing is written to stderr except Python's own crash traceback, which the server discards unread (§6.3).

### 5.2 Host transport (`credentials/sign-in/host-pty.ts`)

```ts
interface PtyRun {
  onData(cb: (chunk: string) => void): void; // UTF-8 decoded with a streaming TextDecoder
  write(s: string): void;
  kill(): void;                               // idempotent; closes stdin, then SIGTERM, SIGKILL after 2 s
  readonly exit: Promise<{ code: number | null }>;
}
function startHostPty(d: { claudeBin: string; python: string }): Promise<PtyRun & { dir: string }>
```

- **Temp dir:** `mkdtemp(join(tmpdir(), "of-sign-in-"))`, mode 0700, used as both `HOME` and `CLAUDE_CONFIG_DIR`, removed (`rm -rf`) on every exit path: success, failure, cancel, TTL, a new Start, and server shutdown (§5.4). Boot removes `of-sign-in-*` dirs older than 15 minutes (a crashed server's leftovers; the margin leaves a second factory on the same host alone).
- **Environment: an allow-list, never `process.env`** (Q1): `PATH` and `LANG` from the server env (when set), `TERM=xterm-256color`, `HOME` and `CLAUDE_CONFIG_DIR` = the temp dir, `BROWSER=true` (the CLI's "open the browser" becomes a no-op), and `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` set to the empty string so nothing upstream can leak in. `DATABASE_URL`, `FACTORY_SECRET_KEY` and every factory secret are absent by construction. A unit test asserts the exact spawn options (argv, env keys and values, `detached`, stdio).
- **Spawn:** `spawn(python, ["-I", "-S", "-c", PTY_BRIDGE, claudeBin, "setup-token"], { env, stdio: ["pipe", "pipe", "pipe"] })`. `python` is `python3` resolved on the allow-listed `PATH`. A spawn `ENOENT` for python3 maps to `sign_in_unavailable` ("Sign-in needs python3 on the server."); the interpreter is probed once per process lifetime with `python3 -I -S -c "import pty"` so the panel can say so before Start (`available: false` in `GET`, §5.5).
- **stderr** is drained and dropped (`resume()`), never buffered or logged.

The runner (§5.3) talks only to `PtyRun`, so tests drive it with an in-memory fake and the fake CLI drives the real bridge.

### 5.3 Parsers and runner (`credentials/sign-in/setup-token.ts`)

Ported behaviour from Paperclip, written fresh, pure and fully unit-tested.

**`stripTerminal(text)`:** replaces each OSC 8 hyperlink with its URI; drops other OSC sequences; turns horizontal cursor moves (`CSI … G`, `CSI … C`) into one space (Ink lays words out by column); drops every other CSI sequence; normalises `\r\n` and bare `\r` to `\n`.

**`parsePrompt(buffer) → { url } | null`:**
- After the preamble line matching `/the url below to sign in/i`, the first line within 512 characters that starts with `https://claude.ai/` or `https://claude.com/` begins the URL. Consecutive URL-character-only lines (at most 16, at most 2,048 characters) are joined until the joined string validates (the CLI may hard-wrap it).
- **Validation (fail closed):** exact lowercase origin and path, one of `https://claude.ai/oauth/authorize` and `https://claude.com/cai/oauth/authorize`; `https:`, no userinfo, no port, no fragment; each of `client_id`, `code`, `code_challenge`, `code_challenge_method` (= `S256`), `redirect_uri`, `response_type` (= `code`), `scope`, `state` exactly once with its value pattern; `redirect_uri` decodes to exactly `https://platform.claude.com/oauth/code/callback` with no query, port or fragment; at most 4 extra keys, each a short lowercase name with a printable value; `sk-ant-` in the raw URL or any decoded key or value rejects it.
- The first non-blank line after the URL block, skipping repeats of the URL and the "Hold Shift while selecting…" copy hint, must be `Paste code here if prompted` (optionally followed by `>`, `*` and spaces). Otherwise null.

**`parseToken(buffer) → string | null`:** the line `Your OAuth token (valid for 1 year):` and the line `Store this token securely. You won't be able to see it again.` must each appear exactly once, in that order; every non-blank line between them must match `^[A-Za-z0-9_-]+$`; their concatenation must match `^sk-ant-oat01-[A-Za-z0-9_-]{20,}$`. Anything else is null.

**`hasOAuthError(buffer)`:** `/OAuth\s+error\s*:/` after stripping.

**Runner** (`runSetupToken(pty, { signal, settleMs = 150 })`), a small state machine:

| State | On | Next |
|---|---|---|
| `starting` | `parsePrompt` matches (buffer kept to the last 64 KB) | `awaiting_code`, buffer dropped, resolves `prompt` with the URL |
| `starting` | exit, 30 s without a prompt, or abort | `failed: start_failed` |
| `awaiting_code` | `submit(code)` | write `code`; wait `settleMs`; write `"\r"` as its own write (Ink folds a glued CR into the paste); drop the code; `exchanging` |
| `exchanging` | `parseToken` matches (token buffer kept to the last 64 KB) | `minted`, buffer dropped; resolves `token` |
| `exchanging` | `hasOAuthError`, exit without a token, 60 s, or abort | `failed: code_rejected` (OAuth error) or `failed: exchange_failed` |

After the code is written, **anything other than a token that parses strictly between the anchors ends the attempt** with a fixed reason (Q12). The runner never retries inside a run. It kills the PTY on every terminal state. It never logs, throws or returns CLI text: its results are the validated URL, the token, or one of the fixed reasons.

### 5.4 Attempt store (`credentials/sign-in/attempts.ts`)

In memory, one `SignInAttempts` instance per server.

```ts
type Purpose = { kind: "create" } | { kind: "replace"; credentialId: string; name: string };
type AttemptView =
  | { state: "awaiting_code"; url: string; expiresAt: string; purpose: "create" | "replace"; name?: string }
  | { state: "exchanging"; expiresAt: string; purpose: "create" | "replace"; name?: string };
```

- **Keyed by the session's user id** (Q9). Every operation takes the caller's user id and acts on that user's attempt; there is no attempt id in any request. Another user's attempt is invisible: `GET` returns `{ attempt: null }`, code and cancel get 404 `sign_in_not_found` ("No sign-in in progress.").
- **One per user:** `start(userId, purpose)` cancels the caller's existing attempt first (kill, rm), then starts a new one.
- **Global cap:** at most 3 attempts in `starting`, `awaiting_code` or `exchanging` at once; the 4th `start` is 429 `sign_in_busy` ("Too many sign-ins. Try again shortly."). The cap counts after the caller's own old attempt is cancelled.
- **TTL:** 10 minutes from `start` (`SIGN_IN_TTL_MS`, injectable for tests and the evidence pass). The timer kills the process, removes the dir and drops the attempt; a later `GET` shows nothing and a code submit gets 410 `sign_in_expired` ("Sign-in timed out. Start again."). An attempt in `exchanging` when the TTL fires is still killed: the exchange step has its own 60 s bound, which normally ends first.
- **`start`** resolves when the runner reaches `awaiting_code` (the URL validated) or fails: on failure the process is killed, the dir removed, and the route answers 502 `sign_in_start_failed` ("Couldn't start sign-in. Try again."). A URL that didn't validate is never shown (Q10).
- **`submit(userId, { code, name? })`:** only in `awaiting_code` (otherwise 409 `sign_in_state`, "Sign-in is already finishing."). For `create`, the name is validated **before** the code is written (Q3): `nameSchema` and the uniqueness pre-check; a failure is 400 `validation_error` `{ fields: { name } }` or 409 `credential_exists`, and the attempt stays in `awaiting_code`, so the single-use code is not burned. Then the attempt becomes `exchanging` and one promise (`outcome`) carries the rest:
  1. the runner writes the code and waits for the token;
  2. the token is verified with today's `CredentialVerifier` (one retry after 3 s on `unreachable`, Q13);
  3. `create` calls `credentials.create({ name, kind: "oauth_token", value: token, expiresAt: mintedAt + 365 days })`; `replace` calls `credentials.replace(name, token, { expiresAt })` (same id, assignments kept, active users restart when idle, `expiry_notified_at` and `rejected_at` cleared);
  4. the attempt is dropped, the process (already exited) reaped and the dir removed.
  The outcome is `{ ok: true, credential: CredentialSummary }` or `{ ok: false, code, message }` with a fixed message. A name taken between the pre-check and the insert (a race) fails with `credential_exists` and drops the token; this is the one case where a name error burns the sign-in, and it needs two people naming two credentials alike within seconds.
- **Reload during the exchange (Q2):** `GET` while `exchanging` returns `{ state: "exchanging" }`, and the client then calls `POST /code/wait`, which awaits the same `outcome` promise (bounded at 90 s) and answers exactly as the original submit did. The outcome is kept for 60 s after it settles, so a reload that lands just after the result still gets it once; then it's dropped.
- **Client gone mid-submit:** the outcome promise is owned by the store, not by the request, so a closed connection doesn't cancel the save; the credentials list shows the new credential on the next fetch.
- **Cancel** (`cancel(userId)`): kills the process group, removes the dir, drops the attempt. Idempotent. Cancel during `exchanging` is refused (409 `sign_in_state`): the code is already spent and the save is about to land.
- **Shutdown:** `closeAll()` is a shutdown step (before the database closes): kill every process, remove every dir.
- **Token lifetime:** the token exists only as a local in the outcome function, passed to the verifier and to `create`/`replace`, then unreachable; it is never on the attempt object, never returned, never logged. (JavaScript strings can't be zeroed; holding it in one async scope is what we can do.) The code is dropped from the attempt as soon as it is written.

### 5.5 Routes (`routes/sign-in.ts`, all `requireUser`)

| Route | Body | Answer |
|---|---|---|
| `GET /api/credentials/sign-in` | — | `{ available: boolean, attempt: AttemptView \| null }` |
| `POST /api/credentials/sign-in` | `{ replace?: name }` | 200 `{ attempt }` (`awaiting_code`, with `url`); 404 `credential_not_found` for an unknown name, 400 `validation_error` when `replace` names an `api_key` credential; 429 `sign_in_busy`; 502 `sign_in_start_failed`; 503 `sign_in_unavailable` |
| `POST /api/credentials/sign-in/code` | `{ code, name? }` | 201 `{ credential }` (create) or 200 `{ credential }` (replace); 400 `validation_error` (`code`, `name`); 409 `credential_exists`, `sign_in_state`; 410 `sign_in_expired`; 404 `sign_in_not_found`; 422 `sign_in_code_rejected`, `credential_rejected`; 502 `sign_in_failed`, `credential_unverifiable` |
| `POST /api/credentials/sign-in/code/wait` | — | the same answers as `/code`, for the attempt now `exchanging` (or just settled); 404 when there is none |
| `DELETE /api/credentials/sign-in` | — | 204; 409 `sign_in_state` while exchanging |

- **`code`** is trimmed, every whitespace character removed (a pasted code can carry a newline that would submit early), then must be 1–512 characters of printable ASCII with no control characters; else 400 "Paste the code from the sign-in page.". It travels only in this POST body, never a URL or query (Q2).
- The URL is returned only to its owner, only in `GET` and `POST /sign-in`.
- `name` on a `replace` attempt is ignored.

### 5.6 Schema and service changes

- `credentials`: `expires_at timestamptz null`, `expiry_notified_at timestamptz null`, `rejected_at timestamptz null`.
- `CredentialService.create({ name, kind, value, expiresAt })`; the paste route passes `expiresAt: null`. `replace(name, value, { expiresAt })` sets `expires_at` to the given value (null for a paste), and clears `expiry_notified_at`, `rejected_at` and `last_error`.
- `reverify`: a `rejected` verdict sets `rejected_at = now()` (and `last_error` as today); `ok` clears both; `unreachable` changes neither (Q6).
- `CredentialSummary` gains `expiresAt: string | null` and `rejected: boolean` (`rejected_at` not null). Display states are derived in the web from these and now, never stored (Q11).
- `messages.subject_credential_id text null references credentials(id) on delete cascade` (the notice disappears with its credential; its inbox items cascade from the message). The `messages_sender_kind_check` stays valid: a `system` row already allows any subject. `createHumanMessage` accepts `subjectCredentialId` and requires a subject agent **or** a subject credential for `system` rows.
- `inbox_items.kind` gains `credential`; shared `INBOX_KINDS` too.

### 5.7 Expiry check (`credentials/expiry-check.ts`)

An in-memory interval, hourly, plus once after boot reconciliation, stopped at shutdown (the `uploads/sweep.ts` shape; no pg-boss). Each run:

1. Selects credentials with `expires_at is not null and expires_at <= now() + 14 days and expiry_notified_at is null`.
2. For each, one transaction: `update credentials set expiry_notified_at = now() where id = $1 and expiry_notified_at is null returning id`; when a row comes back, `createHumanMessage({ kind: "system", notice: "credential_expiring", subjectCredentialId, to: "all", inboxKind: "credential", body, urgent: false }, tx)`. A second run, a boot race or two servers can't double it (Q4).
3. After commit, `publishToUser(userId, { type: "inbox_changed" })` for each addressee.

`body` (plain text, the preview and the pane's text): `"<name> expires on <date>. Sign in again to keep its agents working."` for a future date, `"<name> expired on <date>. Sign in again to get its agents working."` when the check finds it already past (a factory that was off). The date is `YYYY-MM-DD` in the factory time zone (`FACTORY_TIMEZONE`). No token material. Users who sign up later don't get it (as `@humans` fan-out).

Replacing the token (Sign in again or Replace token) nulls `expiry_notified_at`, so the next token gets its own notice in a year.

### 5.8 Inbox item shape

`inboxItemSchema` gains `credential?: { name: string; expiresAt: string | null; current: boolean }` (`current`: false once the token was replaced after the notice, i.e. `expiry_notified_at` is null or later than the message) and `link` gains `{ kind: "credential", name }`. `from` is `{ kind: "factory", name: "factory" }`. The inbox query left-joins `credentials` on `subject_credential_id`. I1's `GET /api/inbox` returns these in `items` (they are never chat rows).

## 6. Security

### 6.1 What holds a secret, and for how long

| Secret | Where it exists | Gone when |
|---|---|---|
| Sign-in URL (PKCE challenge, state) | PTY output buffer until parsed; the attempt object; the owner's `GET`/`POST start` responses; the owner's browser | The attempt ends; the panel unmounts |
| Code | One POST body; one local in `submit`; the PTY | Written to the PTY, then dropped |
| Token | PTY output buffer until parsed; one local in the outcome function; the verifier's child env (as today); the vault-encrypted `value_enc` | The outcome function returns (memory); the encrypted row is today's storage |
| CLI config dir | `of-sign-in-*` (0700) | Every exit path; boot sweep |

### 6.2 Where a secret could leak, and the guard

- **Logs.** The runner and store log fixed lines only (`sign-in started`, `sign-in ended: <reason>` with the user id, never URL, code or token). Fastify's request log never logs bodies; the redact list gains `*.code` and `*.url` for any object that reaches a log by mistake. AC5's capture test.
- **Errors.** Every route error is a fixed constant (§6.3). Runner and transport errors are mapped to reasons, never wrapped; a caught `Error` from the child is discarded, not stringified.
- **Events and the database.** No session event, activity event or message carries attempt data. The notice body names the credential and a date only.
- **Process arguments.** argv is fixed (§5.1); the code goes through stdin. A `ps` on the host shows `python3 -I -S -c <script> /path/claude setup-token`.
- **Child environment.** The allow-list (§5.2).
- **Temp files.** The config dir is the only file the CLI may write. Or's manual run (§11.3) lists the dir after the token prints; if `setup-token` writes the token there, that is a blocker raised before implementation continues (Q1 condition), because the dir is removed but the bytes touched disk.
- **The UI.** The token never reaches the browser. The URL shows in a read-only mono line to its owner. The code field is a `PasswordInput`-style masked field with `autocomplete="off"`, `spellcheck=false`.
- **Another user.** Attempts are keyed by user id; no request names an attempt (§5.4).

### 6.3 Fixed messages (all ≤ 40 characters)

`FIELD_MSG`: `signInCode` "Paste the code from the sign-in page." (37), `signInCodeRejected` "Claude didn't accept that code." (31).
`MSG` (server form-level): `signInUnavailable` "Sign-in needs python3 on the server." (35), `signInStartFailed` "Couldn't start sign-in. Try again." (34), `signInBusy` "Too many sign-ins. Try again shortly." (37), `signInExpired` "Sign-in timed out. Start again." (31), `signInEnded` "Sign-in ended. Start again." (27), `signInFailed` "Sign-in didn't finish. Start again." (35), `signInNotFound` "No sign-in in progress." (23), `signInState` "Sign-in is already finishing." (29), `newTokenRejected` "Claude rejected the new token." (30); `claudeUnreachable` stays "Couldn't reach Claude. Try again." and the sign-in panel adds Start again.

## 7. Tests and fixtures

### 7.1 Unit (no database)
- Parsers: §7.3's cases.
- Runner over an in-memory `PtyRun`: prompt across chunk boundaries; buffer bound; the code write then a separate `\r` after `settleMs`; code dropped; token across chunks; OAuth error; exit before token; timeouts; abort in every state; kill on every terminal state; no CLI text in any result.
- Bridge (`python3` required; skipped with a message when absent, never in CI where it is present): the real `pty-bridge.py` running the fake CLI's `setup-token` mode end to end; stdin EOF and SIGTERM leave no process in the group (`pgrep -g`).
- Host transport: exact spawn options; the dir is 0700 and removed on success, failure, kill and an exec failure; `ENOENT` → unavailable.
- Store with an injected clock: one per user, the cap, TTL, cancel, a new start cancels the old, name validated before the code is written, wait after reload, the 60 s settled outcome, client disconnect, close-all.
- Expiry states and copy (web pure function).

### 7.2 Server (Postgres, CI only)
- Routes end to end with the fake CLI as `FACTORY_CLAUDE_BIN`: create and replace through sign-in; `expires_at` = mint + 365 d; replace keeps id and assignments and calls `requestRestart`; isolation between two users (AC6); the log-capture test (AC5).
- Expiry check: notifies once within 14 days, never for null `expires_at`; concurrent runs make one message; replace re-arms; delete cascades the notice; inbox item shape and link.
- `reverify` sets and clears `rejected_at`.

### 7.3 Parser fixtures
- **Synthetic fixture** `credentials/sign-in/__fixtures__/setup-token.synthetic.txt`, built from Paperclip's tested cases and **labelled synthetic in its first line and its file name**: the 2.1.205-shaped output (OSC 8 hyperlink, CHA-spaced words, the copy hint, the prompt with `>`), the 2.1.19-shaped hard-wrapped plain URL, and a success screen with a CR-joined, wrapped token. Every value is made up (`client_id` a fixed UUID, a fake 43-char challenge, `sk-ant-oat01-SYNTHETIC…`).
- **Cases:** both URL hosts; OSC 8 vs wrapped; repeated URL lines; copy hint; look-alike host, mixed case, punycode, `:443`, userinfo, fragment, duplicate key, missing key, wrong `redirect_uri`, a fifth extra key, `sk-ant-` in the URL or a decoded key; prompt on the wrong line or sharing prose; URL beyond 512 characters from the preamble; token outside the anchors, anchors twice or out of order, prose between them, wrong prefix, too short; OAuth error.
- **Recorded fixture (Or, manual, §11.3):** `setup-token.recorded-<version>.txt`, the raw PTY bytes with the URL's query values, the code and the token replaced by synthetic values of the same shape and length (so wrapping and positions survive). The same tests run against every fixture in the folder; the synthetic one stays.

## 8. Web

Every apps/web task: implementer and reviewer invoke `vercel-react-best-practices` and follow it.

### 8.1 Add credential form (`features/settings/forms/add-credential-form.tsx`)

Fields, top to bottom, in `field-stack`:

1. **Name** (as today).
2. **Kind**, a radio group (legend "Kind"): **Sign in with Claude** (default), **Paste a token**, **API key**. The first two store `oauth_token`; the choice is UI state only (Q8). Switching keeps Name and each choice's own value.
3. The chosen kind's body:
   - **Sign in with Claude:** the sign-in panel (§8.2).
   - **Paste a token:** today's `TokenField` with help "Create one with `claude setup-token`.".
   - **API key:** today's `TokenField`.

Footer (I4's `SheetFormFooter`/`FormFrame` with the `FormOutcome` line): submit is **Sign in and add** (pending "Signing in…") for sign-in, **Verify and add** (pending "Verifying…") otherwise. While the sign-in panel has no URL yet, the submit is disabled-shaped and Start sign-in is the panel's own action. Cancel/Close as today. The sheet title stays "Add credential".

### 8.2 The sign-in panel (`features/settings/sign-in/sign-in-panel.tsx`)

One component, used by Add credential and by the Sign in again sheet. It has three states, all in one fixed frame:

- **Idle:** one line of text, "Sign in to your Claude account in your browser, then paste the code it shows.", and an outline **Start sign-in** button. When `available` is false: the line "Sign-in needs python3 on the server." in muted text with the alert icon, no Start button, and (in Add credential) a hint that Paste a token works.
- **Starting:** the button reads "Starting…" with a spinner (pending label next to the spinner, DESIGN.md), the line unchanged.
- **Ready (`awaiting_code`):**
  - an outline **Open sign-in page** that is a real link (`<a href={url} target="_blank" rel="noopener noreferrer">`, Q10), with an external-link icon;
  - the URL in a read-only mono field, one line, truncated in the middle visually with the full URL as its value, and a **Copy** icon button (check for 1.5 s, DESIGN.md's copy feedback);
  - the **Code** field (`FieldShell` + masked input, help "Shown after you sign in."), `autocomplete="off"`;
  - a quiet line "Expires in 10 minutes" (static text with the absolute time in a tooltip; no ticking countdown) and a ghost **Cancel sign-in**.
- **Exchanging:** the fieldset is disabled, the submit reads "Signing in…" with its spinner; nothing else changes size.

Errors go through I4: the code's rule failures and `sign_in_code_rejected` to the Code field's note; `credential_exists`/name errors to Name; everything else (expired, ended, start failed, busy, unreachable, rejected new token) to `FormOutcome`. An error that ends the attempt (code rejected, expired, ended, failed) returns the panel to Idle in the same commit, keeping Name; focus moves to the field with the error, or to Start sign-in for a form-level outcome.

The panel's frame reserves the Ready height from the start, so Idle → Starting → Ready changes content, not layout: Idle and Starting show their line and button at the top of the same box. (Break-UI and Apple reviews to confirm the reserved height is not an empty gap; see §10.)

### 8.3 Attempt state in React

- `signInQueryOptions` (`["credentials", "sign-in"]`): `GET /api/credentials/sign-in`, `staleTime: 0`, `refetchOnWindowFocus: true`, **no polling** (Q2). Mounted by the panel only.
- Start, code and cancel are `useMutation`s; on success they write the attempt into the query cache with `setQueryData` instead of refetching.
- When the query shows `exchanging` on mount (a reload), the panel runs the `code/wait` mutation once and renders its result exactly as a submit's.
- On a successful create: today's `onDone` path (Settings upsert and "Added <name>."; the stacked sheet's `completeChild`). On replace: the row's success outcome "Signed in again. <restart note>".
- The sheet's kept draft (U4) holds Name and Kind only, never the code; closing the sheet does **not** cancel the attempt (it lives 10 minutes and the next open shows it), Discard does.
- The panel reads the attempt's `purpose`: an Add credential panel that finds a `replace` attempt (or the reverse) shows Idle with "Another sign-in is in progress; starting here ends it." above Start.

### 8.4 Credential row (`credentials-section.tsx`)

- `ExpiryLine` beside `VerificationState`, derived from `expiresAt`, `rejected` and now (`expiryState()` pure function, Q11):
  - more than 14 days: "Expires about 12 Nov 2027", muted;
  - within 14 days: "Expires in 9 days" ("Expires tomorrow", "Expires today"), warning tone with the alert icon;
  - past: "Expired 12 Nov 2027", crimson with the icon;
  - OAuth with null `expiresAt`: "Expiry unknown", muted; API keys: nothing.
  Dates use the browser locale's medium date (`12 Nov 2027` in en-GB, `Nov 12, 2027` in en-US).
- **Sign in again**, a ghost button in the row's actions before Verify, shown only when `rejected`, within 14 days or expired (Q7); always an item in the ⋯ menu for `oauth_token` credentials, above Replace token. Both open the Sign in again sheet.
- `VerificationState` for a rejected credential stays "Last check failed: Claude rejected this token." as today.

### 8.5 Sign in again sheet

A new top-level sheet kind `{ kind: "sign-in-again"; name: string }` (sheet store and `sheet-bodies.ts`), title "Sign in again", the name under the title as the sheet's subtitle (mono). Body: the sign-in panel with `purpose: replace`; no Name or Kind. Submit **Sign in and replace** ("Signing in…"). On success the sheet closes with a toast "Signed in again as <name>." (DESIGN.md: the control that caused it is gone) and the credentials list refetches. Opened from the row, the ⋯ menu and the Inbox pane; on phones it is the bottom drawer like every sheet.

### 8.6 Inbox

- Row: the factory mark, "Factory", the body as preview, like an `agent_errored` fact; accessible name "Factory, credential <name> expires, <time>".
- Pane: the body as text, then **Sign in again** (outline; opens the sheet) and an **Open credentials** link (`/settings/credentials`, focusing the row via `?credential=<name>`). No reply composer (there is no one to reply to). When `credential.current` is false: "Already signed in again." replaces the button.
- Notifications (`useInboxNotifier`): title "Credential expiring", body the preview; click opens `/settings/credentials?credential=<name>`. I8's desktop notification reuses this.
- `?credential=<name>` on the credentials page scrolls the row into view and gives it the selected fill once.

## 9. I8 hooks

I8's first-run step **Sign in to Claude** opens the Add credential sheet (Sign in with Claude is already the default), and its desktop notification for "a credential about to expire" fires on the `credential` inbox item. Nothing else is needed from I3.

## 10. UI review focus

For the Apple, Emil and Break-UI reviews: the panel's reserved frame (§8.2) vs an empty gap; the URL line at 320 px and 200% text; the three-way Kind at 320 px; the link-styled Open sign-in page; the disabled submit before Start; the row's action count with Sign in again, Verify and ⋯ at 390 px; the Inbox pane without a composer.

## 11. Evidence and manual steps

### 11.1 Fake CLI
`packages/harness/testing/fake-claude.mjs` gains a `setup-token` mode (argv `setup-token`): it requires a TTY on stdin (`process.stdin.isTTY`, else exits 1 with "Raw mode is not supported", like Ink), prints the welcome line, the preamble and a **synthetic** URL as an OSC 8 hyperlink with CHA-spaced words, the copy hint and the prompt, then reads stdin in raw mode until a separate `\r`: code `bad` prints `OAuth error: Invalid code` and waits; code `slow` waits 70 s; anything else prints the success screen with a synthetic `sk-ant-oat01-SYNTHETIC…` token wrapped at the window width, CR-joined, and exits 0. The fake's verification turn accepts the synthetic token. It never contacts the network.

### 11.2 Browser evidence (last plan tasks)
Through `docs/product/ui-review/u4-evidence/harness` (main checkout) and its `run.sh` lock, with `FACTORY_CLAUDE_BIN` = the fake (never the real CLI), at most one evidence pass or full suite at a time under `/tmp/of-v002-heavy.lock`. Chromium and WebKit headless: AC1 (sign in, agent starts), AC2 (reload mid-attempt and mid-exchange), AC3 (a 20 s TTL), AC4 (Cancel, then `pgrep` for the fake), AC9 (row states seeded through the DB), AC10 (`python3` hidden from `PATH`), the Inbox pane and Sign in again (AC8); at 1440×900 and 390×844, light and dark, plus 320 px and 200% text for the panel and the row.

### 11.3 For Or (manual; not automatable)
1. **Record the real CLI transcript.** With your own account, run `claude setup-token` through `pty-bridge.py` (a script in the plan writes the raw bytes to a file and never prints them), complete the sign-in, then replace the URL query values, the code echo (masked) and the token with synthetic values of identical length, keep the control sequences, and commit it as `setup-token.recorded-<version>.txt`. Run the parser tests against it.
2. **Check the config dir.** In the same run, list the temp dir after the token prints (`ls -la` and `grep -rl sk-ant-oat01 <dir>`, which prints file names only). If any file contains the token, stop and report: that is a blocker (Q1 condition).
3. **One real sign-in** through the UI on your factory: Add credential → Sign in with Claude, and one Sign in again on that credential. Confirm the credential verifies, an agent starts on it, and `grep` of the server log for `sk-ant-`, `oauth/authorize` and the code finds nothing.

## 12. Product docs and DESIGN.md

- **ADR 0027:** amendment note: "Host only. `claude setup-token` runs through a python3 PTY bridge on the host, the same host `claude` verification uses; no container path, because the token belongs to the account and verification already needs the host CLI (I3 Q1)." And: pasted tokens have no expiry field (Q5).
- **`concepts/credential.md`:** Sign in with Claude; `expires_at` (signed in: mint + 1 year; pasted: unknown, no field); the 14-day notice; Sign in again replaces in place; `rejected_at` from Verify. The delete confirmation's "create a new one with `claude setup-token`" becomes "sign in again to get a new one".
- **`behavior/administration.md` → Credentials:** the three-way Add credential, the panel, the row's expiry line and Sign in again, the 10-minute attempt, Cancel.
- **`behavior/inbox.md`:** the `credential` item kind from `@factory`, with Sign in again in the pane.
- **`architecture/data-model.md`:** the new columns.
- **I3 task spec:** strike "inside a throwaway base-image container…" and "unless the user enters it"; replace "I already have a token" with the three-way choice.
- **DESIGN.md:** no amendment expected; the panel uses existing controls (outline button, mono read-only field, copy feedback, field notes, `FormOutcome`). A reviewer finding that needs one is recorded here as an explicit amendment.

## 13. Decisions

Q1–Q13 with the proxy's answers and certainty are in the decision issue. Tech-lead decisions:

- **D1** The runner talks to a `PtyRun` interface, rather than spawning, so the state machine is unit-tested without a process and the bridge is tested once on its own.
- **D2** The bridge is a repo file inlined by esbuild's text loader and run with `python3 -I -S -c`, rather than a loose file beside the bundle, because the server ships as one bundle; argv stays free of user input (Q1's condition).
- **D3** A 200×50 window, rather than the PTY's zero size, because Ink wraps at the window width and Paperclip characterized 200 columns; the parser still de-wraps.
- **D4** `HOME` = `CLAUDE_CONFIG_DIR` = the temp dir, rather than the server user's home, so the CLI can't read or write the host user's Claude state.
- **D5** The code is stripped of all whitespace and limited to printable ASCII, rather than passed as typed, because a pasted newline would submit early and a control character could drive the terminal.
- **D6** Start resolves only after the URL validated (≤ 30 s), rather than returning at once, so the UI never shows a URL that failed validation and needs no polling (Q2, Q10).
- **D7** The outcome promise belongs to the store, kept 60 s after it settles, rather than to the request, so a reload or a lost connection still gets the result once and the save is never cancelled by a closed tab.
- **D8** Cancel is refused during the exchange, rather than killing it, because the code is spent and the save is seconds away; killing then would lose the token for nothing.
- **D9** A name taken by a race after the pre-check fails the attempt, rather than retrying with another name, because the user chose the name.
- **D10** `expires_at` = the time the token was parsed + 365 days, rather than the verification time, as the nearest point to the mint; the UI says "about".
- **D11** The notice's date is formatted in the factory time zone in the stored body, and the row's date in the browser's locale, because the body is stored text and the row is live.
- **D12** `subject_credential_id` cascades on delete, rather than nulling, so a deleted credential's notice disappears instead of pointing at nothing.
- **D13** Closing the sheet keeps the attempt (until its TTL), rather than cancelling, so a user who closed it to look something up returns to the same URL; Discard cancels.
- **D14** Sign in again is a top-level sheet kind, rather than a child sheet, because it is opened from Settings and the Inbox, never over another form.
- **D15** No ticking countdown on the attempt, rather than a timer, because the 10 minutes is ample and a ticking number draws the eye (DESIGN.md: waiting lines keep fixed times).
- **D16** The panel reserves its Ready height from Idle, rather than growing when the URL arrives, so the footer never jumps (I4's "nothing moves"); reviewers check it doesn't read as an empty gap.
