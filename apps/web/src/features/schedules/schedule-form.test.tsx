import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { pickComboOption, pickOption } from "@/test/select-helpers";
import { agentSummary } from "@/test/session-fixtures";
import { zoneGroups, zoneOffset } from "./timezone-select";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const agents = () =>
  json({
    agents: [
      agentSummary({ slug: "ceo", displayName: "CEO" }),
      agentSummary({ slug: "kid", displayName: "Kid", kind: "ephemeral", reportsTo: "ceo" }),
    ],
    more: false,
    running: { count: 0, max: 8 },
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
  await pickOption(await screen.findByLabelText("Target"), new RegExp(`@${slug}$`));
}

async function openNew() {
  const api = mockApi({ ...base(), "POST /api/schedules": () => json({ schedule: item }, 201) });
  renderApp("/schedules/new", alice);
  await screen.findByRole("heading", { name: "New schedule" });
  return api;
}

test("the When fieldset: two radios, only the chosen field in the DOM, the other's value kept", async () => {
  await openNew();
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
  expect(screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" })).toHaveValue(
    "0 9 * * *",
  );
});

test("the zone select is grouped by region, always holds UTC and the current value, and names its value", async () => {
  const g = zoneGroups("Mars/Base", ["Europe/Berlin", "America/New_York"]);
  expect(g.map((x) => x.region)).toEqual(["America", "Europe", "Other"]);
  expect(g.find((x) => x.region === "Other")?.zones).toEqual(["Mars/Base", "UTC"]);
  await openNew();
  expect(screen.getByRole("combobox", { name: /^Time zone, / })).toBeInTheDocument();
});

test("the preview updates on blur and zone change, not per keystroke, with 'your time' when zones differ", async () => {
  await openNew();
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
  const cron = screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" });
  await userEvent.click(cron);
  await userEvent.tab();
  expect(await screen.findByText("Enter a pattern.")).toBeInTheDocument();
  await userEvent.type(cron, "@daily");
  await userEvent.tab();
  expect(
    await screen.findByText("Use 5 fields: minute hour day-of-month month day-of-week."),
  ).toBeInTheDocument();
  await userEvent.clear(cron);
  await userEvent.type(cron, "0 9 L * *");
  await userEvent.tab();
  expect(
    await screen.findByText("Only numbers, *, ranges, lists, steps and names are allowed."),
  ).toBeInTheDocument();
  await userEvent.clear(cron);
  await userEvent.type(cron, "61 * * * *");
  await userEvent.tab();
  expect(await screen.findByText(/minute/i, { selector: "p" })).toBeInTheDocument();
  await userEvent.clear(cron);
  await userEvent.type(cron, "0 0 30 2 *");
  await userEvent.tab();
  expect(await screen.findByText("This pattern never runs.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  expect(await screen.findByText("Choose an agent.")).toBeInTheDocument();
  expect(await screen.findByText("Enter a message.")).toBeInTheDocument();
  expect(screen.getByLabelText("Target")).toHaveFocus();
});

test("the target picker starts at 'Choose an agent…' and a spawned agent adds the helper", async () => {
  await openNew();
  expect(screen.getByLabelText("Target")).toHaveTextContent("Choose an agent…");
  expect(screen.getByText("The schedule wakes this agent at each run.")).toBeInTheDocument();
  await pick("kid");
  expect(
    await screen.findByText(
      /Spawned agents end when their work is done; this schedule is deleted with it\./,
    ),
  ).toBeInTheDocument();
});

test("creating sends the form's values and returns to the list with Created S-8.", async () => {
  const api = await openNew();
  await pick("ceo");
  await userEvent.type(
    screen.getByLabelText("Repeats", { selector: "input:not([type=radio])" }),
    "0 9 * * 1-5",
  );
  await userEvent.type(screen.getByLabelText("Message"), "Review the board");
  await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  expect(await screen.findByText("Created S-8.")).toBeInTheDocument();
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
  await pick("ceo");
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
  const hits = (await screen.findAllByRole("option")).map((o) => o.textContent);
  expect(hits).toContain("America/New_York");
  expect(hits).not.toContain("Europe/Berlin");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger);
  const all = (await screen.findAllByRole("option")).map((o) => o.textContent);
  expect(all).toContain("UTC");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger);
  await userEvent.keyboard("gmt+9");
  expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toContain("Asia/Tokyo");
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
