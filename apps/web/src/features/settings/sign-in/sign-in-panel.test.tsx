import { type AttemptView, type CredentialSummary, MSG } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormOutcome, useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { FORM_MSG } from "@/lib/form-messages";
import { signInQueryOptions } from "./api";
import { SignInPanel } from "./sign-in-panel";
import { resetSignIn, SIGN_IN_HELP, useSignIn, waitUntilDone } from "./use-sign-in";

// Synthetic values only: no real sign-in URL, code or token ever appears in a test.
const SYN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&state=SYNTHETIC";
const SYN_CODE = "SYNTHETIC-code#SYNTHETIC-state";
// The server's FIELD_MSG (apps/server/src/field-messages.ts): the web shows the answer's own message.
const TOKEN_REJECTED = "Claude rejected this token.";
const UNREACHABLE = "Couldn't reach Claude. Try again.";
const soon = () => new Date(Date.now() + 9 * 60_000).toISOString();

const ready = (o: Partial<AttemptView> = {}): AttemptView => ({
  attemptId: "a1",
  state: "awaiting_code",
  url: SYN_URL,
  codeDeadline: soon(),
  purpose: "create",
  ...o,
});
// /code, /code/wait and their 409 extra never carry the url (controller ruling 1).
const working = (state: AttemptView["state"], o: Partial<AttemptView> = {}): AttemptView => ({
  attemptId: "a1",
  state,
  purpose: "create",
  ...o,
});
const cred = (o: Partial<CredentialSummary> = {}): CredentialSummary => ({
  name: "work",
  kind: "oauth_token",
  lastVerifiedAt: "2026-11-23T12:00:00Z",
  lastError: null,
  expiresAt: "2027-11-23T12:00:00Z",
  rejected: false,
  usedBy: [],
  archivedUsedBy: [],
  rateLimit: null,
  ...o,
});
const apiErr = (status: number, code: string, message: string, extra: object = {}) =>
  new Response(JSON.stringify({ error: { code, message, ...extra } }), {
    status,
    headers: { "content-type": "application/json" },
  });
const ok = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

type Call = { method: string; url: string; body: unknown; signal?: AbortSignal | null };
type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);
/** Each route answers its queued replies in order, then repeats the last one. A thrown TypeError is a network error. */
let calls: Call[] = [];
let routes: Record<string, Reply[]> = {};
function route(key: string, ...replies: Reply[]) {
  routes[key] = replies;
}
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;
const GET = "GET /api/claude-sign-in";
const START = "POST /api/claude-sign-in";
const CODE = "POST /api/claude-sign-in/code";
const WAIT = "POST /api/claude-sign-in/code/wait";

beforeEach(() => {
  resetSignIn();
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body, signal: init?.signal });
      const key = `${method} ${url}`;
      const queue = routes[key] ?? routes[`${method} ${url.replace(/\/[^/]+$/, "/:id")}`];
      if (!queue || queue.length === 0) return apiErr(404, "not_found", url);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const r = typeof next === "function" ? next() : next;
      const res = await r;
      return res instanceof Response ? res.clone() : res;
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSignIn();
});

const newClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });

function Host({
  purpose = "create",
  name,
  frame = "sheet",
  onDone,
}: {
  purpose?: "create" | "replace";
  name?: string;
  frame?: "inline" | "sheet";
  onDone: (c: CredentialSummary) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [credName, setCredName] = useState("work");
  const f = useFieldErrors<"name" | "value" | "code">({
    form: formRef,
    fields: ["name", "value", "code"],
    checks: {},
  });
  const o = useOutcome();
  const s = useSignIn({ purpose, ...(name ? { name } : {}), fields: f, outcome: o, onDone });
  const busy = s.phase === "exchanging" || s.phase === "verifying";
  const label =
    s.pendingLabel ??
    (s.phase === "ready"
      ? "Sign in and add"
      : s.line?.tone === "error"
        ? "Start again"
        : "Start sign-in");
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (s.pendingLabel) return;
        if (s.phase === "ready") void s.submit(credName);
        else void s.start();
      }}
    >
      <label htmlFor="n">Name</label>
      <input
        id="n"
        value={credName}
        onChange={(e) => setCredName(e.target.value)}
        readOnly={busy}
        aria-disabled={busy || undefined}
        aria-invalid={f.errors.name ? true : undefined}
      />
      <p data-testid="name-note">{f.errors.name ?? ""}</p>
      <SignInPanel s={s} frame={frame} codeRef={codeRef} />
      <FormOutcome outcome={o.outcome} />
      <button type="submit">{label}</button>
    </form>
  );
}

function renderHost(
  props: Partial<Parameters<typeof Host>[0]> = {},
  qc = newClient(),
  opts: { strict?: boolean; twice?: boolean } = {},
) {
  const onDone = props.onDone ?? vi.fn();
  const tree = (
    <QueryClientProvider client={qc}>
      <Host onDone={onDone} {...props} />
      {opts.twice ? <Host onDone={onDone} {...props} /> : null}
    </QueryClientProvider>
  );
  const r = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...r, qc, onDone };
}
const panel = () => document.querySelector<HTMLElement>("[data-sign-in-panel]") as HTMLElement;
const codeBox = () => screen.getByRole("textbox", { name: "Code" });
const primary = () =>
  document.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;

async function toReady(props: Partial<Parameters<typeof Host>[0]> = {}, attempt = ready()) {
  route(GET, ok({ available: true, attempt }));
  const r = renderHost(props);
  await screen.findByRole("link", { name: "Open sign-in page" });
  return r;
}
async function typeCodeAndSubmit() {
  fireEvent.change(codeBox(), { target: { value: SYN_CODE } });
  fireEvent.click(primary());
}

it("idle shows the help line and no Start button inside the panel (one primary, R1)", async () => {
  route(GET, ok({ available: true, attempt: null }));
  renderHost();
  expect(await screen.findByText(SIGN_IN_HELP)).toBeInTheDocument();
  expect(within(panel()).queryByRole("button")).toBeNull();
  expect(within(panel()).queryByRole("link")).toBeNull();
  expect(primary()).toHaveTextContent("Start sign-in");
});

it("ready renders a real link, Copy link and the host + fixed deadline line; no URL text on screen (R2)", async () => {
  route(
    GET,
    ok({ available: true, attempt: ready({ url: SYN_URL, codeDeadline: "2026-11-23T14:32:00Z" }) }),
  );
  renderHost();
  const link = await screen.findByRole("link", { name: "Open sign-in page" });
  expect(link).toHaveAttribute("href", SYN_URL);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  expect(screen.getByText(/Opens claude\.com in a new tab · Expires at/)).toBeInTheDocument();
  expect(screen.queryByText(SYN_URL)).toBeNull();
  expect(document.body.textContent).not.toContain("oauth/authorize");
});

it("focus moves to Open sign-in page when Ready arrives, then to Code after the link is used", async () => {
  route(GET, ok({ available: true, attempt: null }));
  route(START, ok({ attempt: ready() }));
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  renderHost();
  await screen.findByText(SIGN_IN_HELP);
  primary().focus();
  fireEvent.click(primary());
  const link = await screen.findByRole("link", { name: "Open sign-in page" });
  await waitFor(() => expect(link).toHaveFocus());
  expect(panel().querySelector('[role="status"]')).toHaveTextContent("Sign-in page ready.");
  // Activating the link (a click; the default opens a new tab) moves focus to Code.
  link.addEventListener("click", (e) => e.preventDefault(), { once: true });
  fireEvent.click(link);
  expect(codeBox()).toHaveFocus();
  // A successful Copy link does too.
  screen.getByRole("button", { name: "Copy link" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(codeBox()).toHaveFocus());
  expect(writeText).toHaveBeenCalledWith(SYN_URL);
});

it("a failed Copy link keeps focus on Copy link beside Couldn't copy", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  await toReady();
  const btn = screen.getByRole("button", { name: "Copy link" });
  btn.focus();
  fireEvent.click(btn);
  expect(await screen.findByText("Couldn't copy")).toBeInTheDocument();
  expect(btn).toHaveFocus();
});

it("the Code field is plain text with one-time-code autocomplete and never a password field (R5)", async () => {
  await toReady();
  const c = codeBox();
  expect(c).toHaveAttribute("type", "text");
  expect(c).toHaveAttribute("autocomplete", "one-time-code");
  expect(c).toHaveAttribute("autocapitalize", "none");
  expect(c).toHaveAttribute("autocorrect", "off");
  expect(c).toHaveAttribute("spellcheck", "false");
  expect(c).toHaveClass("font-mono");
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(screen.getByText("Shown after you sign in.")).toBeInTheDocument();
});

it("a rejected code returns to Idle with the error on the line and focus on the primary", async () => {
  await toReady();
  route(CODE, apiErr(422, "sign_in_code_rejected", MSG.signInCodeRejected));
  await typeCodeAndSubmit();
  expect(await within(panel()).findByText(MSG.signInCodeRejected)).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Open sign-in page" })).toBeNull();
  expect(primary()).toHaveTextContent("Start again");
  await waitFor(() => expect(primary()).toHaveFocus());
  expect(calls.find((c) => c.url === "/api/claude-sign-in/code")?.body).toEqual({
    attemptId: "a1",
    code: SYN_CODE,
    name: "work",
  });
});

it("every attempt-ending answer lands on the line, a fixed constant", async () => {
  for (const [status, code, message, shown] of [
    [410, "sign_in_expired", MSG.signInExpired, MSG.signInExpired],
    [409, "sign_in_replaced", MSG.signInReplaced, MSG.signInReplaced],
    [502, "sign_in_failed", MSG.signInFailed, MSG.signInFailed],
    [422, "sign_in_token_rejected", TOKEN_REJECTED, TOKEN_REJECTED],
    [502, "claude_unreachable", UNREACHABLE, UNREACHABLE],
    [409, "sign_in_name_taken", MSG.signInNameTaken, MSG.signInNameTaken],
    [404, "credential_not_found", "server text", MSG.credentialDeleted],
  ] as const) {
    resetSignIn();
    const r = await toReady();
    route(CODE, apiErr(status, code, message));
    route("GET /api/credentials", ok({ credentials: [] }));
    await typeCodeAndSubmit();
    expect(await within(panel()).findByText(shown)).toBeInTheDocument();
    expect(shown.length).toBeLessThanOrEqual(40);
    r.unmount();
  }
});

it("name errors stay on Name and keep Ready", async () => {
  await toReady();
  route(
    CODE,
    apiErr(409, "credential_exists", "A credential named work already exists."),
    apiErr(400, "validation_error", MSG.nameLength, { fields: { name: MSG.nameLength } }),
  );
  await typeCodeAndSubmit();
  await waitFor(() =>
    expect(screen.getByTestId("name-note")).toHaveTextContent(FORM_MSG.nameTaken),
  );
  expect(screen.getByRole("link", { name: "Open sign-in page" })).toBeInTheDocument();
  expect(screen.queryByText(/already exists/)).toBeNull();
  await typeCodeAndSubmit();
  await waitFor(() => expect(screen.getByTestId("name-note")).toHaveTextContent(MSG.nameLength));
  expect(primary()).toHaveTextContent("Sign in and add");
});

it("a code format error goes on Code and keeps Ready", async () => {
  await toReady();
  route(
    CODE,
    apiErr(400, "validation_error", MSG.signInCode, { fields: { code: MSG.signInCode } }),
  );
  await typeCodeAndSubmit();
  expect(await screen.findByText(MSG.signInCode)).toBeInTheDocument();
  expect(codeBox()).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("link", { name: "Open sign-in page" })).toBeInTheDocument();
});

describe("an attempt that disappears shows Sign-in timed out after the deadline, Sign-in ended before it, restarted elsewhere for another id", () => {
  it("gone before the deadline: Sign-in ended", async () => {
    const r = await toReady();
    route(GET, ok({ available: true, attempt: null }));
    await act(() => r.qc.refetchQueries({ queryKey: signInQueryOptions.queryKey }));
    expect(await within(panel()).findByText(MSG.signInEnded)).toBeInTheDocument();
  });
  it("another id: restarted elsewhere", async () => {
    const r = await toReady();
    route(GET, ok({ available: true, attempt: ready({ attemptId: "a2" }) }));
    await act(() => r.qc.refetchQueries({ queryKey: signInQueryOptions.queryKey }));
    expect(await within(panel()).findByText(MSG.signInReplaced)).toBeInTheDocument();
  });
  it("past the deadline: the timer refetches and finds it gone, Sign-in timed out", async () => {
    route(
      GET,
      ok({
        available: true,
        attempt: ready({ codeDeadline: new Date(Date.now() + 150).toISOString() }),
      }),
      ok({ available: true, attempt: null }),
    );
    renderHost();
    expect(await within(panel()).findByText(MSG.signInExpired)).toBeInTheDocument();
  });
});

it("the deadline timer refetches once, no interval", async () => {
  const deadline = new Date(Date.now() + 150).toISOString();
  route(GET, ok({ available: true, attempt: ready({ codeDeadline: deadline }) }));
  renderHost();
  await screen.findByRole("link", { name: "Open sign-in page" });
  expect(count(GET)).toBe(1);
  await waitFor(() => expect(count(GET)).toBe(2));
  await new Promise((r) => setTimeout(r, 400));
  expect(count(GET)).toBe(2);
});

it("202 then waitUntilDone with 1/2/5 s backoff; retries only on network and http_ errors, never on a coded error", async () => {
  vi.useFakeTimers();
  const qc = newClient();
  route(
    WAIT,
    ok({ attempt: working("exchanging") }, 202),
    () => {
      throw new TypeError("Failed to fetch");
    },
    new Response("<html>bad gateway</html>", { status: 502 }),
    apiErr(500, "internal_error", "Internal error"),
    ok({ credential: cred() }, 201),
  );
  const done = waitUntilDone(qc, "a1");
  expect(waitUntilDone(qc, "a1")).toBe(done); // one loop per id
  await vi.advanceTimersByTimeAsync(0);
  expect(count(WAIT)).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(count(WAIT)).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(count(WAIT)).toBe(2); // network error → 2 s
  await vi.advanceTimersByTimeAsync(2000);
  expect(count(WAIT)).toBe(3); // http_502 → 5 s
  await vi.advanceTimersByTimeAsync(4999);
  expect(count(WAIT)).toBe(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(count(WAIT)).toBe(4); // internal_error → 5 s (capped)
  await vi.advanceTimersByTimeAsync(5000);
  expect(count(WAIT)).toBe(5);
  await expect(done).resolves.toEqual({ ok: true, credential: cred() });

  // A coded error is the outcome: no retry.
  calls = [];
  route(WAIT, apiErr(502, "sign_in_failed", MSG.signInFailed));
  const failed = await (async () => {
    const p = waitUntilDone(qc, "a9");
    await vi.advanceTimersByTimeAsync(30_000);
    return p;
  })();
  expect(failed.ok).toBe(false);
  expect(count(WAIT)).toBe(1);
});

it("unmount does not abort the loop; the loop stops at its final answer, and resetSignIn() aborts it (no request after)", async () => {
  const r = await toReady();
  const first = deferred();
  route(CODE, ok({ attempt: working("exchanging") }, 202));
  route(WAIT, () => first.promise);
  await typeCodeAndSubmit();
  await waitFor(() => expect(count(WAIT)).toBe(1));
  const signal = calls.find((c) => c.url.endsWith("/code/wait"))?.signal;
  r.unmount();
  expect(signal?.aborted).toBe(false);
  // The final answer ends it: nothing after.
  await act(async () => first.resolve(apiErr(502, "sign_in_failed", MSG.signInFailed)));
  await new Promise((res) => setTimeout(res, 50));
  expect(count(WAIT)).toBe(1);

  // A loop still waiting is aborted by resetSignIn(), and no request follows.
  vi.useFakeTimers();
  const qc = newClient();
  route(WAIT, ok({ attempt: working("exchanging") }, 202));
  const p = waitUntilDone(qc, "a5");
  await vi.advanceTimersByTimeAsync(0);
  const before = count(WAIT);
  resetSignIn();
  await expect(p).resolves.toEqual({ ok: "aborted" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(count(WAIT)).toBe(before);
});

it("resetSignIn() clears submitted-here: after it, a settled success for that id is not shown", async () => {
  const r = await toReady();
  const w = deferred();
  route(CODE, ok({ attempt: working("exchanging") }, 202));
  route(WAIT, () => w.promise);
  await typeCodeAndSubmit();
  await waitFor(() => expect(count(WAIT)).toBe(1));
  act(() => resetSignIn()); // sign-out
  r.unmount();
  // The next user's panel on this tab finds the settled attempt and asks once: the success is not theirs to show.
  route(GET, ok({ available: true, attempt: working("settled") }));
  route(WAIT, ok({ credential: cred() }, 201));
  const again = renderHost();
  await waitFor(() => expect(count(WAIT)).toBe(2));
  await waitFor(() => expect(screen.getByText(SIGN_IN_HELP)).toBeInTheDocument());
  expect(again.onDone).not.toHaveBeenCalled();
  expect(r.onDone).not.toHaveBeenCalled();
});

it("one loop under StrictMode and with a second panel (in-flight Map reused)", async () => {
  route(GET, ok({ available: true, attempt: ready() }));
  const w = deferred();
  route(CODE, ok({ attempt: working("exchanging") }, 202));
  route(WAIT, () => w.promise);
  const onDone = vi.fn();
  const qc = newClient();
  const r = renderHost({ onDone }, qc, { strict: true });
  await screen.findByRole("link", { name: "Open sign-in page" });
  await typeCodeAndSubmit();
  await waitFor(() => expect(count(WAIT)).toBe(1));
  // A second panel mounts while the code is being exchanged: it joins the same loop.
  r.rerender(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <Host onDone={onDone} />
        <Host onDone={onDone} />
      </QueryClientProvider>
    </StrictMode>,
  );
  await new Promise((res) => setTimeout(res, 30));
  expect(count(WAIT)).toBe(1);
  await act(async () => w.resolve(ok({ credential: cred() }, 201)));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  await new Promise((res) => setTimeout(res, 30));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(count(WAIT)).toBe(1);
});

it("submit, unmount, the outcome lands, remount: success is shown exactly once; credentials and inbox were invalidated while unmounted (H1)", async () => {
  const r = await toReady();
  const invalidate = vi.spyOn(r.qc, "invalidateQueries");
  const w = deferred();
  route(CODE, ok({ attempt: working("exchanging") }, 202));
  route(WAIT, () => w.promise);
  await typeCodeAndSubmit();
  await waitFor(() => expect(count(WAIT)).toBe(1));
  r.unmount();
  await act(async () => w.resolve(ok({ credential: cred() }, 201)));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["credentials"] }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] });
  expect(r.onDone).not.toHaveBeenCalled();
  // Remount: the settled attempt is joined once and the success shown once, by this tab.
  route(WAIT, ok({ credential: cred() }, 201));
  const onDone = vi.fn();
  const again = renderHost({ onDone }, r.qc);
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(onDone).toHaveBeenCalledWith(cred());
  again.unmount();
  renderHost({ onDone }, r.qc);
  await screen.findByText(SIGN_IN_HELP);
  await new Promise((res) => setTimeout(res, 30));
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("a settled success is rendered only by the tab that submitted", async () => {
  route(GET, ok({ available: true, attempt: working("settled") }));
  route(WAIT, ok({ credential: cred() }, 201));
  const r = renderHost();
  await waitFor(() => expect(count(WAIT)).toBe(1));
  await screen.findByText(SIGN_IN_HELP);
  expect(r.onDone).not.toHaveBeenCalled();
});

it("a reload during the exchange shows Signing in… and then the original outcome", async () => {
  route(GET, ok({ available: true, attempt: working("exchanging") }));
  route(WAIT, apiErr(422, "sign_in_code_rejected", MSG.signInCodeRejected));
  renderHost();
  expect(await within(panel()).findByText(MSG.signInCodeRejected)).toBeInTheDocument();
  expect(count(WAIT)).toBe(1);
});

it("the pending label reads Signing in… until a 202 or refetch reports verifying, then Verifying… (L4)", async () => {
  await toReady();
  const code = deferred();
  const second = deferred();
  route(CODE, () => code.promise);
  route(WAIT, ok({ attempt: working("verifying") }, 202), () => second.promise);
  await typeCodeAndSubmit();
  await waitFor(() => expect(primary()).toHaveTextContent("Signing in…"));
  await act(async () => code.resolve(ok({ attempt: working("exchanging") }, 202)));
  expect(primary()).toHaveTextContent("Signing in…");
  await waitFor(() => expect(primary()).toHaveTextContent("Verifying…"), { timeout: 3000 });
  // The url known from GET is kept for the same attempt (no url in /code or /code/wait answers).
  expect(screen.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", SYN_URL);
  await act(async () => second.resolve(ok({ credential: cred() }, 201)));
});

it("a network error on code joins the wait; a code that never arrived returns to Ready with the code kept", async () => {
  await toReady();
  route(CODE, () => {
    throw new TypeError("Failed to fetch");
  });
  route(
    WAIT,
    apiErr(409, "sign_in_state", MSG.signInState, {
      attempt: working("awaiting_code", { codeDeadline: soon() }),
    }),
  );
  await typeCodeAndSubmit();
  await waitFor(() => expect(count(WAIT)).toBe(1));
  await waitFor(() => expect(primary()).toHaveTextContent("Sign in and add"));
  expect(codeBox()).toHaveValue(SYN_CODE);
  expect(screen.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", SYN_URL);
  expect(screen.queryByText(MSG.signInState)).toBeNull();
});

it("purpose mismatch shows the other-panel line", async () => {
  route(GET, ok({ available: true, attempt: ready({ purpose: "replace", name: "personal" }) }));
  let r = renderHost();
  expect(await within(panel()).findByText(FORM_MSG.signInOtherPanel)).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
  r.unmount();
  r = renderHost({ purpose: "replace", name: "work" });
  expect(await within(panel()).findByText(FORM_MSG.signInOtherPanel)).toBeInTheDocument();
  r.unmount();
  route(GET, ok({ available: true, attempt: ready({ purpose: "create" }) }));
  renderHost({ purpose: "replace", name: "work" });
  expect(await within(panel()).findByText(FORM_MSG.signInOtherPanel)).toBeInTheDocument();
});

it("exchanging makes Code and Name readOnly + aria-disabled and hides Cancel sign-in", async () => {
  await toReady();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
  route(CODE, () => deferred().promise);
  await typeCodeAndSubmit();
  await waitFor(() => expect(codeBox()).toHaveAttribute("readonly"));
  expect(codeBox()).toHaveAttribute("aria-disabled", "true");
  expect(codeBox()).not.toBeDisabled();
  const nameBox = screen.getByRole("textbox", { name: "Name" });
  expect(nameBox).toHaveAttribute("readonly");
  expect(nameBox).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
});

it("Cancel sign-in (sheet frame only) ends the attempt and returns to Idle", async () => {
  const r = await toReady();
  route("DELETE /api/claude-sign-in/:id", ok(undefined, 204));
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(await screen.findByText(SIGN_IN_HELP)).toBeInTheDocument();
  expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/claude-sign-in/a1")).toBe(true);
  r.unmount();
  await toReady({ frame: "inline" });
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
});

it("the code lives only in the hook's state and is cleared after any outcome (no mutation cache)", async () => {
  const r = await toReady();
  route(CODE, apiErr(422, "sign_in_code_rejected", MSG.signInCodeRejected));
  await typeCodeAndSubmit();
  await within(panel()).findByText(MSG.signInCodeRejected);
  expect(r.qc.getMutationCache().getAll()).toHaveLength(0);
  expect(
    JSON.stringify(
      r.qc
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain(SYN_CODE);
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(SYN_CODE);
  route(START, ok({ attempt: ready({ attemptId: "a2" }) }));
  fireEvent.click(primary());
  await screen.findByRole("link", { name: "Open sign-in page" });
  expect(codeBox()).toHaveValue("");
});

it("start refusals that leave the attempt go to the form outcome, not the line", async () => {
  route(GET, ok({ available: true, attempt: null }));
  route(START, apiErr(429, "sign_in_busy", MSG.signInBusy));
  renderHost();
  await screen.findByText(SIGN_IN_HELP);
  fireEvent.click(primary());
  expect(await screen.findByRole("alert")).toHaveTextContent(MSG.signInBusy);
  expect(within(panel()).getByText(SIGN_IN_HELP)).toBeInTheDocument();
});

it("states swap with no transition classes (R7)", async () => {
  route(GET, ok({ available: true, attempt: null }));
  route(START, ok({ attempt: ready() }));
  renderHost();
  await screen.findByText(SIGN_IN_HELP);
  const still = () =>
    [panel(), ...panel().querySelectorAll<HTMLElement>("div, p")].filter((el) =>
      /transition|animate|fade|duration-/.test(el.className),
    );
  expect(still()).toEqual([]);
  fireEvent.click(primary());
  await screen.findByRole("link", { name: "Open sign-in page" });
  expect(still()).toEqual([]);
  // No reserved height for a later state.
  expect(panel().getAttribute("style")).toBeNull();
});
