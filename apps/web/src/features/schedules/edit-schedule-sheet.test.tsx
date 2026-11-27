import { ApiError, type ServerMessage } from "@open-factory/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft, hasDraft, resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { pickOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";
import { scheduleDetailOptions } from "./api";
import { ScheduleBadge } from "./schedule-badge";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: ServerMessage) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));

beforeEach(() => {
  fakeMatchMedia.install(false);
  clearDraft("edit-schedule:S-3");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const user = { kind: "human", ref: refFor("or"), handle: "or" };
const sched = (o: Record<string, unknown> = {}) => ({
  key: "S-3",
  target: {
    ref: refFor("ceo"),
    handle: "ceo",
    displayName: "CEO",
    archived: false,
    terminated: false,
  },
  cron: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  body: "Morning review\nsecond line",
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
    agents: [agentSummary({ handle: "ceo", displayName: "CEO" })],
    more: false,
    running: { count: 0 },
  });
const detail = (s: unknown) => () => json({ schedule: s });
const common = (s: unknown) => ({
  "GET /api/agents?": agents,
  "GET /api/schedules/S-3": detail(s),
  "GET /api/schedules?": () => json({ schedules: [], more: false }),
  "GET /api/schedules": () => json({ schedules: [], more: false }),
});
const sheet = () => screen.findByRole("dialog", { name: "S-3" });
const message = async () => within(await sheet()).findByLabelText("Message");
const openOver = async (path = "/schedules") => {
  const r = renderApp(path, alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "edit-schedule", key: "S-3" }));
  return r;
};

test("the header has the key, the first line, and an icon Pause named with the key", async () => {
  mockApi(common(sched()));
  await openOver();
  const dialog = await sheet();
  expect(within(dialog).getByText("S-3")).toBeInTheDocument();
  expect(await within(dialog).findByText("Morning review", { selector: "[id]" })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Pause S-3" })).toBeInTheDocument();
});

test("the footer has Save changes, Close and Delete schedule", async () => {
  mockApi(common(sched()));
  await openOver();
  const dialog = await sheet();
  await message();
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  expect(within(dialog).getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  expect(within(dialog).getByRole("button", { name: "Delete schedule" })).toBeInTheDocument();
});

test("phones: the footer stacks Save changes first and Close last, Delete between", async () => {
  fakeMatchMedia.install(true);
  mockApi(common(sched()));
  await openOver();
  await message();
  const footer = (await sheet()).querySelector("[data-slot=drawer-footer]") as HTMLElement;
  const names = within(footer)
    .getAllByRole("button")
    .map((b) => b.textContent);
  expect(names).toEqual(["Save changes", "Delete schedule", "Close"]);
});

test("desktop: the first field takes focus when the form mounts", async () => {
  mockApi(common(sched()));
  await openOver();
  await message();
  await waitFor(() =>
    expect(
      within(screen.getByRole("dialog", { name: "S-3" })).getByLabelText("Target"),
    ).toHaveFocus(),
  );
});

test("deleted: Restore takes focus on open", async () => {
  mockApi(common(sched({ deleted: true })));
  await openOver();
  const dialog = await sheet();
  const restore = await within(dialog).findByRole("button", { name: "Restore" });
  await waitFor(() => expect(restore).toHaveFocus());
});

test("swapping to another schedule in place shows that schedule's values, not the first one's edits", async () => {
  clearDraft("edit-schedule:S-4");
  mockApi({
    ...common(sched()),
    "GET /api/schedules/S-4": detail(sched({ key: "S-4", body: "Evening wrap" })),
  });
  const { queryClient } = await openOver();
  await userEvent.type(await message(), " edited");
  // S-4 already cached, so the body swaps without a skeleton in between (the case a key on the body guards).
  await queryClient.fetchQuery(scheduleDetailOptions("S-4"));
  act(() => openSheet({ kind: "edit-schedule", key: "S-4" }));
  const s4 = await screen.findByRole("dialog", { name: "S-4" });
  expect(await within(s4).findByLabelText("Message")).toHaveValue("Evening wrap");
  expect(within(s4).queryByText(/Draft restored/)).toBeNull();
  clearDraft("edit-schedule:S-4");
});

test("Pause and Resume are the header action; a state line sits above the form", async () => {
  const api = mockApi({
    ...common(sched()),
    "POST /api/schedules/S-3/pause": () =>
      json({ schedule: sched({ paused: true, state: "paused" }) }),
    "POST /api/schedules/S-3/resume": () => json({ schedule: sched() }),
  });
  await openOver();
  const dialog = await sheet();
  expect(await within(dialog).findByText("Active")).toBeInTheDocument();
  expect(within(dialog).getByText("@or")).toBeInTheDocument();
  api.on("GET /api/schedules/S-3", detail(sched({ paused: true, state: "paused" })));
  await userEvent.click(within(dialog).getByRole("button", { name: "Pause S-3" }));
  expect(await within(dialog).findByRole("button", { name: "Resume S-3" })).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/schedules/S-3/pause")).toBe(true);
});

test("save sends only the changed fields, closes, clears the draft and says nothing over /schedules", async () => {
  const api = mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": () => json({ schedule: sched({ body: "Evening" }) }),
  });
  await openOver("/schedules");
  const body = await message();
  await userEvent.clear(body);
  await userEvent.type(body, "Evening");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
  expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ body: "Evening" });
  expect(hasDraft("edit-schedule:S-3")).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

test("save toasts Saved. when the sheet is over another page", async () => {
  mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": () => json({ schedule: sched({ body: "Evening" }) }),
  });
  await openOver("/inbox");
  const body = await message();
  await userEvent.clear(body);
  await userEvent.type(body, "Evening");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Saved S-3." }));
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
  await openOver();
  expect(
    await screen.findByText("Done. Set a future date and time to run it again."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^(Pause|Resume)/ })).toBeNull();
  await userEvent.type(await message(), " more");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
  expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({
    body: "Morning review\nsecond line more",
  });
});

test("a leave-flagged Date and time reverted, then a Message edit saves: only changed fields count (the subset rule)", async () => {
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
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...common(done),
    "PATCH /api/schedules/S-3": async () => {
      await gate;
      return json({ schedule: done });
    },
  });
  await openOver();
  const at = await within(await sheet()).findByLabelText("Date and time");
  await userEvent.click(at);
  fireEvent.change(at, { target: { value: "2020-01-02T09:00" } });
  await userEvent.tab();
  expect(await screen.findByText("That time has passed.")).toBeInTheDocument();
  await userEvent.click(at);
  fireEvent.change(at, { target: { value: "2020-01-01T09:00" } });
  await userEvent.type(await message(), " more");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Saving…" });
  expect(at).not.toHaveAttribute("aria-invalid");
  expect(document.getElementById("field-at-error")).not.toHaveAttribute("data-shown");
  expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({
    body: "Morning review\nsecond line more",
  });
  release();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
});

test("a server field error on save focuses its field; a failure with no field says so above the buttons", async () => {
  let fields: Record<string, string> | undefined = { body: "Server says no." };
  mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": () =>
      json({ error: { code: "invalid_schedule", message: "Server says no.", fields } }, 400),
  });
  await openOver();
  await userEvent.type(await message(), " x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Server says no.")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveFocus());
  fields = undefined;
  await userEvent.type(screen.getByLabelText("Message"), "y");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Couldn't save the schedule. Try again.")).toBeInTheDocument();
});

test("leaving an edited, invalid Message for Delete schedule doesn't validate it; leaving it for Save does", async () => {
  mockApi(common(sched()));
  await openOver();
  const msg = await message();
  await userEvent.clear(msg);
  const del = screen.getByRole("button", { name: "Delete schedule" });
  expect(del).toHaveAttribute("data-skip-validate");
  // A keyboard move: the blur's relatedTarget is the Delete button, with no pointerdown to fall back on.
  act(() => del.focus());
  expect(msg).not.toHaveAttribute("aria-invalid");
  act(() => msg.focus());
  act(() => screen.getByRole("button", { name: "Save changes" }).focus());
  expect(msg).toHaveAttribute("aria-invalid", "true");
  expect(msg).toHaveAccessibleDescription("Enter a message.");
});

test("an archived target stays selected as an extra option; the helper names the author change; pending notes", async () => {
  mockApi(
    common(
      sched({
        target: {
          ref: refFor("old"),
          handle: "old",
          displayName: "Old",
          archived: true,
          terminated: false,
        },
        bodyAuthor: {
          kind: "agent",
          ref: "ref-lead",
          handle: "lead",
          archived: false,
          terminated: false,
        },
        pendingFiring: true,
        state: "pending_errored",
      }),
    ),
  );
  await openOver();
  const target = await within(await sheet()).findByLabelText("Target");
  await waitFor(() => expect(target).toHaveTextContent("@old (archived)"));
  expect(screen.getByText("Saving a changed message makes you its author.")).toBeInTheDocument();
  expect(
    screen.getByText("A run is waiting for @old, which is errored. Edits apply from the next run."),
  ).toBeInTheDocument();
});

test("Delete closes, clears the draft and toasts Deleted with Undo, which restores", async () => {
  const api = mockApi({
    ...common(sched()),
    "DELETE /api/schedules/S-3": () => json({ schedule: sched({ deleted: true }) }),
    "POST /api/schedules/S-3/restore": () => json({ schedule: sched() }),
  });
  await openOver();
  await userEvent.type(await message(), " edited");
  expect(hasDraft("edit-schedule:S-3")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
  expect(hasDraft("edit-schedule:S-3")).toBe(false);
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n?.text).toBe("Deleted S-3.");
  await act(async () => void (await n?.undo?.()));
  expect(api.calls.some((c) => c.url === "/api/schedules/S-3/restore")).toBe(true);
});

test("an Undo refused with target_ended rejects with the server's message for the toaster", async () => {
  mockApi({
    ...common(sched()),
    "DELETE /api/schedules/S-3": () => json({ schedule: sched({ deleted: true }) }),
    "POST /api/schedules/S-3/restore": () =>
      json({ error: { code: "target_ended", message: "@ceo was terminated." } }, 409),
  });
  await openOver();
  await message();
  await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  const err = await n?.undo?.().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).message).toBe("@ceo was terminated.");
});

test("a failed Delete keeps the sheet open with a line", async () => {
  mockApi({
    ...common(sched()),
    "DELETE /api/schedules/S-3": () => json({ error: { code: "boom", message: "x" } }, 500),
  });
  await openOver();
  await message();
  await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
  expect(await screen.findByText("Couldn't delete S-3.")).toBeInTheDocument();
  expect(notify).not.toHaveBeenCalled();
});

test("deleted: text, Restore, no fields and no Save; a hostile body stays text", async () => {
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  const hostile =
    "<img src=x onerror=alert(1)><script>alert(2)</script> **b** [x](javascript:alert(3))";
  const api = mockApi({
    ...common(sched({ deleted: true, body: hostile })),
    "POST /api/schedules/S-3/restore": () => json({ schedule: sched() }),
  });
  await openOver();
  const dialog = await sheet();
  expect(await within(dialog).findByText("S-3 was deleted.")).toBeInTheDocument();
  expect(within(dialog).getByText("@ceo")).toBeInTheDocument();
  expect(within(dialog).getByText("Weekdays at 09:00")).toBeInTheDocument();
  expect(within(dialog).getByText(/Europe\/Berlin/)).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Message")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  expect(dialog.querySelector("img, script")).toBeNull();
  expect(
    [...dialog.querySelectorAll("a")].some((a) =>
      a.getAttribute("href")?.startsWith("javascript:"),
    ),
  ).toBe(false);
  expect(alert).not.toHaveBeenCalled();
  expect(within(dialog).getByText("b")).toBeInTheDocument(); // **b** rendered as markdown
  await userEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/schedules/S-3/restore")).toBe(true),
  );
});

test("deleted with a terminated target offers no Restore", async () => {
  mockApi(
    common(
      sched({
        deleted: true,
        target: {
          ref: refFor("kid"),
          handle: "kid",
          displayName: "Kid",
          archived: false,
          terminated: true,
        },
      }),
    ),
  );
  await openOver();
  expect(await screen.findByText("S-3 was deleted.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
});

test("deleted by an agent while open: the sheet flips and keeps the draft; Restore flips back to the form with the edits, no toast", async () => {
  const api = mockApi(common(sched()));
  await openOver();
  await userEvent.type(await message(), " edited");
  api.on("GET /api/schedules/S-3", detail(sched({ deleted: true })));
  act(() => ws.push({ type: "schedules_changed" }));
  expect(await screen.findByText("S-3 was deleted.")).toBeInTheDocument();
  expect(hasDraft("edit-schedule:S-3")).toBe(true);
  api.on("GET /api/schedules/S-3", detail(sched()));
  api.on("POST /api/schedules/S-3/restore", () => json({ schedule: sched() }));
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  const body = (await message()) as HTMLTextAreaElement;
  expect(body.value).toBe("Morning review\nsecond line edited");
  expect(notify).not.toHaveBeenCalled();
});

test("unknown key: There is no schedule S-3. with Close", async () => {
  mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules/S-3": () =>
      json({ error: { code: "schedule_not_found", message: "x" } }, 404),
  });
  await openOver();
  const dialog = await sheet();
  expect(await within(dialog).findByText("There is no schedule S-3.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Save changes" })).toBeNull();
  await userEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
});

test("live: schedules_changed refreshes untouched fields and keeps edited ones", async () => {
  const api = mockApi(common(sched()));
  await openOver();
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
  expect(body.value).toBe("Morning review\nsecond line edited");
});

test("live: a server change to the timing refreshes the Next runs preview", async () => {
  const api = mockApi(common(sched()));
  await openOver();
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
    await openOver();
    await pickOption(await screen.findByRole("combobox", { name: "Repeats" }), "Custom cron…");
    const cron = (await screen.findByLabelText("Repeats", {
      selector: "input:not([type=radio])",
    })) as HTMLInputElement;
    await userEvent.clear(cron);
    await userEvent.type(cron, "30 8 * * *");
    await userEvent.tab();
    api.on("GET /api/schedules/S-3", detail(sched({ timezone: "Asia/Tokyo", body: "Other" })));
    act(() => ws.push({ type: "schedules_changed" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Other"),
    );
    expect(screen.getByText(/^Next runs:/).textContent).toMatch(
      /^Next runs: Sun 22 Nov 08:30( \(.+ your time\))? · Mon 23 Nov 08:30 · Tue 24 Nov 08:30 Asia\/Tokyo$/,
    );
    expect(cron.value).toBe("30 8 * * *");
  } finally {
    vi.useRealTimers();
  }
});

test("a draft saved before the server changed an untouched field shows the server value; a touched field keeps the draft", async () => {
  const api = mockApi(common(sched()));
  await openOver();
  await userEvent.type(await message(), " mine");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
  api.on("GET /api/schedules/S-3", detail(sched({ timezone: "Asia/Tokyo" })));
  act(() => ws.push({ type: "schedules_changed" })); // the closed sheet's cached copy is now stale
  act(() => openSheet({ kind: "edit-schedule", key: "S-3" }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  expect(((await message()) as HTMLTextAreaElement).value).toBe("Morning review\nsecond line mine");
  const zone = await within(screen.getByRole("dialog")).findByLabelText("Time zone");
  await waitFor(() => expect(zone).toHaveTextContent(/Tokyo/));
});

/** Edits the message to "Evening" and saves with PATCH held until `release()`, closing the sheet while it is pending. */
async function saveThenClose() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": async () => {
      await gate;
      return json({ schedule: sched({ body: "Evening" }) });
    },
  });
  await openOver("/inbox");
  const body = await message();
  await userEvent.clear(body);
  await userEvent.type(body, "Evening");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Saving…" });
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
  return release;
}

test("a late save success clears the draft a reopened sheet still holds unchanged, and leaves that sheet open", async () => {
  const release = await saveThenClose();
  act(() => openSheet({ kind: "edit-schedule", key: "S-3" }));
  expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
  release();
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Saved S-3." }));
  expect(hasDraft("edit-schedule:S-3")).toBe(false);
  expect(screen.getByRole("dialog", { name: "S-3" })).toBeInTheDocument();
});

test("a late save success keeps edits made in a reopened sheet that was closed again", async () => {
  const release = await saveThenClose();
  act(() => openSheet({ kind: "edit-schedule", key: "S-3" }));
  await userEvent.type(await message(), " late");
  act(() => closeSheet());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S-3" })).toBeNull());
  release();
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Saved S-3." }));
  expect(hasDraft("edit-schedule:S-3")).toBe(true);
  act(() => openSheet({ kind: "edit-schedule", key: "S-3" }));
  expect(await message()).toHaveTextContent("Evening late");
});

test("a save landing after a sign-out neither toasts nor clears a draft", async () => {
  const release = await saveThenClose();
  act(() => resetDrafts());
  act(() => openSheet({ kind: "edit-schedule", key: "S-3" }));
  const body = await message();
  await userEvent.clear(body);
  await userEvent.type(body, "Evening");
  act(() => closeSheet());
  release();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
  expect(hasDraft("edit-schedule:S-3")).toBe(true);
});

test("a Delete landing after a sign-out does not toast", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...common(sched()),
    "DELETE /api/schedules/S-3": async () => {
      await gate;
      return json({ schedule: sched({ deleted: true }) });
    },
  });
  await openOver("/inbox");
  await message();
  await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
  act(() => closeSheet());
  act(() => resetDrafts());
  release();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
});

test("a double click on Pause sends one request", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...common(sched()),
    "POST /api/schedules/S-3/pause": async () => {
      await gate;
      return json({ schedule: sched({ paused: true }) });
    },
  });
  await openOver();
  await message();
  await userEvent.dblClick(screen.getByRole("button", { name: "Pause S-3" }));
  release();
  await waitFor(() => expect(api.calls.some((c) => c.url.includes("/pause"))).toBe(true));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(api.calls.filter((c) => c.url.includes("/pause"))).toHaveLength(1);
});

test("a late save failure toasts the error with Open form", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": async () => {
      await gate;
      return json({ error: { code: "internal_error", message: "Database is down" } }, 500);
    },
  });
  await openOver("/inbox");
  await userEvent.type(await message(), " x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Saving…" });
  act(() => closeSheet());
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n?.text).toBe("Database is down");
  expect(n?.action?.label).toBe("Open form");
  expect(hasDraft("edit-schedule:S-3")).toBe(true);
});

test("a ScheduleBadge opens the sheet for its key", async () => {
  render(<ScheduleBadge scheduleKey="S-3" />);
  await userEvent.click(screen.getByRole("button", { name: "Schedule S-3" }));
  expect(getSheetState().parent).toMatchObject({ kind: "edit-schedule", key: "S-3" });
});

test("a late Delete failure toasts the error with Open form", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...common(sched()),
    "DELETE /api/schedules/S-3": async () => {
      await gate;
      return json({ error: { code: "internal_error", message: "Database is down" } }, 500);
    },
  });
  await openOver("/inbox");
  await message();
  await userEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
  act(() => closeSheet());
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n?.text).toBe("Database is down");
  expect(n?.action?.label).toBe("Open form");
});

test("a double click on Delete sends one DELETE", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...common(sched()),
    "DELETE /api/schedules/S-3": async () => {
      await gate;
      return json({ schedule: sched({ deleted: true }) });
    },
  });
  await openOver();
  await message();
  const del = screen.getByRole("button", { name: "Delete schedule" });
  await userEvent.dblClick(del);
  release();
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
});

test("Delete is disabled while a Save is pending", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": async () => {
      await gate;
      return json({ schedule: sched({ body: "x" }) });
    },
  });
  await openOver();
  await userEvent.type(await message(), " x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Saving…" });
  expect(screen.getByRole("button", { name: "Delete schedule" })).toBeDisabled();
  release();
});

test("after a successful Save no draft exists once the refresh lands", async () => {
  const api = mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": () => json({ schedule: sched({ body: "Evening" }) }),
  });
  await openOver("/inbox");
  const body = await message();
  await userEvent.clear(body);
  await userEvent.type(body, "Evening");
  api.on("GET /api/schedules/S-3", detail(sched({ body: "Evening" })));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Saved S-3." }));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(hasDraft("edit-schedule:S-3")).toBe(false);
});

test("a late save success with no reopen clears the draft", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  mockApi({
    ...common(sched()),
    "PATCH /api/schedules/S-3": async () => {
      await gate;
      return json({ schedule: sched({ body: "x" }) });
    },
  });
  await openOver("/inbox");
  await userEvent.type(await message(), " x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Saving…" });
  act(() => closeSheet());
  expect(hasDraft("edit-schedule:S-3")).toBe(true);
  release();
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Saved S-3." }));
  expect(hasDraft("edit-schedule:S-3")).toBe(false);
});
