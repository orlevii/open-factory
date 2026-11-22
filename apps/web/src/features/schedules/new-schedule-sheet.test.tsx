import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { pickComboOption, pickOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));

const live = [
  agentSummary({ slug: "ceo", displayName: "CEO" }),
  agentSummary({ slug: "dev", displayName: "Dev" }),
];
const gone = agentSummary({
  slug: "old",
  displayName: "Old",
  terminatedAt: "2026-11-01T00:00:00Z",
});
const agents = (url?: string) =>
  json({
    agents: url?.includes("ended=only") ? [gone] : live,
    more: false,
    running: { count: 0, max: 8 },
  });
const item = {
  key: "S-8",
  target: { slug: "ceo", displayName: "CEO", archived: false, terminated: false },
  cron: "0 9 * * *",
  timezone: "Europe/Berlin",
  body: "Review",
  nextRunAt: "2026-11-23T08:00:00.000Z",
  lastFiredAt: null,
  paused: false,
  done: false,
  createdBy: { kind: "user", handle: "or" },
  bodyAuthor: { kind: "user", handle: "or" },
  pendingFiring: false,
  state: "active",
};
const base = () => ({
  "GET /api/agents?": (_b: unknown, url?: string) => agents(url),
  "GET /api/schedules?": () => json({ schedules: [], more: false }),
  "GET /api/schedules": () => json({ schedules: [], more: false }),
});
const sheet = () => screen.findByRole("dialog", { name: "New schedule" });
const target = async () => within(await sheet()).findByLabelText("Target");

beforeEach(() => {
  localStorage.clear();
  fakeMatchMedia.install(false);
  clearDraft("new-schedule");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

async function fillAndSubmit() {
  await pickComboOption(await target(), /@ceo/);
  await pickOption(screen.getByRole("combobox", { name: "Repeats" }), "Daily at 09:00");
  await userEvent.type(screen.getByLabelText("Message"), "Review");
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
}

test("the Schedules header button opens New schedule", async () => {
  mockApi(base());
  renderApp("/schedules", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New schedule" }));
  expect(await sheet()).toBeInTheDocument();
  expect(getSheetState().parent).toMatchObject({ kind: "new-schedule" });
});

test("the target filter on the list prefills Target", async () => {
  mockApi(base());
  renderApp("/schedules?target=dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New schedule" }));
  await waitFor(async () => expect(await target()).toHaveTextContent("Dev"));
});

test("the spec's target fills an empty draft only; a draft keeps its own", async () => {
  mockApi(base());
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-schedule", target: "dev" }));
  await waitFor(async () => expect(await target()).toHaveTextContent("Dev"));
  await userEvent.type(screen.getByLabelText("Message"), "Mine");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New schedule" })).toBeNull());
  act(() => openSheet({ kind: "new-schedule", target: "ceo" }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  expect(await target()).toHaveTextContent("Dev");
});

test("an ended target stays empty and says so", async () => {
  mockApi(base());
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-schedule", target: "old" }));
  expect(await screen.findByText("@old has ended; pick another.")).toBeInTheDocument();
  expect(await target()).toHaveTextContent("Choose an agent…");
});

test("an unknown target stays empty and says so", async () => {
  mockApi(base());
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-schedule", target: "nobody" }));
  expect(await screen.findByText("There is no agent @nobody.")).toBeInTheDocument();
  expect(await target()).toHaveTextContent("Choose an agent…");
});

test("success closes, clears the draft and toasts Created with Open for the Edit sheet", async () => {
  const api = mockApi({ ...base(), "POST /api/schedules": () => json({ schedule: item }, 201) });
  renderApp("/schedules", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New schedule" }));
  await fillAndSubmit();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New schedule" })).toBeNull());
  expect(api.calls.find((c) => c.method === "POST")?.body).toMatchObject({
    target: "ceo",
    cron: "0 9 * * *",
    body: "Review",
  });
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n).toEqual({ text: "Created S-8.", action: { label: "Open", run: expect.any(Function) } });
  act(() => n?.action?.run());
  expect(getSheetState().parent).toMatchObject({ kind: "edit-schedule", key: "S-8" });
  // The draft is gone: a new sheet starts blank.
  act(() => openSheet({ kind: "new-schedule" }));
  expect(screen.queryByText(/Draft restored/)).toBeNull();
});

test("the list shows no inline Created line", async () => {
  mockApi({ ...base(), "POST /api/schedules": () => json({ schedule: item }, 201) });
  renderApp("/schedules", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New schedule" }));
  await fillAndSubmit();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(screen.queryByText("Created S-8.")).toBeNull();
});

test("dismissing never asks, and keeps the draft", async () => {
  const confirm = vi.spyOn(window, "confirm");
  mockApi(base());
  renderApp("/schedules", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New schedule" }));
  await userEvent.type(await within(await sheet()).findByLabelText("Message"), "Keep me");
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New schedule" })).toBeNull());
  expect(confirm).not.toHaveBeenCalled();
  act(() => openSheet({ kind: "new-schedule" }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toHaveTextContent("Keep me");
});

test("a late success toasts Created · Open and does not navigate", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...base(),
    "POST /api/schedules": async () => {
      await gate;
      return json({ schedule: item }, 201);
    },
  });
  const { router } = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-schedule" }));
  await fillAndSubmit();
  await screen.findByRole("button", { name: "Creating…" });
  act(() => closeSheet());
  release();
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Created S-8.",
      action: { label: "Open", run: expect.any(Function) },
    }),
  );
  expect(router.state.location.pathname).toBe("/inbox");
});

test("a late failure toasts the error with Open form, which reopens the kept draft", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...base(),
    "POST /api/schedules": async () => {
      await gate;
      return json({ error: { code: "internal_error", message: "Database is down" } }, 500);
    },
  });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "new-schedule" }));
  await fillAndSubmit();
  await screen.findByRole("button", { name: "Creating…" });
  act(() => closeSheet());
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n?.text).toBe("Database is down");
  expect(n?.action?.label).toBe("Open form");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New schedule" })).toBeNull());
  act(() => n?.action?.run());
  expect(await screen.findByLabelText("Message")).toHaveTextContent("Review");
});
