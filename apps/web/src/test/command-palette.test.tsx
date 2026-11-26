import { type TaskSummary, taskListQuerySchema } from "@open-factory/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useShortcut } from "@/lib/shortcuts";
import type { WsOptions } from "@/lib/ws";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, type MockApi, mockApi, validQuery } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, conversation, detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_opts: WsOptions) => ({ close() {}, status: () => "connecting", send: () => true }),
}));

const task = (key: string, title: string, status: TaskSummary["status"] = "open"): TaskSummary => ({
  key,
  title,
  status,
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "alice" },
  updatedAt: "2026-11-18T10:00:00.000Z",
});

const live = [
  agentSummary({ slug: "dev", displayName: "Dev agent" }),
  agentSummary({
    slug: "devops",
    displayName: "Ops",
    reportsTo: { kind: "agent", ref: "aaaaaaaa", handle: "dev" },
  }),
];
const ended = [
  agentSummary({
    slug: "dev-old",
    displayName: "Old dev",
    terminatedAt: "2026-11-01T00:00:00.000Z",
  }),
];

let api: MockApi;
let search: (url: string) => Response | Promise<Response>;
beforeEach(() => {
  localStorage.clear();
  search = () => json({ tasks: [], nextCursor: null });
  api = mockApi({
    "GET /api/agents?ended=exclude": () => json({ agents: live, running: { count: 0 } }),
    "GET /api/agents?ended=only": () => json({ agents: ended, more: false, running: { count: 0 } }),
    "GET /api/tasks?": validQuery(taskListQuerySchema, (_b, url) => {
      const q = new URL(url, "http://x").searchParams;
      if (q.get("keys"))
        return json({
          tasks: q.get("keys") === "T-42" ? [task("T-42", "Fix the deploy", "done")] : [],
          nextCursor: null,
        });
      return search(url);
    }),
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () => json(conversation()),
  });
});
afterEach(() => vi.useRealTimers());

/** Binds the single key "x" while mounted. */
function Probe({ on }: { on: () => void }) {
  useShortcut("x", on);
  return null;
}

const searchCalls = () => api.calls.filter((c) => /[?&]q=/.test(c.url)).map((c) => c.url);

async function openFromInput() {
  const r = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  const outside = document.createElement("input");
  document.body.append(outside);
  outside.focus();
  fireEvent.keyDown(outside, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  outside.remove();
  return { ...r, dialog, input: within(dialog).getByRole("combobox") };
}

const options = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("option")
    .map((o) => o.textContent);
const highlighted = (dialog: HTMLElement) =>
  dialog.querySelector('[role="option"][aria-selected="true"]');

test("⌘K opens from inside an input; overlay and content carry data-instant", async () => {
  const { dialog, input } = await openFromInput();
  expect(dialog).toHaveAttribute("data-instant");
  const overlay = document.querySelector("[data-slot='palette-overlay']");
  expect(overlay).toHaveAttribute("data-instant");
  expect(input).toHaveFocus();
  // A modal is open: a single-key shortcut doesn't fire behind it.
  const fired = vi.fn();
  render(<Probe on={fired} />);
  fireEvent.keyDown(document.body, { key: "x" });
  expect(fired).not.toHaveBeenCalled();
  // Esc closes it.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
});

test("'T-42' shows 'Open T-42' first at once; Enter navigates; title fills in without moving the highlight", async () => {
  const { dialog, input, router } = await openFromInput();
  await userEvent.type(input, " T-42 ");
  const first = within(dialog).getAllByRole("option")[0];
  expect(first).toHaveTextContent("Open T-42");
  expect(highlighted(dialog)).toBe(first);
  await within(dialog).findByText("Fix the deploy");
  expect(highlighted(dialog)).toHaveTextContent("Open T-42");
  expect(api.calls.some((c) => c.url.includes("keys=T-42") && c.url.includes("status=all"))).toBe(
    true,
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/T-42"));
  expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
});

test("title search fires once after 150ms debounce with status=all&limit=20; Tasks group is last; stale rows can't be committed", async () => {
  search = () => json({ tasks: [task("T-7", "Deploy the docs")], nextCursor: null });
  const { dialog, input, router } = await openFromInput();
  await userEvent.type(input, "depl");
  expect(searchCalls()).toEqual([]);
  await within(dialog).findByText("Deploy the docs");
  await new Promise((r) => setTimeout(r, 300));
  expect(searchCalls()).toHaveLength(1);
  const params = new URL(searchCalls()[0] as string, "http://x").searchParams;
  expect(params.get("q")).toBe("depl");
  expect(params.get("status")).toBe("all");
  expect(params.get("limit")).toBe("20");
  const groups = dialog.querySelectorAll("[cmdk-group-heading]");
  expect(groups[groups.length - 1]).toHaveTextContent("Tasks");

  // The next query never answers: its rows are the old ones, muted and not committable.
  search = () => new Promise<Response>(() => {});
  await userEvent.type(input, "zz");
  await waitFor(() => expect(searchCalls()).toHaveLength(2));
  const stale = within(dialog).getByRole("option", { name: /Deploy the docs/ });
  expect(stale).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(stale);
  await userEvent.keyboard("{Enter}");
  expect(router.state.location.pathname).toBe("/inbox");
});

test("agents: live first, ended after with 'Ended'; Enter opens the chat; ⇧Enter focuses the composer", async () => {
  const { dialog, input, router } = await openFromInput();
  await userEvent.type(input, "dev");
  await waitFor(() =>
    expect(options(dialog).slice(0, 3)).toEqual([
      expect.stringContaining("@dev"),
      expect.stringContaining("@devops"),
      expect.stringMatching(/@dev-old.*Ended/),
    ]),
  );
  expect(options(dialog)[0]).not.toContain("Ended");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/chat"));

  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const again = await screen.findByRole("dialog", { name: "Search" });
  await userEvent.type(within(again).getByRole("combobox"), "dev");
  await waitFor(() => expect(highlighted(again)).toHaveTextContent("@dev"));
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message to Dev agent" })).toHaveFocus(),
  );
  // The palette remembers the opened agent as recent: an empty query lists it.
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const third = await screen.findByRole("dialog", { name: "Search" });
  expect(options(third)[0]).toContain("@dev");
});

test("the recent agents are read once per opening, not on each keystroke", async () => {
  localStorage.setItem("of-recent-agents", JSON.stringify(["devops"]));
  const getItem = vi.spyOn(Storage.prototype, "getItem");
  const recentReads = () => getItem.mock.calls.filter(([k]) => k === "of-recent-agents").length;
  try {
    const { dialog, input } = await openFromInput();
    // The empty query lists them.
    await waitFor(() => expect(options(dialog)[0]).toContain("@devops"));
    const atOpen = recentReads();
    expect(atOpen).toBeGreaterThan(0);
    await userEvent.type(input, "dev");
    await waitFor(() => expect(options(dialog)[0]).toContain("@dev"));
    expect(recentReads()).toBe(atOpen);
  } finally {
    getItem.mockRestore();
  }
});

test("Actions: no 'Mark all read'; 'Agent details' and the view actions only on agent pages", async () => {
  const { dialog } = await openFromInput();
  const actions = within(dialog).getByRole("group", { name: "Actions" });
  const names = within(actions)
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(names).toEqual(expect.arrayContaining(["New agent", "New task", "New schedule"]));
  expect(names).not.toContain("Mark all read");
  expect(names).not.toContain("Agent details");
  // Off an agent page neither view action is offered.
  expect(names).not.toContain("Open session");
  expect(names).not.toContain("Open chat");
});

test("'Agent details' is offered on a session page", async () => {
  renderApp("/agents/dev/session", alice);
  await screen.findByRole("combobox", { name: "Message to Dev agent" });
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  const actions = within(dialog).getByRole("group", { name: "Actions" });
  expect(within(actions).getByRole("option", { name: "Agent details" })).toBeInTheDocument();
});

async function openOn(path: string, composer: string) {
  const app = renderApp(path, alice);
  await screen.findByRole("combobox", { name: composer });
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  return {
    dialog,
    router: app.router,
    actions: within(dialog).getByRole("group", { name: "Actions" }),
  };
}

test("in the Chat the palette offers 'Open session' and not 'Open chat'; it goes to the session", async () => {
  const { actions, router } = await openOn("/agents/dev/chat", "Message to Dev agent");
  expect(within(actions).queryByRole("option", { name: "Open chat" })).toBeNull();
  expect(within(actions).getByRole("option", { name: "Agent details" })).toBeInTheDocument();
  await userEvent.click(within(actions).getByRole("option", { name: "Open session" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/session"));
});

test("in the Session the palette offers 'Open chat' and not 'Open session'; it goes to the chat", async () => {
  const { actions, router } = await openOn("/agents/dev/session", "Message to Dev agent");
  expect(within(actions).queryByRole("option", { name: "Open session" })).toBeNull();
  await userEvent.click(within(actions).getByRole("option", { name: "Open chat" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/chat"));
});

test("Go to includes Skills, Usage and each Settings page", async () => {
  const { dialog, router } = await openFromInput();
  const goTo = within(dialog).getByRole("group", { name: "Go to" });
  const names = within(goTo)
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(names).toEqual(
    expect.arrayContaining([
      "Inbox",
      "Agents",
      "Tasks",
      "Templates",
      "Skills",
      "Schedules",
      "Usage",
      "Settings: Credentials",
      "Settings: Secrets",
      "Settings: Projects",
      "Settings: Users",
      "Settings: Factory",
    ]),
  );
  expect(new Set(names).size).toBe(names.length);
});

test("the Search row opens it and shows the platform key hint", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  renderApp("/inbox", alice);
  const row = await screen.findByRole("button", { name: /Search/ });
  expect(row).toHaveTextContent("Ctrl");
  expect(row).toHaveTextContent("K");
  expect(row).not.toHaveAttribute("aria-current");
  // Hovering it warms the ended list.
  fireEvent.pointerEnter(row);
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/agents?ended=only")).toBe(true));
  await userEvent.click(row);
  expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
});

test("rows are a snapshot of the query: a list change while it's open moves nothing until the next keystroke", async () => {
  const { dialog, input, queryClient } = await openFromInput();
  await userEvent.type(input, "dev");
  await waitFor(() => expect(options(dialog)[0]).toContain("@dev"));
  const before = options(dialog);
  act(() =>
    queryClient.setQueryData(
      ["agents", "exclude"],
      [agentSummary({ slug: "devbox", displayName: "Devbox" }), ...live],
    ),
  );
  expect(options(dialog)).toEqual(before);
  await userEvent.type(input, "b");
  await waitFor(() => expect(options(dialog)[0]).toContain("@devbox"));
});

// The whole peek range, edges included (768–1023px).
test.each([768, 900, 1023])(
  "Agent details from the palette at %ipx leaves focus inside the sheet",
  async (width) => {
    const original = window.matchMedia;
    fakeMatchMedia.installWidth(width);
    try {
      renderApp("/agents/dev/session", alice);
      // Opened from the composer: the dialog's focus return would send focus back there.
      const box = await screen.findByRole("combobox", { name: "Message to Dev agent" });
      box.focus();
      fireEvent.keyDown(box, { key: "k", ctrlKey: true });
      const dialog = await screen.findByRole("dialog", { name: "Search" });
      await userEvent.type(within(dialog).getByRole("combobox"), "details");
      await waitFor(() => expect(highlighted(dialog)).toHaveTextContent("Agent details"));
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(document.getElementById("agent-details")).not.toBeNull());
      // Past the closing dialog's own focus return (a timer).
      await new Promise((r) => setTimeout(r, 50));
      expect(document.getElementById("agent-details")).toContainElement(
        document.activeElement as HTMLElement,
      );
    } finally {
      window.matchMedia = original;
    }
  },
);

test("a short query renders a capped agent list, keeping every strong match", async () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    agentSummary({ slug: `agent-${i}`, displayName: `Agent ${i}` }),
  );
  api.on("GET /api/agents?ended=exclude", () => json({ agents: many, running: { count: 0 } }));
  api.on("GET /api/agents?ended=only", () =>
    json({
      agents: [
        agentSummary({ slug: "g", displayName: "Gee", terminatedAt: "2026-11-01T00:00:00.000Z" }),
      ],
      more: false,
      running: { count: 0 },
    }),
  );
  const { dialog, input } = await openFromInput();
  await userEvent.type(input, "g");
  await waitFor(() => expect(options(dialog).some((o) => o?.includes("@g"))).toBe(true));
  const agentRows = within(within(dialog).getByRole("group", { name: "Agents" })).getAllByRole(
    "option",
  );
  expect(agentRows.length).toBeLessThanOrEqual(51);
  expect(within(dialog).getByText("Keep typing to narrow the agents.")).toBeInTheDocument();
});

test("the ended-more note is shown outside the list box", async () => {
  api.on("GET /api/agents?ended=only", () =>
    json({ agents: ended, more: true, running: { count: 0 } }),
  );
  const { dialog, input } = await openFromInput();
  await userEvent.type(input, "dev");
  const note = await within(dialog).findByText("Showing the 200 most recently ended");
  expect(note.closest("[role=listbox]")).toBeNull();
});

test("⇧Enter to an agent whose session isn't open yet focuses its composer once it mounts", async () => {
  const { dialog, input, router } = await openFromInput();
  await userEvent.type(input, "dev");
  await waitFor(() => expect(highlighted(dialog)).toHaveTextContent("@dev"));
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev/session"));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message to Dev agent" })).toHaveFocus(),
  );
});

test("Esc returns focus to the field it was opened from", async () => {
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  const field = document.createElement("input");
  document.body.append(field);
  try {
    field.focus();
    fireEvent.keyDown(field, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Search" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    await waitFor(() => expect(field).toHaveFocus());
  } finally {
    field.remove();
  }
});

test("ties keep the sidebar tree's order, not the server's", async () => {
  api.on("GET /api/agents?ended=exclude", () =>
    json({
      agents: [
        agentSummary({ slug: "zed-x", displayName: "Zed" }),
        agentSummary({ slug: "amy-x", displayName: "Amy" }),
        agentSummary({
          slug: "kid-x",
          displayName: "Kid",
          reportsTo: { kind: "agent", ref: "aaaaaaaa", handle: "zed-x" },
        }),
      ],
      running: { count: 0 },
    }),
  );
  const { dialog, input } = await openFromInput();
  await userEvent.type(input, "x");
  await waitFor(() =>
    expect(options(dialog).slice(0, 3)).toEqual([
      expect.stringContaining("@amy-x"),
      expect.stringContaining("@zed-x"),
      expect.stringContaining("@kid-x"),
    ]),
  );
});

test("on a phone, closing the palette opened from the nav drawer's Search row returns focus to the menu button", async () => {
  const original = window.matchMedia;
  fakeMatchMedia.installWidth(390);
  try {
    renderApp("/inbox", alice);
    const menu = await screen.findByRole("button", { name: "Toggle Sidebar" });
    await userEvent.click(menu);
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: /Search/ }));
    await screen.findByRole("dialog", { name: "Search" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    await waitFor(() => expect(menu).toHaveFocus());
  } finally {
    window.matchMedia = original;
    document.body.style.pointerEvents = "";
  }
});
