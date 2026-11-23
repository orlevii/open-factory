import type { CredentialSummary } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { credentialsQueryOptions } from "@/features/settings/api";
import { bindSheetQueryClient, sheetBodies } from "@/features/sheets/sheet-bodies";
import { json, mockApi } from "@/test/mock-api";
import { CredentialsSection } from "./credentials-section";

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

test("an expired credential's verification line is muted, not a second crimson line", () => {
  renderSection([
    cred({ expiresAt: "2027-11-01T00:00:00Z", lastError: "Claude rejected this token." }),
  ]);
  const check = screen.getByText(/Last check failed/).closest("span.flex") as HTMLElement;
  expect(check).toHaveClass("text-muted-foreground");
  expect(check).not.toHaveClass("text-destructive");
  expect(screen.getByText("Expired 1 Nov 2027").closest("span.flex")).toHaveClass(
    "text-destructive",
  );
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
