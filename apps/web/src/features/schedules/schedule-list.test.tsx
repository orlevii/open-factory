import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mockApi as baseMockApi, type Handler, json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { comboOptionNames, pickComboOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: ServerMessage) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** `/api/schedules` has no query string without filters, so every list handler answers both spellings. */
function mockApi(routes: Record<string, Handler>) {
  const api = baseMockApi(withBare(routes));
  const on = api.on;
  api.on = (k, h) => {
    on(k, h);
    if (k === "GET /api/schedules?") on("GET /api/schedules", h);
  };
  return api;
}
const withBare = (r: Record<string, Handler>) =>
  r["GET /api/schedules?"] ? { ...r, "GET /api/schedules": r["GET /api/schedules?"] } : r;

const user = { kind: "user", handle: "or" };
const sched = (n: number, o: Record<string, unknown> = {}) => ({
  key: `S-${n}`,
  target: { slug: "ceo", displayName: "CEO", archived: false, terminated: false },
  cron: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  body: `Message ${n}\nsecond line`,
  nextRunAt: "2026-11-23T08:00:00.000Z",
  lastFiredAt: null,
  paused: false,
  done: false,
  createdBy: user,
  bodyAuthor: user,
  pendingFiring: false,
  state: "active",
  ...o,
});
const list = (items: unknown[], more = false) => json({ schedules: items, more });
const agents = (_body?: unknown, url?: string) =>
  json({
    agents: url?.includes("ended=only")
      ? []
      : [agentSummary({ slug: "ceo" }), agentSummary({ slug: "dev", displayName: "Dev" })],
    more: false,
    running: { count: 0, max: 8 },
  });

test("a row is one link with a complete name; four lines carry the pattern, next run, first line and authors", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": () =>
      list([
        sched(3),
        sched(7, {
          target: { slug: "dev", displayName: "Dev", archived: false, terminated: false },
          cron: undefined,
          at: "2026-11-25T13:30:00.000Z",
          nextRunAt: "2026-11-25T13:30:00.000Z",
          state: "pending_errored",
          createdBy: { kind: "agent", slug: "lead", archived: false, terminated: false },
        }),
      ]),
  });
  renderApp("/schedules", alice);
  const row = await screen.findByRole("link", {
    name: "S-3, to @ceo, repeats 0 9 * * 1-5, next run Mon 23 Nov 09:00 Europe/Berlin, Active, by @or",
  });
  expect(row).toHaveAttribute("href", "/schedules/S-3");
  const li = row.closest("li") as HTMLElement;
  expect(within(li).getByText("0 9 * * 1-5")).toHaveClass("font-mono");
  expect(within(li).getByText("Mon 23 Nov 09:00")).toBeInTheDocument();
  expect(within(li).getByText("Message 3")).toBeInTheDocument();
  expect(within(li).getByText("@or")).toBeInTheDocument();
  const second = (
    await screen.findByRole("link", { name: /^S-7, to @dev \(target errored\), once/ })
  ).closest("li") as HTMLElement;
  expect(within(second).getByText("Once")).toBeInTheDocument();
  expect(within(second).getByText("· errored")).toBeInTheDocument();
  expect(within(second).getByText("Waiting")).toBeInTheDocument();
  expect(second.textContent).toContain("created by");
  expect(second.textContent).toContain("last written by");
  expect(screen.getByRole("button", { name: "Actions for S-3" })).toBeInTheDocument();
});

test("states: paused shows a dash, skipped says (skipped), done says Ran or Didn't run", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": () =>
      list([
        sched(1, { state: "paused", paused: true }),
        sched(2, {
          state: "skipped_archived",
          target: { slug: "ceo", displayName: "CEO", archived: true, terminated: false },
        }),
        sched(3, {
          state: "done",
          done: true,
          ran: true,
          cron: undefined,
          at: "2026-11-21T09:00:00.000Z",
          lastFiredAt: "2026-11-21T09:00:00.000Z",
          nextRunAt: null,
        }),
        sched(4, {
          state: "done",
          done: true,
          ran: false,
          cron: undefined,
          at: "2026-11-21T09:00:00.000Z",
          lastFiredAt: null,
          nextRunAt: null,
        }),
      ]),
  });
  renderApp("/schedules?done=true", alice);
  const item = async (k: string) =>
    (await screen.findByRole("link", { name: new RegExp(`^${k},`) })).closest("li") as HTMLElement;
  expect((await item("S-1")).textContent).toContain("· —");
  expect((await item("S-2")).textContent).toContain("(skipped)");
  expect((await item("S-2")).textContent).toContain("· archived");
  expect((await item("S-3")).textContent).toContain("Ran");
  expect((await item("S-4")).textContent).toContain("Didn't run: @ceo was archived");
});

test("Pause and Resume apply at once with their outcomes; Delete leaves the row with Undo, which restores it", async () => {
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": () => list([sched(3)]),
    "POST /api/schedules/S-3/pause": () =>
      json({ schedule: sched(3, { state: "paused", paused: true }) }),
    "POST /api/schedules/S-3/resume": () => json({ schedule: sched(3) }),
    "DELETE /api/schedules/S-3": () => json({ schedule: sched(3, { deleted: true }) }),
    "POST /api/schedules/S-3/restore": () => json({ schedule: sched(3) }),
  });
  const u = userEvent.setup();
  renderApp("/schedules", alice);
  await u.click(await screen.findByRole("button", { name: "Actions for S-3" }));
  api.on("GET /api/schedules?", () => list([sched(3, { state: "paused", paused: true })]));
  await u.click(await screen.findByRole("menuitem", { name: "Pause" }));
  expect(await screen.findByText("Paused S-3.")).toBeInTheDocument();
  await u.click(screen.getByRole("button", { name: "Actions for S-3" }));
  api.on("GET /api/schedules?", () => list([sched(3)]));
  await u.click(await screen.findByRole("menuitem", { name: "Resume" }));
  expect(
    await screen.findByText("Resumed S-3. Next run: Mon 23 Nov 09:00 Europe/Berlin."),
  ).toBeInTheDocument();
  api.on("GET /api/schedules?", () => list([]));
  await u.click(screen.getByRole("button", { name: "Actions for S-3" }));
  expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  await u.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(await screen.findByText("Deleted S-3.")).toBeInTheDocument();
  const undo = screen.getByRole("button", { name: "Undo" });
  await waitFor(() => expect(undo).toHaveFocus());
  expect(screen.queryByRole("link", { name: /^S-3,/ })).not.toBeInTheDocument();
  api.on("GET /api/schedules?", () => list([sched(3)]));
  await u.click(undo);
  expect(await screen.findByText("Restored S-3.")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Actions for S-3" })).toHaveFocus(),
  );
});

test("a failed Pause says so with Retry; a restore refused because the target ended says why", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": () => list([sched(3)]),
    "POST /api/schedules/S-3/pause": () => json({ error: { code: "boom", message: "x" } }, 500),
    "DELETE /api/schedules/S-3": () => json({ schedule: sched(3, { deleted: true }) }),
    "POST /api/schedules/S-3/restore": () =>
      json({ error: { code: "target_ended", message: "@ceo was terminated." } }, 409),
  });
  const u = userEvent.setup();
  renderApp("/schedules", alice);
  await u.click(await screen.findByRole("button", { name: "Actions for S-3" }));
  await u.click(await screen.findByRole("menuitem", { name: "Pause" }));
  expect(await screen.findByText("Couldn't pause S-3.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  await u.click(screen.getByRole("button", { name: "Actions for S-3" }));
  await u.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await u.click(await screen.findByRole("button", { name: "Undo" }));
  expect(
    await screen.findByText("S-3 can't be restored: @ceo was terminated."),
  ).toBeInTheDocument();
});

test("filters live in the URL; empty states, the cap line and the load error", async () => {
  const api = mockApi({ "GET /api/agents?": agents, "GET /api/schedules?": () => list([]) });
  const u = userEvent.setup();
  const { router } = renderApp("/schedules", alice);
  expect(await screen.findByText("No schedules yet.")).toBeInTheDocument();
  await pickComboOption(await screen.findByLabelText("Target"), /@dev/);
  await waitFor(() => expect(router.state.location.search).toMatchObject({ target: "dev" }));
  expect(await screen.findByText("No schedules match these filters.")).toBeInTheDocument();
  await u.click(screen.getByLabelText("Show done"));
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/schedules?target=dev&done=true")).toBe(true),
  );
  await u.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  api.on("GET /api/schedules?", () => list([sched(1)], true));
  act(() => ws.push({ type: "schedules_changed" }));
  expect(await screen.findByText("Showing the first 500 schedules.")).toBeInTheDocument();
  api.on("GET /api/schedules?", () => json({ error: { code: "x", message: "x" } }, 500));
});

test("schedules_changed refetches and keeps focus on the same row's link", async () => {
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": () => list([sched(1), sched(2)]),
  });
  renderApp("/schedules", alice);
  const link = await screen.findByRole("link", { name: /^S-2,/ });
  link.focus();
  api.on("GET /api/schedules?", () => list([sched(2), sched(1)])); // reordered
  act(() => ws.push({ type: "schedules_changed" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Schedules" })).getAllByRole("listitem")[0]
        ?.textContent,
    ).toContain("S-2"),
  );
  expect(screen.getByRole("link", { name: /^S-2,/ })).toHaveFocus();
});

test("escaping: a hostile body shows as the literal first line, creates no element and runs nothing", async () => {
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  const hostile =
    "<img src=x onerror=alert(1)> <script>alert(2)</script> **bold** [x](javascript:alert(3))\n<b>second</b>";
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": () => list([sched(1, { body: hostile })]),
  });
  renderApp("/schedules", alice);
  const li = (await screen.findByRole("link", { name: /^S-1,/ })).closest("li") as HTMLElement;
  expect(li.textContent).toContain(
    "<img src=x onerror=alert(1)> <script>alert(2)</script> **bold** [x](javascript:alert(3))",
  );
  expect(li.querySelector("img, script, b, strong")).toBeNull();
  expect(
    [...li.querySelectorAll("a")].every((a) => !a.getAttribute("href")?.startsWith("javascript:")),
  ).toBe(true);
  expect(alert).not.toHaveBeenCalled();
});

test("the target filter lists Any agent first, live agents, then an Ended group", async () => {
  mockApi({
    "GET /api/agents?": (_b, url) =>
      json({
        agents: url.includes("ended=only")
          ? [
              agentSummary({
                slug: "old",
                displayName: "Old",
                terminatedAt: "2026-11-01T00:00:00Z",
              }),
            ]
          : [agentSummary({ slug: "dev" })],
        more: false,
        running: { count: 0, max: 8 },
      }),
    "GET /api/schedules?": () => list([]),
  });
  renderApp("/schedules", alice);
  const trigger = await screen.findByLabelText("Target");
  const names = await comboOptionNames(trigger);
  expect(names[0]).toBe("Any agent");
  expect(names.length).toBe(3);
  expect(names[2]).toMatch(/Old/);
  await userEvent.click(trigger);
  expect(await screen.findByText("Ended")).toBeInTheDocument();
});
