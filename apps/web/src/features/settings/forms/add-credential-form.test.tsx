import { type AttemptView, type CredentialSummary, MSG } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { resetSignIn } from "@/features/settings/sign-in/use-sign-in";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { AddCredentialForm } from "./add-credential-form";

// Synthetic values only: no real sign-in URL, code or token ever appears in a test.
const SYN_URL = "https://claude.com/cai/oauth/authorize?code=true&state=SYNTHETIC";
const SYN_CODE = "SYNTHETIC-code#SYNTHETIC-state";
const soon = () => new Date(Date.now() + 9 * 60_000).toISOString();
const ready = (o: Partial<AttemptView> = {}): AttemptView => ({
  attemptId: "a1",
  state: "awaiting_code",
  url: SYN_URL,
  codeDeadline: soon(),
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
const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const GET = "GET /api/claude-sign-in";
const START = "POST /api/claude-sign-in";
const CODE = "POST /api/claude-sign-in/code";
const WAIT = "POST /api/claude-sign-in/code/wait";
const CREATE = "POST /api/credentials";
type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, () => Response | Promise<Response>> = {};
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;
const bodyOf = (key: string) => calls.find((c) => `${c.method} ${c.url}` === key)?.body;

beforeEach(() => {
  fakeMatchMedia.install(false);
  resetSignIn();
  calls = [];
  routes = { [GET]: () => ok({ available: true, attempt: null }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const h = routes[`${method} ${url}`];
      return h ? h() : ok({ error: { code: "not_found", message: url } }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetSignIn();
});

/** The sheet frame, as the Add credential sheet renders it. `seed` puts a GET answer in the cache before mount. */
function renderSheet(
  opts: { seed?: { available: boolean; attempt: AttemptView | null } } = {},
  onDone = vi.fn(),
  onCancel = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.seed) qc.setQueryData(["claude-sign-in"], opts.seed);
  render(
    <QueryClientProvider client={qc}>
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Add credential</SheetTitle>
          </SheetHeader>
          <AddCredentialForm frame="sheet" existing={[]} onDone={onDone} onCancel={onCancel} />
        </SheetContent>
      </Sheet>
    </QueryClientProvider>,
  );
  return { qc, onDone, onCancel, dialog: screen.getByRole("dialog", { name: "Add credential" }) };
}
const primary = (dialog: HTMLElement) =>
  dialog.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
const describedText = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();

it("Method defaults to Sign in with Claude and the primary is Start sign-in", async () => {
  const { dialog } = renderSheet();
  expect(within(dialog).getByRole("radiogroup")).toBeInTheDocument();
  expect(within(dialog).getByText("Method")).toBeInTheDocument();
  await waitFor(() => expect(radio(dialog, "Sign in with Claude")).toBeChecked());
  expect(radio(dialog, "Paste a token")).not.toBeChecked();
  expect(primary(dialog)).toHaveTextContent("Start sign-in");
  expect(within(dialog).queryByLabelText("Token")).toBeNull();
});

it("Enter in Name starts sign-in and runs no field checks (R8)", async () => {
  routes[START] = () => ok({ attempt: ready() });
  const { dialog } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  const name = within(dialog).getByLabelText("Name");
  await userEvent.type(name, "{Enter}");
  await waitFor(() => expect(count(START)).toBe(1));
  expect(name).not.toHaveAttribute("aria-invalid");
  expect(await within(dialog).findByRole("link", { name: "Open sign-in page" })).toBeVisible();
});

it("at Ready the primary is Sign in and add; submit sends attemptId, code and name", async () => {
  routes[START] = () => ok({ attempt: ready() });
  routes[CODE] = () => ok({ credential: cred() }, 201);
  const { dialog, onDone } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  fireEvent.click(primary(dialog));
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  expect(primary(dialog)).toHaveTextContent("Sign in and add");
  // Name is checked at the code submit: an empty Name stops it, with no request.
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Code" }), {
    target: { value: SYN_CODE },
  });
  fireEvent.click(primary(dialog));
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true"),
  );
  expect(count(CODE)).toBe(0);
  await userEvent.type(within(dialog).getByLabelText("Name"), "work");
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(bodyOf(CODE)).toEqual({ attemptId: "a1", code: SYN_CODE, name: "work" });
  expect(count(CREATE)).toBe(0);
});

it("pending labels: Starting…, Signing in…, Verifying…", async () => {
  const start = deferred();
  const code = deferred();
  const wait = deferred();
  routes[START] = () => start.promise;
  routes[CODE] = () => code.promise;
  routes[WAIT] = () => wait.promise;
  const { dialog, onDone } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(primary(dialog)).toHaveTextContent("Starting…"));
  start.resolve(ok({ attempt: ready() }));
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "work");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Code" }), {
    target: { value: SYN_CODE },
  });
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(primary(dialog)).toHaveTextContent("Signing in…"));
  // While exchanging, Name is readOnly and aria-disabled (not disabled: focus stays).
  const name = within(dialog).getByLabelText("Name");
  expect(name).toHaveAttribute("readonly");
  expect(name).toHaveAttribute("aria-disabled", "true");
  // Method is locked mid sign-in: a paste body must not replace a save that is still running.
  for (const r of within(dialog).getAllByRole("radio")) expect(r).toBeDisabled();
  code.resolve(ok({ attempt: { attemptId: "a1", state: "verifying", purpose: "create" } }, 202));
  await waitFor(() => expect(primary(dialog)).toHaveTextContent("Verifying…"));
  for (const r of within(dialog).getAllByRole("radio")) expect(r).toBeDisabled();
  wait.resolve(ok({ credential: cred() }, 201));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});

it("Paste a token shows the token field with the never-warned help; Verify and add posts expiresAt-less create", async () => {
  routes[CREATE] = () => ok({ credential: cred({ expiresAt: null }) }, 201);
  const { dialog, onDone } = renderSheet();
  await waitFor(() => expect(radio(dialog, "Sign in with Claude")).toBeChecked());
  await userEvent.type(within(dialog).getByLabelText("Name"), "work");
  await userEvent.click(radio(dialog, "Paste a token"));
  const token = within(dialog).getByLabelText("Token");
  expect(describedText(token)).toBe(
    "Create one with claude setup-token. You won't be warned before it expires.",
  );
  expect(primary(dialog)).toHaveTextContent("Verify and add");
  expect(within(dialog).queryByRole("link", { name: "Open sign-in page" })).toBeNull();
  await userEvent.type(token, "sk-ant-oat01-SYNTHETIC{Enter}");
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(bodyOf(CREATE)).toEqual({
    name: "work",
    kind: "oauth_token",
    value: "sk-ant-oat01-SYNTHETIC",
  });
  expect(count(START)).toBe(0);
});

it("Paste an API key keeps today's field", async () => {
  routes[CREATE] = () => ok({ credential: cred({ kind: "api_key", expiresAt: null }) }, 201);
  const { dialog, onDone } = renderSheet();
  await userEvent.type(within(dialog).getByLabelText("Name"), "work");
  await userEvent.click(radio(dialog, "Paste a token"));
  await userEvent.type(within(dialog).getByLabelText("Token"), "tok");
  await userEvent.click(radio(dialog, "Paste an API key"));
  const key = within(dialog).getByLabelText("Key");
  expect(key).toHaveValue("");
  expect(key).not.toHaveAccessibleDescription();
  await userEvent.type(key, "sk-ant-api-SYNTHETIC");
  // Switching back keeps each method's own value.
  await userEvent.click(radio(dialog, "Paste a token"));
  expect(within(dialog).getByLabelText("Token")).toHaveValue("tok");
  await userEvent.click(radio(dialog, "Paste an API key"));
  expect(within(dialog).getByLabelText("Key")).toHaveValue("sk-ant-api-SYNTHETIC");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("work");
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(bodyOf(CREATE)).toEqual({ name: "work", kind: "api_key", value: "sk-ant-api-SYNTHETIC" });
});

it("python3 unavailable: default Paste a token, Sign in with Claude disabled with its reason", async () => {
  routes[GET] = () => ok({ available: false, attempt: null });
  const { dialog } = renderSheet();
  await waitFor(() => expect(radio(dialog, "Paste a token")).toBeChecked());
  const signIn = radio(dialog, "Sign in with Claude");
  expect(signIn).toBeDisabled();
  const group = within(dialog).getByRole("group", { name: "Method" });
  expect(describedText(group)).toBe(MSG.signInUnavailable);
  expect(primary(dialog)).toHaveTextContent("Verify and add");
  expect(within(dialog).getByLabelText("Token")).toBeInTheDocument();
});

it("sheet Close keeps the attempt (D13)", async () => {
  routes[GET] = () => ok({ available: true, attempt: ready() });
  const { dialog, onCancel } = renderSheet();
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  const close = within(dialog).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement;
  await userEvent.click(close);
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
});

it("mounting with a live attempt does not move focus (autoFocus false); Ready then focuses Open sign-in page", async () => {
  routes[GET] = () => ok({ available: true, attempt: ready() });
  const { dialog } = renderSheet({ seed: { available: true, attempt: ready() } });
  const link = await within(dialog).findByRole("link", { name: "Open sign-in page" });
  await waitFor(() => expect(link).toHaveFocus());
  // The frame's own mount focus (a setTimeout 0) must not take it back to Name.
  await new Promise((r) => setTimeout(r, 10));
  expect(link).toHaveFocus();
  expect(within(dialog).getByLabelText("Name")).not.toHaveFocus();
});

it("without an attempt the sheet focuses Name on open", async () => {
  const { dialog } = renderSheet({ seed: { available: true, attempt: null } });
  await waitFor(() => expect(within(dialog).getByLabelText("Name")).toHaveFocus());
});
