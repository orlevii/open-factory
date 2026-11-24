import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { resetDrafts } from "@/features/sheets/drafts";
import { closeSheet } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, marketplaceRow } from "./fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_o: { onMessage?: (m: ServerMessage) => void }) => ({
    close() {},
    status: () => "open",
    send: () => true,
  }),
}));
vi.mock("@/components/ui/toaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toaster")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});

// The 300 ms inert window is the boundary faked here: its timer is held and released by the test, with no real sleeps.
const windows: (() => void)[] = [];
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  fakeMatchMedia.install(false);
  windows.length = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...a: []
  ) => {
    if (ms === 300) {
      windows.push(fn);
      return 0;
    }
    return realSetTimeout(fn, ms, ...a);
  }) as unknown as typeof setTimeout);
});
const releaseInert = () =>
  act(() => {
    for (const fn of windows.splice(0)) fn();
  });
afterEach(() => {
  vi.mocked(globalThis.setTimeout).mockRestore();
  closeSheet();
  resetDrafts();
  vi.clearAllMocks();
});

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const preview = (o: Record<string, unknown> = {}) => ({
  previewId: "p1",
  name: "acme",
  source: { source: "github", repo: "acme/mkt" },
  commit: COMMIT,
  committedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  subject: "Add the plugins",
  branch: "main",
  commitPinnable: true,
  plugins: [
    { name: "review", version: "1.2.0", pinnable: true },
    {
      name: "tool",
      pinnable: false,
      refusedReason: "Can't be pinned: it follows its own source.",
    },
    {
      name: "cmd",
      pinnable: false,
      refusedReason: "Plugin cmd@acme uses a command source, which Open Factory doesn't install.",
    },
  ],
  ...o,
});
const added = (o: Record<string, unknown> = {}) => {
  const { plugins: _p, users: _u, ...row } = marketplaceRow("acme");
  return { ...row, ...o };
};

type Routes = Parameters<typeof mockApi>[0];
async function open(routes: Routes = {}, rows = [marketplaceRow("zed")]) {
  const mocks = mockApi({
    "GET /api/library/marketplaces": () => json({ marketplaces: rows }),
    "GET /api/library/skills": () => json(library([hostGroup()])),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
    ...routes,
  });
  const user = userEvent.setup();
  renderApp("/skills/marketplaces", alice);
  await user.click(await screen.findByRole("button", { name: "Add marketplace" }));
  const dialog = await screen.findByRole("dialog", { name: "Add marketplace" });
  await within(dialog).findByRole("form", { name: "Add marketplace" });
  return { mocks, user, dialog: within(dialog) };
}
type Dialog = Awaited<ReturnType<typeof open>>["dialog"];
const button = (d: Dialog, name: string) => d.getByRole("button", { name });

async function find(user: ReturnType<typeof userEvent.setup>, d: Dialog) {
  await user.type(d.getByLabelText("Repository"), "acme/mkt");
  await user.click(button(d, "Find marketplace"));
  await d.findByText(/Found acme at/);
  await releaseInert();
}

test("the source is GitHub, Git URL or Folder, each with its own field", async () => {
  const { user, dialog: d } = await open();
  expect(d.getByLabelText("Repository")).toBeInTheDocument();
  await user.click(d.getByRole("radio", { name: "Git URL" }));
  expect(d.getByLabelText("Repository URL")).toBeInTheDocument();
  await user.click(d.getByRole("radio", { name: "Folder" }));
  expect(d.getByLabelText("Path")).toBeInTheDocument();
});

test("an invalid repo is refused on its field before any request", async () => {
  const { user, dialog: d, mocks } = await open();
  await user.type(d.getByLabelText("Repository"), "not a repo");
  await user.click(button(d, "Find marketplace"));
  expect(await d.findByText("Use owner/repo or a github.com URL.")).toBeVisible();
  expect(d.getByLabelText("Repository")).toBeInvalid();
  expect(mocks.calls.some((c) => c.method === "POST")).toBe(false);
});

test("the preview shows the commit, the plugins, and why one can't be pinned or used", async () => {
  const { user, dialog: d } = await open({
    "POST /api/library/marketplaces/preview": () => json(preview()),
  });
  await user.type(d.getByLabelText("Repository"), "acme/mkt");
  await user.click(button(d, "Find marketplace"));
  const label = await d.findByText(/Found acme at/);
  expect(label).toHaveFocus();
  expect(label).toHaveTextContent(/Found acme at a1b2c3d · main · Add the plugins/);
  const list = d.getByRole("list");
  expect(within(list).getByText("review")).toBeInTheDocument();
  expect(within(list).getByText("1.2.0")).toBeInTheDocument();
  expect(within(list).getByText("Can't be pinned")).toBeInTheDocument();
  expect(within(list).getByText("Can't use")).toBeInTheDocument();
  expect(within(list).getByText(/uses a command source/)).toBeInTheDocument();
});

test("the official marketplace is shown as Latest only", async () => {
  const { user, dialog: d } = await open({
    "POST /api/library/marketplaces/preview": () =>
      json(preview({ name: "claude-plugins-official", commitPinnable: false })),
  });
  await user.type(d.getByLabelText("Repository"), "anthropics/claude-plugins-official");
  await user.click(button(d, "Find marketplace"));
  expect(
    await d.findByText(/claude-plugins-official can only be used at Latest/),
  ).toBeInTheDocument();
});

test("editing the source after Find marks the preview stale and returns the primary to Find", async () => {
  const { user, dialog: d } = await open({
    "POST /api/library/marketplaces/preview": () => json(preview()),
  });
  await find(user, d);
  await user.type(d.getByLabelText("Repository"), "2");
  expect(d.getByText("The source changed. Find the marketplace again.")).toBeInTheDocument();
  expect(button(d, "Find marketplace")).toBeInTheDocument();
});

test("Add closes the sheet with Added acme at a1b2c3d. and an Undo that removes it", async () => {
  const {
    user,
    dialog: d,
    mocks,
  } = await open({
    "POST /api/library/marketplaces/preview": () => json(preview()),
    "POST /api/library/marketplaces": () => json(added(), 201),
    "DELETE /api/library/marketplaces/acme": () =>
      json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }),
  });
  await find(user, d);
  await user.click(button(d, "Add marketplace"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(
    mocks.calls.find((c) => c.method === "POST" && c.url === "/api/library/marketplaces")?.body,
  ).toEqual({
    previewId: "p1",
  });
  const toast = vi.mocked(notify).mock.calls.at(-1)?.[0];
  expect(toast?.text).toBe("Added acme at a1b2c3d.");
  await toast?.undo?.();
  expect(
    mocks.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/marketplaces/acme")),
  ).toBe(true);
});

test("a 202 closes the sheet at once and the list shows the pending row with the server's since", async () => {
  const since = new Date(Date.now() - 42_000).toISOString();
  let rows = [marketplaceRow("zed")];
  const { user, dialog: d } = await open({
    "GET /api/library/marketplaces": () => json({ marketplaces: rows }),
    "POST /api/library/marketplaces/preview": () => json(preview()),
    "POST /api/library/marketplaces": () => {
      rows = [marketplaceRow("zed"), marketplaceRow("acme", { state: "adding", since })];
      return json(added({ state: "adding", since }), 202);
    },
  });
  await find(user, d);
  await user.click(button(d, "Add marketplace"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const row = await screen.findByRole("button", { name: /^acme/ });
  expect(within(row).getByText("Adding…")).toBeInTheDocument();
  expect(within(row).getByText(/^4\ds$/)).toBeInTheDocument();
  expect(notify).not.toHaveBeenCalled();
});

test("a failed add after the sheet was closed toasts Couldn't add acme.", async () => {
  let fail: () => void = () => {};
  const gate = new Promise<void>((r) => {
    fail = r;
  });
  const { user, dialog: d } = await open({
    "POST /api/library/marketplaces/preview": () => json(preview()),
    "POST /api/library/marketplaces": async () => {
      await gate;
      return json({ error: { code: "x", message: "The repo returned another commit." } }, 400);
    },
  });
  await find(user, d);
  await user.click(button(d, "Add marketplace"));
  await user.click(d.getAllByRole("button", { name: "Close" })[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fail();
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Couldn't add acme." }));
});

test("a failed add with the sheet open is shown in the sheet, not as a toast", async () => {
  const { user, dialog: d } = await open({
    "POST /api/library/marketplaces/preview": () => json(preview()),
    "POST /api/library/marketplaces": () =>
      json({ error: { code: "taken", message: "That name is taken." } }, 409),
  });
  await find(user, d);
  await user.click(button(d, "Add marketplace"));
  expect(await d.findByRole("alert")).toHaveTextContent("That name is taken.");
  expect(notify).not.toHaveBeenCalled();
});
