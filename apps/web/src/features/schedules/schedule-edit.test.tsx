import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { pickOption } from "@/test/select-helpers";
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
afterEach(() => vi.unstubAllGlobals());

const user = { kind: "user", handle: "or" };
const sched = (o: Record<string, unknown> = {}) => ({
  key: "S-3",
  target: { slug: "ceo", displayName: "CEO", archived: false, terminated: false },
  cron: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  body: "Morning review",
  nextRunAt: "2099-11-23T08:00:00.000Z",
  lastFiredAt: null,
  paused: false,
  done: false,
  createdBy: user,
  bodyAuthor: user,
  pendingFiring: false,
  state: "active",
  ...o,
});
const agents = () =>
  json({
    agents: [agentSummary({ slug: "ceo", displayName: "CEO" })],
    more: false,
    running: { count: 0, max: 8 },
  });
const detail = (s: unknown) => () => json({ schedule: s });
const common = (s: unknown) => ({
  "GET /api/agents?": agents,
  "GET /api/schedules/S-3": detail(s),
  "GET /api/schedules?": () => json({ schedules: [], more: false }),
  "GET /api/schedules": () => json({ schedules: [], more: false }),
});
const message = () => screen.findByLabelText("Message");

test("save sends only the changed fields; Saved. appears", async () => {
  const api = mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": () => json({ schedule: sched({ body: "Evening review" }) }),
  });
  renderApp("/schedules/S-3", alice);
  const body = await message();
  await userEvent.clear(body);
  await userEvent.type(body, "Evening review");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
  expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ body: "Evening review" });
});

test("a done one-shot's message can still be edited: only that field is validated and sent", async () => {
  const done = sched({
    cron: undefined,
    at: "2020-01-01T09:00:00.000Z",
    timezone: "UTC",
    nextRunAt: null,
    done: true,
    ran: true,
    state: "done",
    lastFiredAt: "2020-01-01T09:00:00.000Z",
  });
  const api = mockApi({
    ...common(done),
    "PATCH /api/schedules/S-3": () => json({ schedule: done }),
  });
  renderApp("/schedules/S-3", alice);
  expect(
    await screen.findByText("Done. Set a future date and time to run it again."),
  ).toBeInTheDocument();
  await userEvent.type(await message(), " more");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
  expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({
    body: "Morning review more",
  });
});

test("an archived target stays selected as an extra option; the helper names the author change; pending notes", async () => {
  const s = sched({
    target: { slug: "old", displayName: "Old", archived: true, terminated: false },
    bodyAuthor: { kind: "agent", slug: "lead", archived: false, terminated: false },
    pendingFiring: true,
    state: "pending_errored",
  });
  mockApi(common(s));
  renderApp("/schedules/S-3", alice);
  const target = await screen.findByLabelText("Target");
  await waitFor(() => expect(target).toHaveTextContent("@old (archived)"));
  expect(screen.getByText("Saving a changed message makes you its author.")).toBeInTheDocument();
  expect(
    screen.getByText("A run is waiting for @old, which is errored. Edits apply from the next run."),
  ).toBeInTheDocument();
});

test("pause, resume and delete are header actions; delete returns to the list", async () => {
  const api = mockApi({
    ...common(sched()),
    "POST /api/schedules/S-3/pause": () =>
      json({ schedule: sched({ paused: true, state: "paused" }) }),
    "DELETE /api/schedules/S-3": () => json({ schedule: sched({ deleted: true }) }),
  });
  renderApp("/schedules/S-3", alice);
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "Pause" }))[0] as HTMLElement,
  );
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/schedules/S-3/pause")).toBe(true),
  );
  await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0] as HTMLElement);
  // The list no longer shows a page-to-page outcome; the edit sheet's Deleted toast arrives with Task 11.
  expect(await screen.findByRole("heading", { name: "Schedules" })).toBeInTheDocument();
});

test("not found: the route's not-found state", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules/S-99": () =>
      json({ error: { code: "schedule_not_found", message: "x" } }, 404),
  });
  renderApp("/schedules/S-99", alice);
  expect(await screen.findByText("There is no schedule S-99.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to schedules" })).toBeInTheDocument();
});

test("deleted: read-only with Restore; none when the target was terminated; a hostile body stays text", async () => {
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  const hostile =
    "<img src=x onerror=alert(1)><script>alert(2)</script> **b** [x](javascript:alert(3))";
  const api = mockApi({
    ...common(sched({ deleted: true, body: hostile })),
    "POST /api/schedules/S-3/restore": () => json({ schedule: sched() }),
  });
  const { container } = renderApp("/schedules/S-3", alice);
  expect(await screen.findByText("S-3 was deleted.")).toBeInTheDocument();
  expect(await message()).toBeDisabled();
  expect(container.querySelector("img, script")).toBeNull();
  expect(
    [...container.querySelectorAll("a")].some((a) =>
      a.getAttribute("href")?.startsWith("javascript:"),
    ),
  ).toBe(false);
  expect(alert).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/schedules/S-3/restore")).toBe(true),
  );
});

test("deleted with a terminated target offers no Restore", async () => {
  mockApi(
    common(
      sched({
        deleted: true,
        target: { slug: "kid", displayName: "Kid", archived: false, terminated: true },
      }),
    ),
  );
  renderApp("/schedules/S-3", alice);
  expect(await screen.findByText("S-3 was deleted.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
});

test("live: schedules_changed refreshes untouched fields and keeps edited ones", async () => {
  const api = mockApi(common(sched()));
  renderApp("/schedules/S-3", alice);
  const body = (await message()) as HTMLTextAreaElement;
  await userEvent.type(body, " edited");
  api.on(
    "GET /api/schedules/S-3",
    detail(sched({ cron: "0 10 * * *", body: "Changed elsewhere" })),
  );
  act(() => ws.push({ type: "schedules_changed" }));
  const cron = (await screen.findByLabelText("Repeats", {
    selector: "input:not([type=radio])",
  })) as HTMLInputElement;
  await waitFor(() => expect(cron.value).toBe("0 10 * * *"));
  expect(body.value).toBe("Morning review edited"); // the user's edit is kept
});

test("live: a server change to the timing refreshes the Next runs preview", async () => {
  const api = mockApi(common(sched()));
  renderApp("/schedules/S-3", alice);
  const before = (await screen.findByText(/^Next runs:/)).textContent;
  api.on("GET /api/schedules/S-3", detail(sched({ cron: "0 10 * * *" })));
  act(() => ws.push({ type: "schedules_changed" }));
  await waitFor(() => expect(screen.getByText(/^Next runs:/).textContent).not.toBe(before));
});

test("live: the preview is the summary of the merged value (edited cron kept, untouched zone and message follow the server)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  try {
    const api = mockApi(common(sched()));
    renderApp("/schedules/S-3", alice);
    await pickOption(await screen.findByRole("combobox", { name: "Repeats" }), "Custom cron…");
    const cron = (await screen.findByLabelText("Repeats", {
      selector: "input:not([type=radio])",
    })) as HTMLInputElement;
    await userEvent.clear(cron);
    await userEvent.type(cron, "30 8 * * *");
    await userEvent.tab(); // blur: the preview reads the edited cron
    api.on("GET /api/schedules/S-3", detail(sched({ timezone: "Asia/Tokyo", body: "Other" })));
    act(() => ws.push({ type: "schedules_changed" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Other"),
    );
    // Literal runs of the edited cron in the server's zone; "your time" depends on the machine's zone.
    expect(screen.getByText(/^Next runs:/).textContent).toMatch(
      /^Next runs: Sun 22 Nov 08:30( \(.+ your time\))? · Mon 23 Nov 08:30 · Tue 24 Nov 08:30 Asia\/Tokyo$/,
    );
    expect(cron.value).toBe("30 8 * * *");
  } finally {
    vi.useRealTimers();
  }
});
