# I3 Sign in with Claude: Technical Design

- **Date:** 2026-11-23
- **Status:** revised after the self-review and the Apple, Emil design-eng and Break UI reviews. The owner-proxy (owner-i3) answered Q1–Q13 and the review calls R1–R8. **For Or** (certainty 3, or a deviation from the task spec or an ADR): **Q1** (host only, no container path; amends ADR 0027), **Q5** (no expiry field for pasted tokens), **Q8** (a flat three-way choice instead of "I already have a token"), **Q9** (global cap of 3), **R1** (one primary at a time: "Start sign-in", then "Sign in and add"), **R2** (no visible URL field), **R4** (healthy rows say "Expires Nov 2027"; nothing for unknown), **R8** (Name checked at submit, not at Start). **Merge gate:** Or's manual config-dir and keychain check (§11.3 step 2) must come back clean before the PR merges (it is opened ready for review; the user merges).
- **Source of truth (gitignored, read from the main checkout):** `docs/product/roadmap/v0.0.2/i3-claude-sign-in.md` (the task), `roadmap/v0.0.2/scope.md`, `roadmap/v0.0.2/index.md`, `decisions/0027-claude-sign-in.md`, `decisions/0010-config-dir-and-credentials.md`, `decisions/0028-pre-release-no-compatibility.md`, `concepts/credential.md`, `behavior/administration.md`, `behavior/inbox.md`, `architecture/base-image.md`, `architecture/agent-runtime.md`, `ui-review/decisions.md`.
- **Builds on:** `spec/i2-agent-config` (I4's `useFieldErrors`, `FieldNote`, `FormOutcome`, `useOutcome` and the `MSG`/`FIELD_MSG`/`FORM_MSG` constants are merged below it; I1 changes the Inbox to chat rows plus `items`).
- **Reference implementation read (not copied):** Paperclip `packages/adapters/claude-local/src/server/setup-token-{parse,runner}.ts` and `server/src/services/local-ai-browser-login.ts` (MIT), read through `gh api` on 2026-11-23. Behaviour is ported; the code is our own.
- **Decision log:** GitHub issue "I3: Sign in with Claude — design". Q1–Q13 and R1–R8 are the proxy's answers; D1–D20 are tech-lead decisions (§13).

> `docs/product/` is gitignored. Paths into it are relative to the main checkout. Web paths are relative to `apps/web/src/`, server paths to `apps/server/src/`, unless they start with `apps/` or `packages/`.

## 1. Goal

Adding a Claude credential takes a click, a sign-in in the user's own browser and a paste, instead of "open a terminal, run `claude setup-token`, copy a secret". The factory runs `claude setup-token` itself in a pseudo-terminal, shows the sign-in link, writes the pasted code back, reads the one-year token the CLI prints, verifies it with today's verification turn and stores it as today's `oauth_token` credential. Expiry is tracked: the credential knows when a signed-in token runs out, the Inbox says so 14 days ahead, and **Sign in again** replaces the token in place.

### 1.1 Deviations from the task spec and ADR 0027 (owner-proxy approved, for Or)

- **Host only (Q1, certainty 3).** The task and ADR 0027 say "inside a throwaway base-image container when Docker is available, otherwise the host". This design runs `claude setup-token` on the host only, through a python3 PTY bridge. Credential verification (`credentials/verify.ts`) already runs the **host** `claude` (`FACTORY_CLAUDE_BIN`) for every add, replace and re-verify, so a host `claude` is already required; the token belongs to the account, not to a CLI build; two transports double the cleanup paths. ADR 0027 gets a one-line amendment (§12).
- **No expiry date for pasted tokens (Q5, certainty 3).** Pasted tokens have no known expiry and never notify; the Paste a token help says "You won't be warned before it expires." (R4).
- **A flat three-way choice (Q8, certainty 3).** The task's "**I already have a token**" link becomes a choice of method: "Sign in with Claude" (default), "Paste a token", "Paste an API key".
- **No visible URL (R2, certainty 3).** The task's "the URL with a copy button" becomes the real link "Open sign-in page", a ghost **Copy link** and a muted line naming the link's host.

## 2. Acceptance criteria

Default CI (`pnpm test`, `pnpm typecheck`, `pnpm lint`) unless marked. Server tests that need Postgres run only in CI (the local Postgres role is unavailable).

1. **Sign in creates a credential.** On a factory with no credential, Add credential → Start sign-in shows Open sign-in page; submitting a Name and the code creates an `oauth_token` credential that verified, with `expires_at` = the time the token was read + 365 days; an agent created with it starts. (Server: runner and route tests against the fake CLI, CI. Browser: the evidence pass with the fake `claude setup-token`. Manual: Or's real sign-in, §11.3.)
2. **Reopening.** After a reload, reopening Add credential (or Settings → Credentials, which opens its add form in Ready by itself) shows the same attempt; a reload while the code is being exchanged shows "Signing in…" or "Verifying…" and then the same outcome as the original request (§5.4). (Store unit tests; evidence pass.)
3. **Expiry of an attempt.** 10 minutes after Start (while waiting for the code) the process is killed, its temp dir removed, and an open panel shows "Sign-in timed out. Start again." at its deadline without polling (unit tests with an injected clock; evidence pass with a 20 s TTL).
4. **Cancel.** While waiting for the code, Cancel sign-in, inline Cancel, a new Start, a successful paste or API-key add, sign-out and Disable all end the caller's attempt: the CLI (its own session and process group) and the bridge are gone and the temp dir removed (unit tests; a CI test that SIGKILLs the bridge and finds no CLI left).
5. **No secrets leave the attempt.** No URL, code or token appears in server logs, events, the database (beyond the encrypted credential value), error responses or process argv. A test drives one full sign-in through the fake CLI with a capturing logger **at `trace` level**, asserts that the bridge's stderr is never read into a log line, and asserts the synthetic URL, code and token never appear in the captured log output, in any response body other than the owner's `GET`/`POST` start (which carry the URL), or in the spawn arguments.
6. **Isolation.** Every attempt route acts on the caller's own attempt, found by the session's user id. Another user's attempt is invisible: their `GET` sees none; with no attempt of their own their code, wait and cancel are 404 `sign_in_not_found` whatever `attemptId` they send, and with one of their own a foreign id is 409 `sign_in_replaced` about their own attempt. A stale `attemptId` from the same user is 409 `sign_in_replaced` and touches nothing (route tests).
7. **Parser fails closed.** The prompt and token parsers pass every case in §7.3 (synthetic fixture until Or records the real one, then both).
8. **Expiry notice.** A credential whose `expires_at` is within 14 days produces exactly one `@factory` Inbox item per user (concurrent and repeated checks never double it); its pane offers Sign in again; Sign in again replaces the token, keeps the credential's id, name and assignments, sets a new `expires_at`, re-arms the notice and turns every open pane to "Already signed in again." (CI DB tests; evidence pass for the pane).
9. **Row states.** The credential row shows "Expires Nov 2027", "Expires in 9 days" (warning, with Sign in again after it), "Expired 12 Nov 2027" (crimson, with Sign in again) or nothing (unknown expiry, API keys), derived from `expiresAt` and now; a rejected credential also shows Sign in again after its failure line; the ⋯ menu has Sign in again for every OAuth credential (component tests; evidence pass at 320 px and 200% text).
10. **Fallbacks.** Without a working `python3` on the host, the method defaults to Paste a token, Sign in with Claude shows "Sign-in needs python3 on the server.", and paste and API key keep working (route test with a missing interpreter; component test).
11. **Form rules.** Every new error and outcome message is at most 40 characters, a constant, never interpolated (success toasts excepted, like today's "Added <name>."); every new field reserves its note line; form-level outcomes sit on I4's `FormOutcome` line (I4's length and template-literal tests cover the new constants).

## 3. Scope

**In:** the PTY bridge, the setup-token parsers and runner, the host transport, the attempt store and its routes; `credentials.expires_at`, `expiry_notified_at`, `rejected_at`; replace-in-place from a sign-in; the expiry check and its Inbox item (`messages.subject_credential_id`, inbox kind `credential`); the Add credential form's method choice and sign-in panel; the Sign in again sheet; the credential row's expiry line and Sign in again; the Inbox row and pane for the notice; the fake CLI's `setup-token` mode; the recording script for Or; product docs and four DESIGN.md amendments (§12).

**Out:** our own OAuth client; refresh tokens; non-Claude providers; a container transport (Q1); an expiry field for pasted tokens (Q5); marking a credential rejected from an agent's failed turn (Q6, follow-up issue); continuing a sign-in from the New/Edit agent credential field after a reload (follow-up issue); I8's first-run step and desktop notification (I8 builds on §8 and §9).

**Breaking (ADR 0028):** `credentials` gains three columns and `messages` one; the migration (`0020_*`, after I1/I2's `0015`–`0019`) is generated plus a hand edit of `inbox_items_kind_check` (a hand-written CHECK from migration 0008 that Drizzle doesn't model), with no backfill: existing OAuth credentials have `expires_at` null until they are signed in again. `CredentialSummary` gains `expiresAt` and `rejected`. Shared `INBOX_KINDS` gains `credential` (it is `notice | mention | task_event | credential`; the DB column keeps `message` as the stored name of a `notice`), and the inbox item's `link` union gains `{ kind: "credential", name }`. The web message `credentialDeleted` moves from `FORM_MSG` to shared `MSG` (the server answers with it), with no alias. `CredentialService.create` and `replace` take an `expiresAt`; `replace` keys on the credential id. Existing local data needs no reset.

## 4. Inventory (what exists today)

| Piece | Where | Today |
|---|---|---|
| Credential model | `packages/db/src/schema/factory.ts` `credentials` | `id`, `name` (unique), `kind` (`oauth_token` \| `api_key`), `value_enc` (vault, AAD `credentials:<id>`), `last_verified_at`, `last_error`, rate-limit columns, timestamps |
| Service | `credentials/credential-service.ts` | `list`, `create` (name pre-check, verify, insert), `replace` (verify, update in place, `requestRestart` each active user), `reverify` (writes `last_error` text), `remove` |
| Verification | `credentials/verify.ts` | One haiku turn through the **host** `claude` (`config.claudeBin`), env exactly `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` (mkdtemp) and the credential var; fixed messages only; 60 s timeout |
| Routes | `routes/credentials.ts` | `GET/POST /api/credentials`, `PUT /:name/value`, `POST /:name/verify`, `DELETE /:name`; `requireUser` on every route |
| Logging | `app.ts` `loggerOptions` | pino redact paths for auth headers, `*.value`, `*.token`, `*.env`, the two credential env vars; Fastify logs method and URL, never bodies |
| Add credential form | `features/settings/forms/add-credential-form.tsx` | Name, Kind (OAuth token / API key), `TokenField`; `useFieldErrors` + `useOutcome` (I4); frames `inline` (Settings, with Cancel) and `sheet` (stacked over New/Edit agent via `setup-sheets.tsx`, Close only, no kept draft) |
| Credential row | `features/settings/credentials-section.tsx`, `RowLine` in `features/settings/shared.tsx` | Name, kind, `VerificationState`, rate-limit line, usage; Verify (outline) and ⋯ (Replace token, Delete) in a non-wrapping actions group; inline `ReplaceForm` |
| Inbox items | `inbox_items.kind` `message \| mention \| task_event` (CHECK in migration 0008); shared `INBOX_KINDS` is `notice \| mention \| task_event` since I1, and `toEntries` maps the stored `message` to `notice`; `messages` `kind = 'system'` with `notice` and `subject_agent_id` (`@factory` facts); `EventStore.createHumanMessage` fans out to every user | `link` is `session` or `task`, branched as a binary in `inbox/api.ts:80`, `inbox-row.tsx:189`, `inbox-pane.tsx:51` and `:425`, `notifications.ts:128` |
| Periodic work | `uploads/sweep.ts`, `spawning/reaper.ts` | In-memory `setInterval` classes started after boot, stopped at shutdown |
| Copy feedback | `useCopy`, `CopyIcon`, `CopyFailed` | Check for 1.5 s; "Couldn't copy" inline when the clipboard API is missing |
| PTY | none | Node has no PTY API; `node-pty` would be a native build dependency |
| Host tools | dev machine and CI | `python3` 3.12 and `claude` 2.1.327 here; CI is `ubuntu-latest` (python3 present); `claude setup-token --help` prints only `-h` |
| Fake CLI | `packages/harness/testing/fake-claude.mjs`, wrapped as `FACTORY_CLAUDE_BIN` by the U4 harness | No `setup-token` mode |

No new npm dependency: the PTY is python3's standard-library `pty`.

## 5. Server

### 5.1 The PTY bridge (`credentials/sign-in/pty-bridge.ts`)

The Python script is one exported `String.raw` constant, `PTY_BRIDGE`, in its own file; a test asserts it contains no `${` and no backtick, so nothing can ever be interpolated into it (R6). It runs as:

```
python3 -I -S -c <PTY_BRIDGE> <claudeBin> setup-token
```

`-I` (isolated: no user site, no `PYTHON*` env, no script dir on the path) and `-S` (no `site`) so nothing from the host's Python setup is imported. argv carries only the fixed script, the configured `claude` path and the literal `setup-token`. `claudeBin` comes only from server config (`FACTORY_CLAUDE_BIN` or its default), never from a request; the spawn takes an argument array with no shell (Q1, R6).

The script:
1. `pid, fd = pty.fork()`. In the child: close fd 3, set the window to 200 columns × 50 rows with `TIOCSWINSZ` on fd 0 **before** exec (a zero-size PTY makes Ink wrap every character; setting it from the parent would race the child's startup), then `os.execvp(argv[1], argv[1:])`, `os._exit(127)` if that fails. `pty.fork` makes the child a session leader in its own process group.
2. In the parent: write the child's pid as one line to fd 3 (a pipe the server opened), so the server can kill the CLI's group even if the bridge itself is gone.
3. Loop on `select([fd, 0])`: stdin bytes go to the PTY master, master bytes go to stdout. EOF on stdin, `SIGTERM`, `SIGHUP` or `SIGINT` → `os.killpg(pid, SIGKILL)` and exit 1. `EIO` on the master (the child closed the terminal) ends the loop.
4. `waitpid`, and exit with the child's exit code.

Nothing is written to stderr except Python's own crash traceback, which the server discards unread.

### 5.2 Host transport (`credentials/sign-in/host-pty.ts`)

```ts
interface PtyRun {
  onData(cb: (chunk: string) => void): void; // UTF-8 through a streaming TextDecoder
  write(s: string): void;
  kill(): void;                               // idempotent, see below
  readonly exit: Promise<{ code: number | null }>;
}
function startHostPty(d: { claudeBin: string }): Promise<PtyRun>
```

- **Temp dir:** `mkdtemp(join(tmpdir(), "of-sign-in-"))`, mode 0700, used as both `HOME` and `CLAUDE_CONFIG_DIR` (D4), removed as soon as the CLI exits (on success right after the token is read, before verification), and on every other path: failure, cancel, TTL, a new Start, sign-out, Disable, server shutdown. Boot removes stale `of-sign-in-*` dirs (a crashed server's leftovers), acting only on **direct children of `os.tmpdir()` with the exact prefix**, inspected with `lstat` (never following or deleting through a symlink), **owned by the server's uid**, and **older than 15 minutes** (the margin leaves a second factory on the same host alone); anything else is left alone.
- **Environment: an allow-list, never `process.env`** (Q1): `PATH` and `LANG` from the server env (when set), `TERM=xterm-256color`, `HOME` and `CLAUDE_CONFIG_DIR` = the temp dir, `BROWSER=true`, and `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` set to the empty string. `DATABASE_URL`, `FACTORY_SECRET_KEY` and every factory secret are absent by construction.
- **Spawn:** `spawn("python3", ["-I", "-S", "-c", PTY_BRIDGE, claudeBin, "setup-token"], { env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] })`. `detached: true` puts the bridge in its own group, so a Ctrl-C on the dev server doesn't reach it as a stray signal (the bridge handles SIGINT anyway). A unit test asserts the exact argv, env (keys and values), `detached` and stdio.
- **Kill:** close stdin (the bridge killpg's the CLI and exits); after 1 s `SIGTERM` the bridge; after 2 more seconds `SIGKILL` the bridge and `process.kill(-childPid, "SIGKILL")` with the pid read from fd 3. Idempotent; a missing process is not an error.
- **stderr** is drained and dropped (`resume()`), never buffered or logged.
- **Availability:** probed lazily on the first `GET` and cached for the process: `python3 -I -S -c "import pty"` with a 5 s bound. A spawn error, a non-zero exit or a timeout (for example macOS's `/usr/bin/python3` stub without the Command Line Tools) means unavailable. A spawn `ENOENT` at Start also maps to unavailable.

The runner (§5.3) talks only to `PtyRun`, so tests drive it with an in-memory fake (D1), and the fake CLI drives the real bridge.

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
| `exchanging` | `hasOAuthError` | `failed: code_rejected` |
| `exchanging` | exit without a token, 60 s, or abort | `failed: exchange_failed` |

After the code is written, **anything other than a token that parses strictly between the anchors ends the attempt** with a fixed reason (Q12). The runner never retries inside a run and kills the PTY on every terminal state. It never logs, throws or returns CLI text: its results are the validated URL, the token, or one of the fixed reasons.

### 5.4 Attempt store (`credentials/sign-in/attempts.ts`)

In memory, one `SignInAttempts` instance per server.

```ts
type Purpose = { kind: "create" } | { kind: "replace"; credentialId: string; name: string };
type AttemptView = {
  attemptId: string;         // random, non-secret, not the OAuth state
  state: "starting" | "awaiting_code" | "submitting" | "exchanging" | "verifying" | "settled";
  url?: string;              // awaiting_code and submitting only
  codeDeadline?: string;     // awaiting_code and submitting only: when the attempt times out (ISO)
  purpose: "create" | "replace";
  name?: string;             // replace: the credential's name; create: the submitted name once submitted
};
```

**States.** `starting` is inserted **synchronously**, before any await, when Start is accepted, so two Starts from one user (two tabs, a reload during the ≤ 30 s start) can't both spawn and the cap counts it at once. `submitting` is set synchronously on entry to `submit`, before the name check, so a second code for the same attempt is refused and the TTL can't fire mid-check; a failed name check returns it to `awaiting_code` with its original deadline. `settled` holds the outcome for 60 s.

| Request \\ state | `starting` | `awaiting_code` | `submitting` / `exchanging` / `verifying` | `settled` |
|---|---|---|---|---|
| `start` | 409 `sign_in_state` | ends it, starts anew | 409 `sign_in_state` | drops it, starts anew |
| `code` | 409 `sign_in_state` | accepted | 409 `sign_in_state` | 409 `sign_in_state` |
| `code/wait` | 409 `sign_in_state` | 409 `sign_in_state` with the attempt (the code never arrived) | waits | the outcome |
| `cancel` | aborts the runner | ends it | 409 `sign_in_state` | drops it |
| `endFor` | aborts the runner | ends it | untouched (the save is seconds away) | drops it |

- **Keyed by the session's user id** (Q9). Every operation looks up the caller's attempt first. Requests that act on an attempt also carry its `attemptId`; a different id for the caller's attempt is 409 `sign_in_replaced` ("Sign-in restarted elsewhere.") and touches nothing, so a second tab can't push its code into another tab's run (D17). Another user's attempt is never reached: with no attempt of the caller's, every request is 404 `sign_in_not_found`, whatever id it sends.
- **One per user:** `start(userId, purpose)` ends the caller's attempt first (kill, rm) when it is in `awaiting_code`; in `exchanging` or `verifying` the start is refused with 409 `sign_in_state` ("Sign-in is already finishing.").
- **Global cap:** at most 3 live attempts, where one helper `isLive(state)` (true for `starting`, `awaiting_code`, `submitting`, `exchanging` and `verifying`) is used by both the cap and `endFor`'s selection, so a submit in flight holds its slot; the 4th `start` is 429 `sign_in_busy` ("Too many sign-ins. Try again shortly."). The caller's own replaced attempt doesn't count.
- **TTL:** 10 minutes from `start` (`SIGN_IN_TTL_MS`, injectable) **while waiting for the code**. Submitting the code clears it; from then on the runner's 60 s exchange bound and the verifier's bounds govern (D8). When the TTL fires the process is killed, the dir removed, and a **tombstone** `{ attemptId, reason: "expired" }` is kept for 60 s so a late code gets 410 `sign_in_expired` ("Sign-in timed out. Start again.") rather than 404.
- **`start`** resolves when the runner reaches `awaiting_code` (the URL validated) or fails: on failure the process is killed, the dir removed, and the route answers 502 `sign_in_start_failed` ("Couldn't start sign-in. Try again."). A URL that didn't validate is never shown (Q10, D6).
- **`submit(userId, attemptId, { code, name? })`:** only in `awaiting_code` (else 409 `sign_in_state`); the state becomes `submitting` synchronously. For `create`, the name is validated **before** the code is written (Q3, R8): `nameSchema` and the uniqueness pre-check; a failure is 400 `validation_error` `{ fields: { name } }` or 409 `credential_exists`, and the attempt returns to `awaiting_code`, so the single-use code is not burned. For `replace`, the credential id must still exist (else 404 `credential_not_found`, attempt-ending, before the code is written). Then the TTL is cleared, the state becomes `exchanging`, and one promise (`outcome`), owned by the store, carries the rest (D7):
  1. the runner writes the code and waits for the token; the CLI exits and its dir is removed;
  2. `verifying`: the token is checked **once, here**, with today's `CredentialVerifier`, retried once after 3 s on `unreachable` (Q13);
  3. `create` calls `credentials.insertVerified({ name, kind: "oauth_token", value: token, expiresAt: mintedAt + 365 days })`; `replace` calls `credentials.replaceVerified(credentialId, token, { expiresAt })` (same id, assignments kept, active users restart when idle, `expiry_notified_at` and `rejected_at` cleared). These are the service's write halves, split out of `create` and `replace` so a sign-in never pays for a second verification turn; the paste routes keep `create`/`replace`, which verify and then call them. Replacing by id means a credential deleted and re-created under the same name meanwhile is never given the token; a missing id fails with 404 `credential_not_found`;
  4. `settled`: the outcome is kept for 60 s, then the attempt is dropped.
  The outcome is `{ ok: true, credential }` or `{ ok: false, code, message }` with a fixed message (§6.3). A name taken between the pre-check and the insert (a race) fails with 409 `sign_in_name_taken` ("That name was taken. Start again."), attempt-ending, and drops the token; that is the one case where a name problem burns the sign-in (D9).
- **Waiting (Q2):** `POST /code` waits for the outcome up to 50 s, then answers 202 `{ attempt }` (still `exchanging` or `verifying`). `POST /code/wait` does the same: the outcome, or 202 after 50 s. The client calls `/code/wait` again on a 202, on a network error, and on an error with **no API code** (`apiFetch`'s `http_<status>` for a non-JSON body: a proxy timeout or gateway page), so a save never lands behind a generic error (D18). An error the server answered with its own code (`sign_in_failed`, `claude_unreachable`, …) is the outcome and is never retried. Server failures are 4xx/5xx with a JSON code, as listed in §5.5.
- **Who renders a settled outcome:** only the client that submitted, which remembers the `attemptId` it submitted (in memory, per tab). A reload that finds `exchanging`, `verifying` or `settled` calls `/code/wait` once and renders its answer, but a `settled` success is shown only if this tab submitted it; other tabs and Settings' auto-open ignore a settled attempt (no second "Added X." and no second `completeChild`). A submitting client that gets 404 after the outcome was dropped refetches the credentials list and treats the name present (create) or a new `expiresAt` (replace) as success.
- **Client gone mid-submit:** the outcome belongs to the store, so a closed connection doesn't cancel the save.
- **Cancel** (`cancel(userId, attemptId)`): kills the process, removes the dir, drops the attempt. Idempotent. Refused during `exchanging` and `verifying` (409 `sign_in_state`): the code is spent and the save is seconds away (D8).
- **Ends without a request:** `endFor(userId)` (no attemptId; see the table: it never touches an attempt past the code) on sign-out, on Disable of that user, and on a successful paste or API-key create by that user. Sign-out: `routes/auth.ts` forwards `/api/auth/*` to better-auth with no hook today, so the `POST /api/auth/sign-out` path resolves the session's user through `app.auth.api.getSession` before forwarding and calls `endFor` after a 2xx. Sign-out is per session and attempts are per user, so signing out one browser ends the user's attempt everywhere (accepted: attempts are short). Known limit: other ways a session ends (a password change, revoking sessions, session expiry) don't call `endFor`; the attempt then lives until its 10-minute deadline, and only its owner could have used it. Disable: `UserAdmin` gets the store injected and calls `endFor` beside `bus.closeUser` (`users/user-admin.ts`). `closeAll()` is a shutdown step before the database closes.
- **Token lifetime:** the token exists only as a local in the outcome function, passed to the verifier and to `create`/`replaceById`, then unreachable; it is never on the attempt object, never returned, never logged; on a failed verification it is dropped at once (Q13). JavaScript strings can't be zeroed; holding it in one async scope is what we can do. The code is dropped from the attempt as soon as it is written.

### 5.5 Routes (`routes/claude-sign-in.ts`, all `requireUser`)

Mounted under `/api/claude-sign-in`, not under `/api/credentials`, so no static path can shadow a credential named `sign-in` (D19).

| Route | Body | Answer |
|---|---|---|
| `GET /api/claude-sign-in` | — | `{ available: boolean, attempt: AttemptView \| null }` |
| `POST /api/claude-sign-in` | `{ replace?: name }` | 200 `{ attempt }` (`awaiting_code`, with `url` and `codeDeadline`); 404 `credential_not_found`; 400 `validation_error` when `replace` names an `api_key` credential; 409 `sign_in_state`; 429 `sign_in_busy`; 502 `sign_in_start_failed`; 503 `sign_in_unavailable` |
| `POST /api/claude-sign-in/code` | `{ attemptId, code, name? }` | 201 `{ credential }` (create) or 200 `{ credential }` (replace); 202 `{ attempt }` (still working); 400 `validation_error` (`code`, `name`); 409 `credential_exists`, `sign_in_name_taken`, `sign_in_state`, `sign_in_replaced`; 410 `sign_in_expired`; 404 `sign_in_not_found`, `credential_not_found`; 422 `sign_in_code_rejected`, `sign_in_token_rejected`; 502 `sign_in_failed`, `claude_unreachable` |
| `POST /api/claude-sign-in/code/wait` | `{ attemptId }` | the same answers as `/code` for an attempt in `exchanging`, `verifying` or `settled`; 409 `sign_in_state` with `{ attempt }` while it is still `awaiting_code` (the code never arrived: the panel returns to Ready and keeps the unspent code, the one exception to R5's clearing) |
| `DELETE /api/claude-sign-in/:attemptId` | — | 204; 409 `sign_in_state`, `sign_in_replaced`; 404 (the id is in the path, not a body, which some proxies strip from a DELETE) |

- **`code`** has every whitespace character removed (a pasted code can carry a newline that would submit early), then must be 1–512 characters of printable ASCII; else 400 "Paste the code from the sign-in page." (D5). It travels only in this POST body, never a URL or query (Q2).
- The URL is returned only to its owner, only in `GET` and `POST /api/claude-sign-in`.
- `name` on a `replace` attempt is ignored. `replace` naming an `api_key` credential is 400 "Only OAuth tokens can sign in again."; an unknown name is 404 "That credential was deleted."
- Precedence: the user lookup first (none → 404), then the `attemptId` (different → 409 `sign_in_replaced`). So a user who has an attempt of their own and sends someone else's id gets 409 about their own attempt and learns nothing about the other.
- **No body logging** on these routes (Fastify logs method and URL only, and none of these URLs carries data), and every error answer is a fixed constant (§6.3). The log redact list is not widened: `*.code` or `*.url` wildcards would censor `err.code` and `req.url` in every log line (D20).

### 5.6 Schema and service changes

- `credentials`: `expires_at timestamptz null`, `expiry_notified_at timestamptz null`, `rejected_at timestamptz null`.
- `CredentialService.create({ name, kind, value, expiresAt })`; the paste route passes `expiresAt: null`. `replaceById(id, value, { expiresAt })` (the name-based `replace` route resolves the id and calls it with `expiresAt: null`) sets `expires_at`, clears `expiry_notified_at`, `rejected_at` and `last_error`, restarts the active users when idle as today, and, when it cleared a set `expiry_notified_at`, publishes `inbox_changed` to every user so open panes refresh (AC8).
- `reverify`: a `rejected` verdict sets `rejected_at = now()` (and `last_error` as today); `ok` clears both; `unreachable` changes neither (Q6).
- `CredentialSummary` gains `expiresAt: string | null` and `rejected: boolean`. Display states are derived in the web from these and now, never stored (Q11).
- `messages.subject_credential_id text null references credentials(id) on delete cascade` (the notice disappears with its credential; its inbox items cascade from the message, D12). `messages_sender_kind_check` (migration 0009) already allows any subject on a `system` row. `createHumanMessage` accepts `subjectCredentialId` (and an optional `createdAt`) and requires a subject agent **or** a subject credential for `system` rows (its guard and error text change accordingly). The DB check doesn't forbid `subject_credential_id` on other kinds; `createHumanMessage` is its only writer and sets it only on `system` rows.
- `inbox_items.kind`: the migration drops and re-adds `inbox_items_kind_check` as `kind IN ('message','mention','task_event','credential')` (hand edit, M6; the stored `message` stays); `inboxItems.kind`'s `$type` and `createHumanMessage`'s `inboxKind` (DB names: `message | mention | task_event | credential`) and shared `INBOX_KINDS` (`notice | mention | task_event | credential`) gain it.

### 5.7 Expiry check (`credentials/expiry-check.ts`)

An in-memory interval, hourly, plus once after boot reconciliation, stopped at shutdown (the `uploads/sweep.ts` shape; no pg-boss). Each run:

1. Selects credentials with `expires_at is not null and expires_at <= now() + 14 days and expiry_notified_at is null`.
2. For each, one transaction: `update credentials set expiry_notified_at = now() where id = $1 and expiry_notified_at is null returning id`; when a row comes back, `createHumanMessage({ kind: "system", notice: "credential_expiring", subjectCredentialId, to: "all", inboxKind: "credential", body, urgent: false }, tx)`. Repeated runs, a boot race or two servers can't double it (Q4).
3. After commit, `publishToUser(userId, { type: "inbox_changed" })` for each addressee.

`body` is plain text used for previews, notifications and as the fallback: `"<name> expires on <date>."` or, when the check finds it already past (a factory that was off), `"<name> expired on <date>."`; the date is `YYYY-MM-DD` in the factory time zone (`FACTORY_TIMEZONE`). No token material. The pane and row render live from `expiresAt` instead (§8.6, D11). Users who sign up later don't get it (as `@humans` fan-out).

### 5.8 Inbox item shape

`inboxItemSchema` gains `credential?: { name: string; expiresAt: string | null; current: boolean }` and `link` gains `{ kind: "credential", name }`. `current` is true while `credentials.expiry_notified_at` equals the message's `created_at` (the expiry check writes one timestamp, taken once in JS, to both); a replace nulls it, so it turns false. `from` is `{ kind: "factory", name: "factory" }`, with no `about` (the UI reads `credential.name`). The inbox query left-joins `credentials` on `subject_credential_id`, and `toEntries` builds a credential entry first and skips the rest of its mapping, so such an item never falls through to the session link with an empty slug. I1's `GET /api/inbox` returns these in `items` (never chat rows).

## 6. Security

### 6.1 What holds a secret, and for how long

| Secret | Where it exists | Gone when |
|---|---|---|
| Sign-in URL (PKCE challenge, state) | PTY output buffer until parsed; the attempt object; the owner's `GET`/`POST` start responses; the owner's query cache and the link's `href` | The attempt ends; the panel unmounts |
| Code | One POST body; one local in `submit`; the PTY; the Code field until the submit's outcome | Written to the PTY, then dropped; the field clears after any outcome (R5) |
| Token | PTY output buffer until parsed; one local in the outcome function; the verifier's child env (as today); the vault-encrypted `value_enc` | The outcome function returns (memory); the encrypted row is today's storage |
| CLI config dir | `of-sign-in-*` (0700) | The CLI exits; every other exit path; boot sweep |

### 6.2 Where a secret could leak, and the guard

- **Logs.** The runner and store log fixed lines only (`sign-in started`, `sign-in ended: <reason>` with the user id and attempt id, never URL, code or token). No body logging; no new redact wildcards (D20). AC5's capture test.
- **Errors.** Every route error is a fixed constant (§6.3). Runner and transport errors are mapped to reasons, never wrapped; a caught child `Error` is discarded, not stringified.
- **Events and the database.** No session event, activity event or message carries attempt data. The notice body names the credential and a date only.
- **Process arguments.** argv is fixed (§5.1); the code goes through stdin. A `ps` on the host shows `python3 -I -S -c <script> /path/claude setup-token`.
- **Child environment.** The allow-list (§5.2).
- **Temp files and the keychain.** The config dir is the only place the CLI should write. Or's manual run (§11.3) checks that `setup-token` writes no token into it and adds or changes no macOS keychain item; either is a blocker: the PR is not merged until Or reports the check clean, because a keychain item persists (Q1 condition). The same run checks that `BROWSER=true` keeps the CLI from opening a browser on the host.
- **The UI.** The token never reaches the browser. The URL lives only in the link's `href` and the query cache, never on screen as text. The Code field is plain text with `autocomplete="one-time-code"` (so no password manager saves it) and is never put in a draft, the URL or a query cache (R5).
- **Another user, another tab.** Attempts are keyed by user id; the `attemptId` only routes within the caller's own attempt (§5.4).
- **Fixtures.** A test fails if any file under `__fixtures__` contains `sk-ant-oat01-` not followed by `SYNTHETIC` (§7.3).

### 6.3 Fixed messages (all ≤ 40 characters)

Shared `MSG` (server answers the web also shows): `signInCode` "Paste the code from the sign-in page." (37, field: Code), `signInCodeRejected` "Claude didn't accept that code." (31), `signInUnavailable` "Sign-in needs python3 on the server." (36), `signInStartFailed` "Couldn't start sign-in. Try again." (34), `signInBusy` "Too many sign-ins. Try again shortly." (37), `signInExpired` "Sign-in timed out. Start again." (31), `signInEnded` "Sign-in ended. Start again." (27, the attempt vanished on refetch without a local action, e.g. a server restart), `signInReplaced` "Sign-in restarted elsewhere." (28), `signInFailed` "Sign-in didn't finish. Start again." (35, `exchange_failed`), `signInNotFound` "No sign-in in progress." (23), `signInState` "Sign-in is already finishing." (29), `signInNameTaken` "That name was taken. Start again." (33, D9), `signInOAuthOnly` "Only OAuth tokens can sign in again." (36), and `credentialDeleted` "That credential was deleted." (28, moved here from web `FORM_MSG`). Existing constants are reused rather than duplicated: the verifier's `rejected` on a just-minted token answers with its own message, `FIELD_MSG.tokenRejected` "Claude rejected this token." (27), and an unreachable verifier after the retry with `FIELD_MSG.claudeUnreachable` "Couldn't reach Claude. Try again." (33, Q13). Web `FORM_MSG`: `signInOtherPanel` "Another sign-in is open; Start ends it." (39).

## 7. Tests and fixtures

### 7.1 Unit (no database)
- Parsers: §7.3's cases.
- Runner over an in-memory `PtyRun`: prompt across chunk boundaries; buffer bound; the code write then a separate `\r` after `settleMs`; code dropped; token across chunks; OAuth error; exit before token; timeouts; abort in every state; kill on every terminal state; no CLI text in any result.
- Bridge: the real `PTY_BRIDGE` running the fake CLI's `setup-token` mode end to end; stdin EOF, SIGTERM and SIGINT leave no CLI; SIGKILL of the bridge followed by the transport's fallback leaves no CLI (the fake writes its pid to `$FAKE_CLAUDE_DIR/setup-token.pid`; the check is `kill(pid, 0)` failing with `ESRCH`, not `pgrep` on a process title, which macOS `pgrep -f` doesn't see). Skipped with a message when `python3` is missing locally; **fails** when `CI` is set and `python3` is missing.
- `PTY_BRIDGE` has no `${` and no backtick.
- Host transport: exact spawn argv, env, `detached` and stdio; the dir is 0700 and removed on success (before verification), failure, kill and an exec failure; unavailable on `ENOENT`, non-zero probe and probe timeout.
- Store with an injected clock: one per user; `attemptId` mismatch 409 with the other run untouched; the cap; TTL and tombstone; TTL cleared by submit; start refused while exchanging; cancel; a new start ends the old; name validated before the code is written; 202 after 50 s and `/code/wait`; settled outcome kept 60 s; client disconnect; `endFor`; close-all.
- Web pure functions: `expiryState()` (tone by the exact `expiresAt <= now + 14 d` comparison, days counted by calendar day in the browser's zone, so a warning never says "15 days").

### 7.2 Server (Postgres, CI only)
- Routes end to end with the fake CLI as `FACTORY_CLAUDE_BIN`: create and replace through sign-in; `expires_at` = mint + 365 d; replace keeps id and assignments and calls `requestRestart`; replace by id after a delete-and-recreate fails; two users' isolation and one user's two tabs (AC6); the log-capture test at `trace` level, including that the bridge's stderr never reaches a log line (AC5); paste and API-key adds end the user's attempt.
- Expiry check: notifies once within 14 days, never for null `expires_at`; concurrent runs make one message; replace re-arms and publishes `inbox_changed`; delete cascades the notice; inbox item shape, `current` and link.
- `reverify` sets and clears `rejected_at`.

### 7.3 Parser fixtures
- **Synthetic fixture** `credentials/sign-in/__fixtures__/setup-token.SYNTHETIC.txt`, built from Paperclip's tested cases and **labelled synthetic in its first line and its file name**: the 2.1.205-shaped output (OSC 8 hyperlink, CHA-spaced words, the copy hint, the prompt with `>`), the 2.1.19-shaped hard-wrapped plain URL, and a success screen with a CR-joined, wrapped token. Every value is made up (`client_id` a fixed UUID, a fake 43-char challenge, `sk-ant-oat01-SYNTHETIC…`).
- **Cases:** both URL hosts; OSC 8 vs wrapped; repeated URL lines; copy hint; look-alike host, mixed case, punycode, `:443`, userinfo, fragment, duplicate key, missing key, wrong `redirect_uri`, a fifth extra key, `sk-ant-` in the URL or a decoded key; prompt on the wrong line or sharing prose; URL beyond 512 characters from the preamble; token outside the anchors, anchors twice or out of order, prose between them, wrong prefix, too short; OAuth error.
- **Recorded fixture (Or, manual, §11.3):** `setup-token.recorded-<version>.txt`, produced by the recording script with every secret already replaced in memory. The same tests run against every fixture in the folder; the synthetic one stays.
- **Guard:** the fixture test fails if any fixture contains `sk-ant-oat01-` not followed by `SYNTHETIC`, or a `code_challenge`/`state` value that isn't one of the synthetic values.

## 8. Web

Every apps/web task: implementer and reviewer invoke `vercel-react-best-practices` and follow it.

### 8.1 Add credential form (`features/settings/forms/add-credential-form.tsx`)

Fields, top to bottom, in `field-stack`:

1. **Name** (as today).
2. **Method**, a radio group (legend "Method"): **Sign in with Claude** (default), **Paste a token**, **Paste an API key**. The first two store `oauth_token`; the choice is UI state only (Q8). Switching keeps Name and each method's own value; the body swaps instantly. When `available` is false the default is Paste a token and the Sign in with Claude option is disabled with "Sign-in needs python3 on the server." as its help, so no footer ever shows a dead primary (R1).
3. The method's body:
   - **Sign in with Claude:** the sign-in panel (§8.2).
   - **Paste a token:** today's `TokenField` with help "Create one with `claude setup-token`. You won't be warned before it expires." (the note may wrap to two lines; it is help, not an error).
   - **Paste an API key:** today's `TokenField`.

**One primary at a time (R1).** With Sign in with Claude chosen and no attempt yet, the footer primary is **Start sign-in** (pending "Starting…"); submitting the form (Enter in Name included) starts the sign-in and runs **no** field checks (R8: Name is checked at the code submit, so the form calls `f.submit` only then). Once the panel is Ready the primary becomes **Sign in and add** (pending "Signing in…", then "Verifying…"). "Verifying…" appears only once the server has reported `verifying` (a 202 or a refetch); until then the label stays "Signing in…". For the paste methods it is **Verify and add** (pending "Verifying…"). The footer never shows a disabled primary standing in for a step the user can't take.

Cancel and dismissing (D13):
- **Settings inline:** Cancel ends the attempt (DELETE) and closes the form.
- **Sheet:** Close, Esc and the scrim keep the attempt (it lives until its deadline; reopening shows it); the panel's **Cancel sign-in** ends it.
- A successful paste or API-key add ends the caller's attempt server-side (§5.4).
- Settings → Credentials, on load, opens its inline add form when `GET` finds a `create` attempt in `awaiting_code`, `submitting`, `exchanging` or `verifying` (AC2), never for a `settled` one (§5.4).

### 8.2 The sign-in panel (`features/settings/sign-in/sign-in-panel.tsx`)

One component, used by Add credential and by the Sign in again sheet. It never reserves space for a later state; each state swaps instantly with no fade and no height transition (R1, R7).

- **Idle:** one line, "Sign in with your Claude account in the browser, then paste the code shown." (help text, not a message). After an attempt-ending error, the error replaces that line instead (crimson, with the alert icon, like a field note) and the footer primary reads **Start again**. (When `available` is false the option can't be chosen, §8.1; the Sign in again sheet shows the line in muted text with the alert icon and no primary.) If the first `GET` fails, the panel renders Idle with Start enabled; Start's own answer then decides.
- **Starting:** the footer primary reads "Starting…" with its spinner; the panel is unchanged.
- **Ready (`awaiting_code`)**, in this order:
  1. **Open sign-in page**, an outline button that is a real link (`<a href={url} target="_blank" rel="noopener noreferrer">`, external-link icon, Q10), and beside it a ghost icon button **Copy link** (`useCopy`/`CopyIcon`/`CopyFailed`: a check for 1.5 s, "Couldn't copy" inline when the clipboard API is missing, e.g. a factory on plain HTTP, where the link's own "Copy link address" still works). Under them, a muted line: "Opens claude.com in a new tab · Expires at 14:32", the host taken from the validated URL and the time from `codeDeadline` as a fixed clock time in the browser's locale (no countdown, no tooltip, D15).
  2. **Code**, a plain mono text field (`FieldShell`, help "Shown after you sign in."), `autocomplete="one-time-code"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck=false`, never stored in a draft (R5).
  3. A ghost **Cancel sign-in** (sheet frame and Sign in again only; inline uses the form's Cancel).
- **Exchanging / Verifying:** Code and Name become `readOnly` with `aria-disabled` (not a disabled fieldset, which would drop focus), Cancel sign-in is hidden (the server refuses it), the primary shows "Signing in…" then "Verifying…" with its spinner.

**Focus (Apple H2, Emil H4):** `FormFrame`/`InlineForm`'s autofocus of the first input on mount is turned off for this form while it restores an attempt (Ready from `GET`), so the rule below wins. When Ready arrives, focus moves to Open sign-in page (unless the user has moved focus elsewhere meanwhile) and a polite status says "Sign-in page ready."; activating Open sign-in page or a successful Copy link moves focus to Code (a failed copy keeps focus on Copy link, beside its "Couldn't copy"), so a paste lands there on return. After an attempt-ending error, focus moves to the footer primary (Start again).

**Errors** go through I4:
- Code format (400 `signInCode`): Code's field note; the attempt stays Ready.
- Name (400 `validation_error`, 409 `credential_exists`): Name's field note; the attempt stays Ready, so the code is not spent.
- Attempt-ending (`signInCodeRejected`, `signInExpired`, `signInEnded` (also any 404 `sign_in_not_found` after a submit that the credentials refetch doesn't explain), `signInReplaced`, `signInFailed`, the token-rejected and unreachable answers (`FIELD_MSG.tokenRejected`, `FIELD_MSG.claudeUnreachable`), `signInNameTaken`, `credentialDeleted`): the panel returns to Idle in the same commit with the message on its line (above), Name kept, the Code field cleared.
- Not attempt-ending (`signInBusy`, `signInStartFailed`, `signInState`): `FormOutcome`.

### 8.3 Attempt state in React

- `signInQueryOptions` (`["claude-sign-in"]`): `GET /api/claude-sign-in`, `staleTime: 2_000` (so a prefetch and the mount don't GET twice), `refetchOnWindowFocus: true`, **no polling** (Q2). Prefetched by the `add-credential` and `sign-in-again` sheet entries (`sheet-bodies.ts`, so `sheetIntent` preloads it) and, not awaited, by the credentials page loader, so a restored attempt never flashes Idle first; the panel renders once it has resolved.
- Start, code, wait and cancel are plain async handlers with a pending state (the repo pattern), not mutations; on success they write the attempt into the query cache with `setQueryData` instead of refetching. The code lives only in the hook's state and is cleared after any outcome. The wait is one abortable loop per attempt (backoff 1/2/5 s), shared by every panel in the tab; its query updates and invalidations run even if the panel unmounted, and only the toast and `onDone` need a mounted panel.
- **Disappearance (Emil H3, Break #8):** the panel remembers the `attemptId` it showed. When a refetch returns no attempt or another `attemptId` without a local action, it shows `signInExpired` if now ≥ `codeDeadline`, `signInReplaced` for another id, else `signInEnded`, and goes to Idle. One `setTimeout` to `codeDeadline` (cleared on unmount and state change; no ticking) refetches `GET` for a Ready panel when it fires, and the disappearance rule above then decides (a browser clock running fast only causes an early refetch).
- **Waiting:** on 202, a network error or a 5xx from code, the panel joins the tab's wait loop until it gets an outcome; a reload that finds `exchanging`, `verifying` or `settled` does the same once on mount. The loop belongs to the tab, not the panel: unmounting a panel doesn't stop it; it ends at a final answer, at Cancel, or on sign-out, which also clears the tab's record of which attempts it submitted, so a second user on the same tab inherits nothing.
- **Purpose mismatch:** an Add credential panel that finds a `replace` attempt, or a Sign in again panel that finds a `create` attempt or a `replace` attempt for another credential name, shows Idle with `FORM_MSG.signInOtherPanel` as its line; Start ends the other attempt.
- On a successful create: today's `onDone` path (Settings upsert and "Added <name>."; the stacked sheet's `completeChild`). On replace: §8.5.

### 8.4 Credential row (`credentials-section.tsx`)

- `ExpiryLine` beside `VerificationState`, derived from `expiresAt` and now by `expiryState()` (R4, Q11):
  - more than 14 days: "Expires Nov 2027" (month and year in the browser's locale), muted;
  - within 14 days: "Expires in 9 days" ("Expires tomorrow", "Expires today"), warning tone with the alert icon, followed by a small ghost **Sign in again**;
  - past: "Expired 12 Nov 2027", crimson with the icon, followed by **Sign in again**; `VerificationState` then shows its muted form (or nothing when its last check failed), so one fact isn't said twice in crimson;
  - null `expiresAt` (pasted, API keys): nothing.
- A rejected credential (`rejected`, not expired): `VerificationState` reads "Last check failed: Claude rejected this token." followed by the ghost **Sign in again** (OAuth only).
- Sign in again sits at the end of its fact line, a ghost button inside the row's text column (R3; DESIGN.md's ghost-in-section rule, no amendment). The actions stay Verify (outline) and ⋯; the actions group gains `flex-wrap justify-end` as a safety net at 320 px and 200% text.
- The ⋯ menu has **Sign in again** for every `oauth_token` credential, above Replace token (an overlay opener, like Delete). Every entry opens the Sign in again sheet.
- The delete dialog's "create a new one with `claude setup-token`" becomes "add it again with Sign in with Claude"; the Kind radio label that named `claude setup-token` is replaced by the Method choice (§8.1).
- Dates use the browser locale (`Nov 2027`, `12 Nov 2027` in en-GB).

### 8.5 Sign in again sheet

A new top-level sheet kind `{ kind: "sign-in-again"; name: string }` (sheet store and `sheet-bodies.ts`, D14), titled "Sign in again" with the credential name as a mono `SheetDescription` (a small host change: top-level sheets may carry a description). Body: the sign-in panel with `purpose: replace`; no Name or Method. Primary: Start sign-in, then **Sign in and replace** ("Signing in…", "Verifying…"). On success the sheet closes with one toast, "Signed in again: <name>." plus the restart note built with `cappedList` when agents use it (the control that caused it is gone, DESIGN.md toasts), the credentials list refetches and the inbox queries are invalidated. Opened from the row, the ⋯ menu and the Inbox pane; a bottom drawer on phones.

### 8.6 Inbox

Every place that branches on `link.kind` or renders `about` as an `@handle` gains a `credential` branch, named by function because I1 moves the lines: `inbox/api.ts` (link mapping), `inbox-row.tsx` (the row `Link`, `SenderLine`, the accessible-name `labelOf`), `inbox-pane.tsx` (`OpenLink`, `Sender`, the pane body switch, `prefetchPane`, `onOpen`), `notifications.ts` (`notificationTitle`, the click target), and the server's `toEntries` in `agents/event-store.ts` (which would otherwise fall through to a session link with an empty slug). Credential items carry no `about`; the UI reads `credential.name`.

- **Row:** line one "Factory about `<name>`" (the existing `about` pattern, mono name, truncating); line two the live state from `credential.expiresAt` via `expiryState()`, "Expires in 9 days" or "Expired 12 Nov 2027", warning or crimson with its icon, never truncated (like `StatusLabel` for task events); once `current` is false, "Signed in again" muted. Accessible name "Unread, Factory, <name> expires in 9 days, <time>" (or "expired"). Below 1024 px the row links to `/settings/credentials?credential=<name>`.
- **Pane:** the header's `OpenLink` slot reads **Open credentials** (outline, like Open task). The body (`CredentialContent`): the live fact as text ("personal expires on 12 Nov 2027." / "personal expired on 12 Nov 2027."), then **Sign in again** (outline), or "Already signed in again." when `current` is false. No reply composer.
- **Notifications** (`useInboxNotifier`): title "Credential expiring" or "Credential expired", body the stored preview; click opens `/settings/credentials?credential=<name>`. I8's desktop notification reuses this.
- **`?credential=<name>`** on the credentials page (`routes/_app/settings.credentials.tsx` gains `validateSearch`) takes the deep-link arrival treatment, reusing `arrive(el)` and `useArrivalTint` from `lib/use-arrival.ts`, the one copy of the arrival extracted from the session timeline and I1's Chat, which both move to it (one section-level call that finds the row, scrolls it to the centre, then `arrive` focuses it without scrolling, fires once and then clears `?credential`, also when no row matches): the row scrolls to the centre, takes focus with the inset ring and holds the 6% signal tint for 2 s of visible time, fading over 300 ms (DESIGN.md amendment, §12); focus goes to its Sign in again when shown.

## 9. I8 hooks

I8's first-run step **Sign in to Claude** opens Add credential (Sign in with Claude is already the default); `add-credential` is a child-only sheet kind today (`sheet-store.ts`), so I8 adds a top-level kind for it, and its desktop notification for "a credential about to expire" fires on the `credential` inbox item. Nothing else is needed from I3.

## 10. UI review outcome

The Apple, Emil design-eng and Break UI reviews changed: a rejected code is attempt-ending, not a Code note; focus moves to Open sign-in page and then Code; no reserved Ready height (one primary at a time); no visible URL; deadlines as fixed clock times; Sign in again on the fact line; plain one-time-code field; the Inbox's credential branches; live dates in the pane; the deep-link arrival on settings rows; multi-tab `attemptId`. The evidence pass (§11.2) checks them.

## 11. Evidence and manual steps

### 11.1 Fake CLI
`packages/harness/testing/fake-claude.mjs` gains a `setup-token` mode (argv `setup-token`): it requires a TTY on stdin (`process.stdin.isTTY`, else exits 1 with "Raw mode is not supported", like Ink), prints the welcome line, the preamble and a **synthetic** URL as an OSC 8 hyperlink with CHA-spaced words, the copy hint and the prompt, then reads stdin in raw mode until a separate `\r`: code `bad` prints `OAuth error: Invalid code` and waits; code `slow` waits 70 s; anything else prints the success screen with a synthetic `sk-ant-oat01-SYNTHETIC…` token wrapped at the window width, CR-joined, and exits 0. In `setup-token` mode it writes its pid to `$FAKE_CLAUDE_DIR/setup-token.pid` (the wrapper `createFakeClaude` writes already exports that dir), so checks never match a real `claude` session on the machine; the branch runs before the fake reads `FAKE_CLAUDE_SCENARIO` and before its env logging, never falls through to the scenario code, and never logs stdin. AC4's checks use that pid (`kill(pid, 0)` fails with `ESRCH`). The fake's verification turn accepts the synthetic token. It never contacts the network.

### 11.2 Browser evidence (last plan tasks)
Through `docs/product/ui-review/u4-evidence/harness` (main checkout) and the lock its `run.sh` takes, with `FACTORY_CLAUDE_BIN` = the fake (never the real CLI; the harness fake routes `setup-token` to the repo fake's mode). No other lock. Chromium and WebKit headless: AC1 (sign in, an agent starts), AC2 (reopen after a reload, mid-attempt and mid-exchange), AC3 (a 20 s TTL), AC4 (Cancel sign-in, then `pgrep` for the fake), AC6's two-tab case, AC9 (row states seeded through the DB, 320 px at 200% text), AC10 (`python3` hidden from `PATH`), the Inbox row, pane and Sign in again (AC8), focus after Ready and after Open sign-in page; at 1440×900 and 390×844, light and dark.

### 11.3 For Or (manual; not automatable)
1. **Record the real CLI transcript.** Run `pnpm --filter @open-factory/server sign-in:record` (a script in the plan): it runs `claude setup-token` through `PTY_BRIDGE`, prints only the sign-in URL for you to open and reads the code from your terminal, and **before anything touches disk** replaces the URL's query values, the code echo and the token with synthetic values of identical length (keeping every control sequence and wrap), then writes `setup-token.recorded-<version>.txt` into `~/open-factory-sign-in-recording/` (outside the repo; the directory is created with mode 0700 and the file with mode 0600) and prints that path. If the redaction check (no `sk-ant-oat01-` not followed by `SYNTHETIC`) fails, it writes nothing and prints only "Redaction check failed; nothing written." Copy that file into `__fixtures__` and run the parser tests; the fixture guard fails if anything real slipped through. Revoke the token afterwards in claude.ai settings if you won't use it.
2. **Check the config dir and the keychain.** The same script, before removing the temp dir, prints `ls -la` of it and the names (never contents) of files containing `sk-ant-oat01`. Separately, diff `security dump-keychain | grep -i 'claude code'` (no `-d`, so no secret is printed) before and after, which also catches a service name suffixed for a custom config dir. A file holding the token or a new or changed keychain item is a blocker: the PR (opened ready for review) is not merged until Or reports this check clean (a keychain item persists after the run). Also note whether a browser tab opened on its own (it shouldn't, with `BROWSER=true`).
3. **One real sign-in** through the UI on your factory: Add credential → Sign in with Claude, and one Sign in again on that credential. Confirm the credential verifies, an agent starts on it, and `grep` of the server log for `sk-ant-`, `oauth/authorize` and the code finds nothing.

## 12. Product docs and DESIGN.md

- **ADR 0027:** amendment note: "Host only. `claude setup-token` runs through a python3 PTY bridge on the host, the same host `claude` verification uses; no container path, because the token belongs to the account and verification already needs the host CLI (I3 Q1). Pasted tokens have no expiry date (Q5)."
- **`concepts/credential.md`:** Sign in with Claude; `expires_at` (signed in: mint + 1 year; pasted: unknown, never warned); the 14-day notice; Sign in again replaces in place; `rejected_at` from Verify. The rejected-token copy "Create a new one with `claude setup-token`" and the delete line "the token is shown once by `claude setup-token`" become "sign in again to get a new one". A line on revoking an unused minted token in claude.ai settings.
- **`behavior/administration.md` → Credentials:** the method choice, the panel, one primary at a time, the row's expiry line and Sign in again, the 10-minute attempt, Cancel sign-in.
- **`behavior/inbox.md`:** the `credential` item kind from `@factory`, with Sign in again in the pane.
- **`architecture/data-model.md`:** the new columns and the CHECK change.
- **I3 task spec:** strike "inside a throwaway base-image container…", "unless the user enters it" and "the URL with a copy button"; replace "I already have a token" with the method choice.
- **DESIGN.md amendments:**
  1. **Rows → deep-link arrival** (all three UI reviews): "A row reached by a deep link (a timeline row, or a settings row via `?<kind>=<name>`) scrolls to the centre, takes focus with the inset ring and holds the 6% signal tint for 2 s of visible time, fading over 300 ms. The selected fill stays for a row shown in a pane or peek."
  2. **Inputs → one-time codes** (R5): "A one-time code is a plain text field (`autocomplete="one-time-code"`, no autocapitalise, autocorrect or spellcheck). Masked fields with the reveal eye are for long-lived secrets: tokens, keys and secret values."
  3. **Forms → one primary at a time** (R1): "When a form needs one prerequisite step first (Start sign-in), its primary button is that step until it completes; the footer never shows a disabled primary beside the step's own button."
  4. **Motion → Live rows**, a sentence beside "waiting lines keep fixed times": "A deadline shows as a fixed clock time ('Expires at 14:32'), never a relative duration that goes stale."

## 13. Decisions

Q1–Q13 and R1–R8 with the proxy's answers and certainty are in the decision issue. Tech-lead decisions:

- **D1** The runner talks to a `PtyRun` interface, rather than spawning, so the state machine is unit-tested without a process and the bridge is tested once on its own.
- **D2** The bridge is a `String.raw` constant in a `.ts` file (R6), rather than a `.py` import, because `pnpm dev` runs the server through `tsx`, which can't import `.py`, and the bundle would need a copy step; argv stays free of user input.
- **D3** A 200×50 window set in the child before exec, rather than the PTY's zero size or a parent-side set that races the child, because Ink wraps at the window width; the parser still de-wraps.
- **D4** `HOME` = `CLAUDE_CONFIG_DIR` = the temp dir, rather than the server user's home, so the CLI can't read or write the host user's Claude state.
- **D5** The code is stripped of all whitespace and limited to printable ASCII, rather than passed as typed, because a pasted newline would submit early and a control character could drive the terminal.
- **D6** Start resolves only after the URL validated (≤ 30 s), rather than returning at once, so the UI never shows a URL that failed validation and needs no polling (Q2, Q10).
- **D7** The outcome promise belongs to the store, kept 60 s after it settles, rather than to the request, so a reload or a lost connection still gets the result and a closed tab never cancels the save.
- **D8** The TTL governs only the wait for the code, and Cancel and a new Start are refused once the code is submitted, rather than killing the exchange, because the code is spent and the save is seconds away.
- **D9** A name taken by a race after the pre-check fails the attempt, rather than picking another name, because the user chose the name.
- **D10** `expires_at` = the time the token was parsed + 365 days, the nearest point to the mint; healthy rows show month precision (R4).
- **D11** The stored notice body is used only for previews and notifications; the pane and row render from the live `expiresAt` in the browser's zone, so one fact never shows two dates.
- **D12** `subject_credential_id` cascades on delete, rather than nulling, so a deleted credential's notice disappears instead of pointing at nothing.
- **D13** Dismissing the sheet keeps the attempt until its deadline, rather than cancelling, so a user who closed it to look something up returns to the same link; Cancel sign-in and inline Cancel end it.
- **D14** Sign in again is a top-level sheet kind, rather than a child sheet, because it is opened from Settings and the Inbox, never over another form.
- **D15** No ticking countdown; the deadline is a fixed clock time, because a static "10 minutes" goes stale after a reload and a ticking number draws the eye.
- **D16** (replaced by R1) No reserved Ready height: one primary at a time, and the panel grows when Ready arrives.
- **D17** Attempts carry a random, non-secret `attemptId` checked after the user lookup, rather than user-only keying, so a second tab of the same user can't push a code into another tab's run.
- **D18** `/code` and `/code/wait` answer 202 after 50 s and the client waits again, rather than one long request, so a proxy timeout never shows a failure while the save lands.
- **D19** The routes live under `/api/claude-sign-in`, rather than `/api/credentials/sign-in`, which would shadow a credential named `sign-in`.
- **D20** No new log-redact wildcards, rather than `*.code`/`*.url`, which would censor `err.code` and `req.url` in every log line; the guarantee is no body logging plus fixed error text, proven by AC5's capture test.
