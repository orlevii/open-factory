import { type AttemptView, type CredentialSummary, MSG } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { homeInboxQueryKey, inboxQueryKey } from "@/features/inbox/api";
import { credentialsQueryOptions } from "@/features/settings/api";
import { resetSignIn } from "@/features/settings/sign-in/use-sign-in";
import { FORM_MSG } from "@/lib/form-messages";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { sheetBodies } from "./sheet-bodies";
import SignInAgainSheet from "./sign-in-again-sheet";

vi.mock("@/components/ui/toaster", () => ({ notify: vi.fn() }));

// Synthetic values only: no real sign-in URL, code or token ever appears in a test.
const SYN_URL = "https://claude.com/cai/oauth/authorize?code=true&state=SYNTHETIC";
const SYN_CODE = "SYNTHETIC-code#SYNTHETIC-state";
const soon = () => new Date(Date.now() + 9 * 60_000).toISOString();
const ready = (o: Partial<AttemptView> = {}): AttemptView => ({
  attemptId: "a1",
  state: "awaiting_code",
  url: SYN_URL,
  codeDeadline: soon(),
  purpose: "replace",
  name: "work",
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

const GET = "GET /api/claude-sign-in";
const START = "POST /api/claude-sign-in";
const CODE = "POST /api/claude-sign-in/code";
type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, () => Response | Promise<Response>> = {};
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;
const bodyOf = (key: string) => calls.find((c) => `${c.method} ${c.url}` === key)?.body;

beforeEach(() => {
  fakeMatchMedia.install(false);
  resetSignIn();
  vi.mocked(notify).mockClear();
  calls = [];
  routes = {
    [GET]: () => ok({ available: true, attempt: null }),
    "GET /api/credentials": () => ok({ credentials: [cred()] }),
  };
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

function renderSheet(opts: { seed?: AttemptView | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.seed !== undefined)
    qc.setQueryData(["claude-sign-in"], { available: true, attempt: opts.seed });
  const close = vi.fn();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Sign in again</SheetTitle>
          </SheetHeader>
          <SignInAgainSheet
            spec={{ kind: "sign-in-again", name: "work" }}
            sheetId={1}
            close={close}
          />
        </SheetContent>
      </Sheet>
    </QueryClientProvider>,
  );
  return { qc, close, invalidate, dialog: screen.getByRole("dialog", { name: "Sign in again" }) };
}
const primary = (dialog: HTMLElement) =>
  dialog.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;

it("registers the title and the credential name as a mono description", () => {
  const entry = sheetBodies["sign-in-again"];
  expect(entry?.title).toBe("Sign in again");
  expect(entry?.description?.({ kind: "sign-in-again", name: "work" })).toBe("work");
  expect(entry?.descriptionClass).toBe("font-mono");
});

it("prefetch warms credentials and sign-in status together", () => {
  const entry = sheetBodies["sign-in-again"];
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "prefetchQuery").mockResolvedValue();
  entry?.prefetch(qc, { kind: "sign-in-again", name: "work" });
  expect(spy.mock.calls.map((c) => c[0].queryKey)).toEqual([
    credentialsQueryOptions.queryKey,
    ["claude-sign-in"],
  ]);
});

it("the primary is Start sign-in, then Sign in and replace; no Name or Method", async () => {
  routes[START] = () => ok({ attempt: ready() });
  const { dialog } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  expect(primary(dialog)).toHaveTextContent("Start sign-in");
  expect(within(dialog).queryByLabelText("Name")).toBeNull();
  expect(within(dialog).queryByText("Method")).toBeNull();
  fireEvent.click(primary(dialog));
  expect(await within(dialog).findByRole("link", { name: "Open sign-in page" })).toBeVisible();
  expect(primary(dialog)).toHaveTextContent("Sign in and replace");
  expect(bodyOf(START)).toEqual({ replace: "work" });
});

it("success closes the sheet with one toast and the restart note, and refetches credentials and the inbox", async () => {
  routes[START] = () => ok({ attempt: ready() });
  routes[CODE] = () =>
    ok(
      { credential: cred({ usedBy: ["a", "b", "c", "d"], expiresAt: "2028-11-23T12:00:00Z" }) },
      201,
    );
  const { dialog, close, invalidate } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  fireEvent.click(primary(dialog));
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Code" }), {
    target: { value: SYN_CODE },
  });
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(bodyOf(CODE)).toEqual({ attemptId: "a1", code: SYN_CODE });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith({
    text: "Signed in again: work. @a, @b, @c +1 more restart when idle to use it. Their crons from this session stop.",
  });
  const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
  expect(keys).toContainEqual(inboxQueryKey);
  expect(keys).toContainEqual(homeInboxQueryKey);
  expect(keys).toContainEqual(credentialsQueryOptions.queryKey);
});

it("success with no agents toasts only the headline", async () => {
  routes[START] = () => ok({ attempt: ready() });
  routes[CODE] = () => ok({ credential: cred() }, 201);
  const { dialog, close } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  fireEvent.click(primary(dialog));
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Code" }), {
    target: { value: SYN_CODE },
  });
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(notify).toHaveBeenCalledWith({ text: "Signed in again: work." });
});

it("a replace attempt for another name shows the other-panel line", async () => {
  renderSheet({ seed: ready({ name: "other" }) });
  expect(await screen.findByText(FORM_MSG.signInOtherPanel)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open sign-in page" })).toBeNull();
});

it("a live attempt for this credential is restored: focus goes to Open sign-in page, not the primary", async () => {
  const { dialog } = renderSheet({ seed: ready() });
  const link = await within(dialog).findByRole("link", { name: "Open sign-in page" });
  await waitFor(() => expect(link).toHaveFocus());
  expect(primary(dialog)).toHaveTextContent("Sign in and replace");
});

it("Idle focuses the primary on open", async () => {
  const { dialog } = renderSheet({ seed: null });
  await waitFor(() => expect(primary(dialog)).toHaveFocus());
});

it("a refused code keeps the sheet open with the Code error", async () => {
  routes[START] = () => ok({ attempt: ready() });
  routes[CODE] = () =>
    ok(
      {
        error: { code: "validation_error", message: "Invalid.", fields: { code: MSG.signInCode } },
      },
      400,
    );
  const { dialog, close } = renderSheet();
  await waitFor(() => expect(count(GET)).toBe(1));
  fireEvent.click(primary(dialog));
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Code" }), {
    target: { value: SYN_CODE },
  });
  fireEvent.click(primary(dialog));
  await waitFor(() => expect(within(dialog).getByText(MSG.signInCode)).toBeInTheDocument());
  expect(close).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});
