import type { AttemptView, CredentialSummary } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { credentialsQueryOptions } from "@/features/settings/api";
import { bindSheetQueryClient, sheetBodies } from "@/features/sheets/sheet-bodies";
import { json, mockApi } from "@/test/mock-api";
import { CredentialsSection } from "./credentials-section";
import { signInQueryOptions } from "./sign-in/api";
import { resetSignIn } from "./sign-in/use-sign-in";

const navigate = vi.fn();
const openSheet = vi.fn();
const expirySpy = vi.fn();

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("@/features/sheets/sheet-store", async (orig) => ({
  ...(await orig<typeof import("@/features/sheets/sheet-store")>()),
  openSheet: (...a: unknown[]) => openSheet(...a),
}));
vi.mock("./sign-in/expiry", async (orig) => {
  const m = await orig<typeof import("./sign-in/expiry")>();
  return {
    ...m,
    expiryState: (...a: Parameters<typeof m.expiryState>) => {
      expirySpy();
      // A fixed locale and zone: the machine's own would change the text.
      return m.expiryState(a[0], a[1], "en-GB", "UTC");
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-11-03T12:00:00Z"));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  resetSignIn();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  bindSheetQueryClient(undefined);
});

const cred = (o: Partial<CredentialSummary> = {}): CredentialSummary => ({
  name: "work",
  kind: "oauth_token",
  lastVerifiedAt: "2027-11-03T10:00:00Z",
  lastError: null,
  expiresAt: null,
  rejected: false,
  usedBy: [],
  archivedUsedBy: [],
  rateLimit: null,
  ...o,
});

function renderSection(list: CredentialSummary[], props: { arriveAt?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(credentialsQueryOptions.queryKey, list);
  const ui = (p: { arriveAt?: string }) => (
    <QueryClientProvider client={qc}>
      <CredentialsSection {...p} />
    </QueryClientProvider>
  );
  const r = render(ui(props));
  return { qc, rerender: (p: { arriveAt?: string }) => r.rerender(ui(p)) };
}

const signIn = () => screen.queryByRole("button", { name: "Sign in again" });

test.each([
  [{ expiresAt: "2028-01-15T00:00:00Z" }, "Expires Jan 2028", false],
  [{ expiresAt: "2027-11-12T00:00:00Z" }, "Expires in 9 days", true],
  [{ expiresAt: "2027-11-01T00:00:00Z" }, "Expired 1 Nov 2027", true],
  [{ expiresAt: null }, null, false],
] as const)("row state %#", (patch, text, button) => {
  renderSection([cred({ kind: "oauth_token", ...patch })]);
  if (text) expect(screen.getByText(text)).toBeInTheDocument();
  expect(!!signIn()).toBe(button);
});

test("a rejected OAuth credential shows Sign in again after its failure line", () => {
  renderSection([cred({ rejected: true, lastError: "Claude rejected this token." })]);
  const failure = screen.getByText(/Last check failed/);
  const button = screen.getByRole("button", { name: "Sign in again" });
  expect(failure.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an api key never shows Sign in again", async () => {
  renderSection([cred({ kind: "api_key", rejected: true, expiresAt: "2027-11-01T00:00:00Z" })]);
  expect(signIn()).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Actions for work" }));
  expect(screen.queryByRole("menuitem", { name: "Sign in again" })).toBeNull();
});

test("an expired credential whose last check failed shows no failure line, only the crimson expiry", () => {
  renderSection([
    cred({ expiresAt: "2027-11-01T00:00:00Z", lastError: "Claude rejected this token." }),
  ]);
  expect(screen.queryByText(/Last check failed/)).toBeNull();
  expect(screen.getByText("Expired 1 Nov 2027").closest("span.flex")).toHaveClass(
    "text-destructive",
  );
});

test("a rejected credential with a far expiry puts Sign in again right after the failure line", () => {
  renderSection([
    cred({
      rejected: true,
      lastError: "Claude rejected this token.",
      expiresAt: "2028-01-15T00:00:00Z",
    }),
  ]);
  const failure = screen.getByText(/Last check failed/);
  const button = screen.getByRole("button", { name: "Sign in again" });
  const expiry = screen.getByText(/^Expires /);
  expect(failure.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button.compareDocumentPosition(expiry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a failed check on a live credential stays crimson", () => {
  renderSection([cred({ lastError: "boom" })]);
  expect(screen.getByText(/Last check failed/).closest("span.flex")).toHaveClass(
    "text-destructive",
  );
});

test("the menu has Sign in again for OAuth only, above Replace token", async () => {
  renderSection([cred()]);
  await userEvent.click(screen.getByRole("button", { name: "Actions for work" }));
  const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
  expect(items.slice(0, 2)).toEqual(["Sign in again", "Replace token"]);
});

test("Sign in again (button and menu item) opens the sign-in-again sheet", async () => {
  renderSection([cred({ expiresAt: "2027-11-01T00:00:00Z" })]);
  await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(openSheet).toHaveBeenLastCalledWith({ kind: "sign-in-again", name: "work" });
  openSheet.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Actions for work" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Sign in again" }));
  expect(openSheet).toHaveBeenCalledWith({ kind: "sign-in-again", name: "work" });
});

test("?credential=work arrives on that row once, after the list loaded, then clears the param", async () => {
  renderSection([cred({ expiresAt: "2027-11-01T00:00:00Z" })], { arriveAt: "work" });
  const row = document.querySelector<HTMLElement>('[data-name="work"]');
  await waitFor(() => expect(row).toHaveAttribute("data-arrived"));
  expect(screen.getByRole("button", { name: "Sign in again" })).toHaveFocus();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith({
    to: "/settings/credentials",
    search: {},
    replace: true,
  });
});

test("?credential= on a row without a button focuses the row", async () => {
  renderSection([cred()], { arriveAt: "work" });
  const row = document.querySelector<HTMLElement>('[data-name="work"]');
  await waitFor(() => expect(row).toHaveFocus());
});

test("?credential=gone (no such row) still clears the param and moves nothing", async () => {
  renderSection([cred()], { arriveAt: "gone" });
  await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  expect(document.querySelector("[data-arrived]")).toBeNull();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(document.body).toHaveFocus();
});

test("Sign in again buttons and the menu item carry sheetIntent (prefetch on hover, focus, pointerdown)", async () => {
  const { qc } = renderSection([cred({ expiresAt: "2027-11-01T00:00:00Z" })]);
  bindSheetQueryClient(qc);
  const entry = sheetBodies["sign-in-again"];
  if (!entry) throw new Error("sign-in-again is not registered");
  const prefetch = vi.spyOn(entry, "prefetch").mockImplementation(() => {});
  const spec = { kind: "sign-in-again", name: "work" };
  const button = screen.getByRole("button", { name: "Sign in again" });
  await userEvent.hover(button);
  expect(prefetch).toHaveBeenLastCalledWith(qc, spec);
  prefetch.mockClear();
  act(() => button.focus());
  expect(prefetch).toHaveBeenCalledWith(qc, spec);
  prefetch.mockClear();
  fireEvent.pointerDown(button);
  expect(prefetch).toHaveBeenCalledWith(qc, spec);
  prefetch.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Actions for work" }));
  await userEvent.hover(screen.getByRole("menuitem", { name: "Sign in again" }));
  expect(prefetch).toHaveBeenCalledWith(qc, spec);
});

test("a refetch with unchanged data, and a section re-render, do not re-render the rows", async () => {
  const list = [cred({ name: "a" }), cred({ name: "b" })];
  mockApi({ "GET /api/credentials": () => json({ credentials: list }) });
  const { qc } = renderSection(list);
  const before = expirySpy.mock.calls.length;
  expect(before).toBe(2);
  await act(() => qc.refetchQueries({ queryKey: credentialsQueryOptions.queryKey }));
  // A state change in the section (the add form opens) renders the section, not its rows.
  await userEvent.click(screen.getByRole("button", { name: "Add credential" }));
  expect(within(screen.getByRole("region")).getByLabelText("Name")).toBeInTheDocument();
  expect(expirySpy.mock.calls.length).toBe(before);
});

// Synthetic values only (spec §6): never a real sign-in URL or code.
const attempt = (o: Partial<AttemptView> = {}): AttemptView => ({
  attemptId: "a1",
  state: "awaiting_code",
  url: "https://claude.com/cai/oauth/authorize?state=SYNTHETIC",
  codeDeadline: new Date(Date.now() + 9 * 60_000).toISOString(),
  purpose: "create",
  ...o,
});
const never = () => new Promise<Response>(() => {});

test.each(["awaiting_code", "submitting", "exchanging", "verifying"] as const)(
  "Settings opens the inline form when GET has a live create attempt (%s)",
  async (state) => {
    mockApi({
      "GET /api/credentials": () => json({ credentials: [] }),
      "GET /api/claude-sign-in": () => json({ available: true, attempt: attempt({ state }) }),
      "POST /api/claude-sign-in/code/wait": never,
    });
    renderSection([]);
    expect(await screen.findByRole("form", { name: "Add credential" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add credential" })).toBeNull();
  },
);

test.each([
  ["settled", attempt({ state: "settled" })],
  ["replace", attempt({ purpose: "replace", name: "work" })],
] as const)("Settings never opens the inline form for a %s attempt", async (_, a) => {
  const api = mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/claude-sign-in": () => json({ available: true, attempt: a }),
  });
  renderSection([]);
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/claude-sign-in")).toBe(true));
  await act(async () => {});
  expect(screen.queryByRole("form", { name: "Add credential" })).toBeNull();
  expect(screen.getByRole("button", { name: "Add credential" })).toBeInTheDocument();
});

test("the restored inline form keeps its mount focus off; Ready focuses Open sign-in page", async () => {
  mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/claude-sign-in": () => json({ available: true, attempt: attempt() }),
  });
  renderSection([]);
  const link = await screen.findByRole("link", { name: "Open sign-in page" });
  await waitFor(() => expect(link).toHaveFocus());
  expect(screen.getByLabelText("Name")).not.toHaveFocus();
});

test("inline Cancel cancels the attempt (D13) and closes the form", async () => {
  let deleted = 0;
  mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/claude-sign-in": () => json({ available: true, attempt: deleted ? null : attempt() }),
    "DELETE /api/claude-sign-in/a1": () => {
      deleted++;
      return new Response(null, { status: 204 });
    },
  });
  const { qc } = renderSection([]);
  await screen.findByRole("link", { name: "Open sign-in page" });
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(deleted).toBe(1));
  expect(screen.queryByRole("form", { name: "Add credential" })).toBeNull();
  await waitFor(() =>
    expect(qc.getQueryData(signInQueryOptions.queryKey)?.attempt ?? null).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Add credential" })).toBeInTheDocument();
});

test("a sign-in attempt change does not re-render the Settings section (select narrows to isLiveCreate)", async () => {
  mockApi({ "GET /api/credentials": () => json({ credentials: [] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(credentialsQueryOptions.queryKey, []);
  const other = attempt({ purpose: "replace", name: "work" });
  qc.setQueryData(signInQueryOptions.queryKey, { available: true, attempt: other });
  let renders = 0;
  render(
    <QueryClientProvider client={qc}>
      <Profiler id="section" onRender={() => renders++}>
        <CredentialsSection />
      </Profiler>
    </QueryClientProvider>,
  );
  // The query cache notifies on a 0 ms timeout: let each write reach the observers before counting.
  const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
  await settle();
  const before = renders;
  await act(async () => {
    qc.setQueryData(signInQueryOptions.queryKey, {
      available: true,
      attempt: { ...other, state: "exchanging" },
    });
  });
  await act(async () => {
    qc.setQueryData(signInQueryOptions.queryKey, { available: true, attempt: null });
  });
  await settle();
  expect(renders).toBe(before);
  // The boolean flipping does render it: the inline form opens.
  await act(async () => {
    qc.setQueryData(signInQueryOptions.queryKey, { available: true, attempt: attempt() });
  });
  await settle();
  expect(renders).toBeGreaterThan(before);
  expect(await screen.findByRole("form", { name: "Add credential" })).toBeInTheDocument();
});
