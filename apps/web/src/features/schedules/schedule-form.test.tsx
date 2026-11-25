import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearDraft } from "@/features/sheets/drafts";
import { closeSheet } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { pickComboOption, pickOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";
import { zoneGroups, zoneOffset } from "./timezone-select";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
beforeEach(() => {
  fakeMatchMedia.install(false);
  clearDraft("new-schedule");
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const agents = () =>
  json({
    agents: [
      agentSummary({ slug: "ceo", displayName: "CEO" }),
      agentSummary({
        slug: "kid",
        displayName: "Kid",
        kind: "ephemeral",
        reportsTo: { kind: "agent", handle: "ceo" },
      }),
    ],
    more: false,
    running: { count: 0 },
  });
const base = () => ({
  "GET /api/agents?": agents,
  "GET /api/schedules": () => json({ schedules: [], more: false }),
  "GET /api/schedules?": () => json({ schedules: [], more: false }),
});
const item = {
  key: "S-8",
  target: { slug: "ceo", displayName: "CEO", archived: false, terminated: false },
  cron: "0 9 * * 1-5",
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

/** The agents arrive asynchronously: wait for the option before choosing it. */
async function pick(slug: string) {
  await pickOption(
    await within(await screen.findByRole("dialog")).findByLabelText("Target"),
    new RegExp(`@${slug}$`),
  );
}

/** Repeats starts unchosen; the cron input exists once Custom is chosen. */
async function chooseCustom() {
  await pickOption(screen.getByRole("combobox", { name: "Repeats" }), "Custom cron…");
}

async function openNew() {
  const api = mockApi({ ...base(), "POST /api/schedules": () => json({ schedule: item }, 201) });
  renderApp("/schedules/new", alice);
  await screen.findByRole("dialog", { name: "New schedule" });
  await screen.findByRole("combobox", { name: "Repeats" });
  return api;
}

test("the When fieldset: two radios, only the chosen field in the DOM, the other's value kept", async () => {
  await openNew();
  await chooseCustom();
  const when = screen.getByRole("group", { name: "When" });
  expect(
    within(when)
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).value),
  ).toEqual(["repeats", "once"]);
  expect(
    screen.getByLabelText("Repeats", { selector: "input[type=text], input:not([type])" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Date and time")).toBeNull();
  expect(
    screen.getByText(
      /A 5-field cron expression: minute hour day-of-month month day-of-week\. Examples:/,
    ),
  ).toBeInTheDocument();
  await userEvent.type(
    screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" }),
    "0 9 * * *",
  );
  await userEvent.click(screen.getByRole("radio", { name: "Once" }));
  expect(screen.getByLabelText("Date and time")).toBeInTheDocument();
  expect(screen.queryByLabelText("Repeats", { selector: "input:not([type=radio])" })).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: "Repeats" }));
  // Back on Repeats the value is read again: "0 9 * * *" is a preset, so the Select names it.
  expect(screen.getByRole("combobox", { name: "Repeats" })).toHaveTextContent("Daily at 09:00");
});

test("the zone select is grouped by region, always holds UTC and the current value, and names its value", async () => {
  const g = zoneGroups("Mars/Base", ["Europe/Berlin", "America/New_York"]);
  expect(g.map((x) => x.region)).toEqual(["America", "Europe", "Other"]);
  expect(g.find((x) => x.region === "Other")?.zones).toEqual(["Mars/Base", "UTC"]);
  await openNew();
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(screen.getByRole("combobox", { name: /^Time zone, / })).toHaveAccessibleName(
    `Time zone, ${detected}`,
  );
});

test("the preview updates on blur and zone change, not per keystroke, with 'your time' when zones differ", async () => {
  await openNew();
  await chooseCustom();
  const cron = screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" });
  await userEvent.type(cron, "0 9 * * 1-5");
  expect(screen.queryByText(/^Next runs:/)).toBeNull(); // not per keystroke
  await pickComboOption(screen.getByRole("combobox", { name: /^Time zone, / }), "Asia/Tokyo");
  const text = (await screen.findByText(/^Next runs:/)).textContent ?? "";
  expect(text).toMatch(/^Next runs: \w{3} \d+ \w{3} 09:00 .*· .* · .* Asia\/Tokyo$/);
  expect(text).toContain("your time)");
  await userEvent.clear(cron);
  await userEvent.type(cron, "bad");
  await userEvent.tab();
  await waitFor(() => expect(screen.queryByText(/^Next runs:/)).toBeNull());
});

test("validates on leave with each sentence; submit focuses the first invalid field", async () => {
  await openNew();
  await chooseCustom();
  const cron = screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" });
  // Leaving an untouched field says nothing.
  await userEvent.click(cron);
  await userEvent.tab();
  expect(document.getElementById("field-cron-error")).not.toHaveAttribute("data-shown");
  await userEvent.type(cron, "x");
  await userEvent.clear(cron);
  await userEvent.tab();
  expect(await screen.findByText("Enter a pattern.")).toBeInTheDocument();
  await userEvent.type(cron, "@daily");
  await userEvent.tab();
  expect(await screen.findByText("Use 5 fields, like 0 9 * * 1-5.")).toBeInTheDocument();
  await userEvent.clear(cron);
  await userEvent.type(cron, "0 9 L * *");
  await userEvent.tab();
  expect(await screen.findByText("Use numbers, *, -, / and commas.")).toBeInTheDocument();
  await userEvent.clear(cron);
  await userEvent.type(cron, "61 * * * *");
  await userEvent.tab();
  expect(
    await screen.findByText(/minute/i, { selector: "#field-cron-error span" }),
  ).toBeInTheDocument();
  expect(document.getElementById("field-cron-error")).toHaveAttribute("data-shown");
  await userEvent.clear(cron);
  await userEvent.type(cron, "0 0 30 2 *");
  await userEvent.tab();
  expect(await screen.findByText("This pattern never runs.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  expect(await screen.findByText("Choose an agent.")).toBeInTheDocument();
  expect(await screen.findByText("Enter a message.")).toBeInTheDocument();
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).getByLabelText("Target")).toHaveFocus(),
  );
  // The Message editor's frame takes the invalid edge with its note.
  expect(screen.getByLabelText("Message")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Message").closest("[data-invalid]")).not.toBeNull();
});

test("a server failure with no field says so above the buttons, and Create stays usable", async () => {
  mockApi({
    ...base(),
    "POST /api/schedules": () =>
      json({ error: { code: "internal_error", message: "Database is down" } }, 500),
  });
  renderApp("/schedules/new", alice);
  await screen.findByRole("dialog", { name: "New schedule" });
  await pick("ceo");
  await pickOption(screen.getByRole("combobox", { name: "Repeats" }), "Weekdays at 09:00");
  await userEvent.type(screen.getByLabelText("Message"), "x");
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  const dialog = screen.getByRole("dialog");
  await waitFor(() =>
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toContain("Couldn't save the schedule. Try again."),
  );
  expect(screen.getByRole("button", { name: "Create schedule" })).not.toHaveAttribute(
    "aria-disabled",
  );
});

test("the target picker starts at 'Choose an agent…' and a spawned agent adds the helper", async () => {
  await openNew();
  expect(within(screen.getByRole("dialog")).getByLabelText("Target")).toHaveTextContent(
    "Choose an agent…",
  );
  expect(screen.getByText("The schedule wakes this agent at each run.")).toBeInTheDocument();
  await pick("kid");
  expect(
    await screen.findByText(
      /Spawned agents end when their work is done; this schedule is deleted with it\./,
    ),
  ).toBeInTheDocument();
});

test("creating sends the form's values and closes the sheet", async () => {
  const api = await openNew();
  await chooseCustom();
  await pick("ceo");
  await userEvent.type(
    screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" }),
    "0 9 * * 1-5",
  );
  await userEvent.type(screen.getByLabelText("Message"), "Review the board");
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New schedule" })).toBeNull());
  const post = api.calls.find((c) => c.method === "POST");
  expect(post?.body).toMatchObject({
    target: "ceo",
    cron: "0 9 * * 1-5",
    body: "Review the board",
  });
  expect(post?.body).toHaveProperty("timezone", expect.any(String));
  expect(screen.getByRole("heading", { name: "Schedules" })).toBeInTheDocument();
});

test("a server field error maps to its field", async () => {
  mockApi({
    ...base(),
    "POST /api/schedules": () =>
      json(
        {
          error: {
            code: "invalid_schedule",
            message: "Server says no.",
            fields: { cron: "Server says no." },
          },
        },
        400,
      ),
  });
  renderApp("/schedules/new", alice);
  await screen.findByRole("dialog", { name: "New schedule" });
  await screen.findByRole("combobox", { name: "Repeats" });
  await pick("ceo");
  await chooseCustom();
  await userEvent.type(
    screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" }),
    "0 9 * * *",
  );
  await userEvent.type(screen.getByLabelText("Message"), "x");
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  expect(await screen.findByText("Server says no.")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" })).toHaveFocus(),
  );
});

test("the zone typeahead finds a zone by its city, keeps UTC and the current value, and matches the offset", async () => {
  await openNew();
  const trigger = screen.getByRole("combobox", { name: /^Time zone, / });
  await userEvent.click(trigger);
  await userEvent.keyboard("new york");
  const hits = (await screen.findAllByRole("option")).map((o) =>
    (o.textContent ?? "").replace(/, selected$/, ""),
  );
  expect(hits).toContain("America/New_York");
  expect(hits).not.toContain("Europe/Berlin");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger);
  const all = (await screen.findAllByRole("option")).map((o) =>
    (o.textContent ?? "").replace(/, selected$/, ""),
  );
  expect(all).toContain("UTC");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger);
  await userEvent.keyboard("gmt+9");
  expect(
    (await screen.findAllByRole("option")).map((o) =>
      (o.textContent ?? "").replace(/, selected$/, ""),
    ),
  ).toContain("Asia/Tokyo");
});

test("a zone's offset is computed once and cached", () => {
  const spy = vi.spyOn(Intl, "DateTimeFormat");
  const first = zoneOffset("Asia/Tokyo");
  const calls = spy.mock.calls.length;
  expect(zoneOffset("Asia/Tokyo")).toBe(first);
  expect(spy.mock.calls.length).toBe(calls);
  expect(first).toMatch(/GMT\+9/);
  spy.mockRestore();
});

test("Repeats starts unchosen, Time zone follows When, the preview sits under Repeats", async () => {
  await openNew();
  expect(screen.getByRole("combobox", { name: "Repeats" })).toHaveTextContent("Choose…");
  const when = screen.getByRole("group", { name: "When" });
  const zone = screen.getByRole("combobox", { name: /^Time zone, / });
  expect(when.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const repeats = screen.getByRole("combobox", { name: "Repeats" });
  await pickOption(repeats, "Weekdays at 09:00");
  const zoneLabel = screen.getByText("Time zone");
  const live = await screen.findByText(/^Next runs:/);
  expect(repeats.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(live.compareDocumentPosition(zoneLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a submit from the Message's Preview goes back to Write and focuses it when it's the only invalid field", async () => {
  const api = await openNew();
  await pick("ceo");
  await pickOption(screen.getByRole("combobox", { name: "Repeats" }), "Weekdays at 09:00");
  const message = screen.getByLabelText("Message");
  const frame = message.closest("[data-slot=tabs]") as HTMLElement;
  await userEvent.click(within(frame).getByRole("tab", { name: "Preview" }));
  expect(screen.queryByLabelText("Message")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  const back = await screen.findByLabelText("Message");
  await waitFor(() => expect(back).toHaveFocus());
  expect(back).toHaveAttribute("aria-invalid", "true");
  expect(back).toHaveAccessibleDescription("Enter a message.");
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
});

test("from Preview with an earlier field invalid too, the earlier field keeps the focus", async () => {
  await openNew();
  await pickOption(screen.getByRole("combobox", { name: "Repeats" }), "Weekdays at 09:00");
  const frame = screen.getByLabelText("Message").closest("[data-slot=tabs]") as HTMLElement;
  await userEvent.click(within(frame).getByRole("tab", { name: "Preview" }));
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  const back = await screen.findByLabelText("Message");
  expect(back).toHaveAttribute("aria-invalid", "true");
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).getByLabelText("Target")).toHaveFocus(),
  );
});
