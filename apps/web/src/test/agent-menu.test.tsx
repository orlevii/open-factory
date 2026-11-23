import type { AgentSummary } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AgentMenu } from "@/features/agents/agent-menu";
import { restoreAgent } from "@/features/agents/lifecycle";
import { OutputDialogHost } from "@/features/agents/show-output";
import { CronsStopLayer, useStopCrons } from "@/features/session/stop-crons";
import { getSheetState, resetSheets } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toaster", () => ({ notify }));

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  notify.mockReset();
  resetSheets();
  // Radix can leave its modal marks on <body> when a test ends with a dialog closing.
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  vi.unstubAllGlobals();
});

const cron = {
  cronId: "c1",
  humanSchedule: "every 5 minutes",
  recurring: true,
  durable: false,
  expiresAt: "2026-11-27T10:00:00.000Z",
};

function Harness({
  agent,
  context,
  onOpenDetails,
  onTerminateStart = () => {},
  onTerminated = () => {},
}: {
  agent: AgentSummary;
  context: "session" | "sidebar" | "list";
  onOpenDetails?: () => void;
  onTerminateStart?: () => void;
  onTerminated?: (a: AgentSummary, ok: boolean) => void;
}) {
  const stop = useStopCrons(agent);
  return (
    <>
      <AgentMenu
        agent={agent}
        context={context}
        stop={stop}
        onOpenDetails={onOpenDetails}
        onTerminateStart={onTerminateStart}
        onTerminated={onTerminated}
      />
      <CronsStopLayer agent={agent} stop={stop} />
    </>
  );
}

function setup(props: Parameters<typeof Harness>[0]) {
  const root = createRootRoute({ component: () => <Harness {...props} /> });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      stub("/tasks"),
      stub("/agents/$slug"),
      stub("/agents/$slug/usage"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const openMenu = async (u: ReturnType<typeof userEvent.setup>, name = "Dev agent") => {
  await u.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  return screen.findByRole("menu");
};
const itemNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent?.replace(/\]$/, "").trim());

/** The menu's items and separators in order ("—" for a separator). */
const layout = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
    el.getAttribute("role") === "separator" ? "—" : el.textContent?.replace(/\]$/, "").trim(),
  );

test.each([
  [
    "session",
    [
      "New task",
      "New schedule",
      "—",
      "Edit",
      "Usage",
      "Open tasks",
      "Agent details",
      "Compact…",
      "—",
      "Reset persona…",
      "Archive…",
    ],
  ],
  [
    "sidebar",
    [
      "New task",
      "New schedule",
      "—",
      "Open session",
      "Edit",
      "Usage",
      "Open tasks",
      "—",
      "Reset persona…",
      "Archive…",
    ],
  ],
  [
    "list",
    [
      "New task",
      "New schedule",
      "—",
      "Edit",
      "Usage",
      "Open tasks",
      "—",
      "Reset persona…",
      "Archive…",
    ],
  ],
] as const)("%s: groups and separators for a live persistent agent", async (context, items) => {
  setup({ agent: agentSummary(), context });
  const menu = await openMenu(userEvent.setup());
  expect(layout(menu)).toEqual(items);
  expect(within(menu).getByRole("menuitem", { name: "Archive…" })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
});

test("Edit and Compact are left out for a spawned agent; Stop crons… only with live crons", async () => {
  setup({
    agent: agentSummary({ kind: "ephemeral", crons: [cron] }),
    context: "session",
  });
  const menu = await openMenu(userEvent.setup());
  const names = itemNames(menu);
  expect(names).not.toContain("Edit");
  expect(names).toContain("Stop crons…");
});

test("a terminated agent offers no Compact or Terminate", async () => {
  setup({
    agent: agentSummary({ kind: "ephemeral", status: "terminated" }),
    context: "session",
  });
  const menu = await openMenu(userEvent.setup());
  const names = itemNames(menu);
  expect(names).not.toContain("Compact…");
  expect(names).not.toContain("Terminate…");
});

test("Agent details calls back", async () => {
  const onOpenDetails = vi.fn();
  setup({ agent: agentSummary(), context: "session", onOpenDetails });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: /Agent details/ }));
  expect(onOpenDetails).toHaveBeenCalledOnce();
});

test("Terminate… only for a live spawned agent in the session, crimson with a separator, confirms", async () => {
  const api = mockApi({
    "POST /api/agents/dev/terminate": () =>
      json({ agent: agentSummary({ kind: "ephemeral", status: "terminated" }) }),
  });
  const onTerminateStart = vi.fn();
  const onTerminated = vi.fn();
  const spawned = agentSummary({ kind: "ephemeral" });
  const view = setup({ agent: spawned, context: "session", onTerminateStart, onTerminated });
  const u = userEvent.setup();
  const menu = await openMenu(u);
  const item = within(menu).getByRole("menuitem", { name: "Terminate…" });
  expect(item).toHaveAttribute("data-variant", "destructive");
  expect(item.previousElementSibling).toHaveAttribute("role", "separator");
  await u.click(item);
  const dlg = await screen.findByRole("alertdialog", { name: "Terminate @dev?" });
  await u.click(within(dlg).getByRole("button", { name: "Terminate @dev" }));
  await vi.waitFor(() => expect(onTerminated).toHaveBeenCalledOnce());
  expect(onTerminateStart).toHaveBeenCalledOnce();
  expect(api.calls.some((c) => c.url === "/api/agents/dev/terminate")).toBe(true);
  view.unmount();
});

test("no Terminate… for a persistent agent or from the sidebar", async () => {
  const first = setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  expect(itemNames(await openMenu(u))).not.toContain("Terminate…");
  first.unmount();
  setup({ agent: agentSummary({ kind: "ephemeral" }), context: "sidebar" });
  expect(itemNames(await openMenu(u))).not.toContain("Terminate…");
});

test("Stop crons… opens the confirmation with the panel closed", async () => {
  setup({ agent: agentSummary({ crons: [cron] }), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Stop crons…" }));
  expect(await screen.findByRole("alertdialog", { name: "Stop @dev's crons?" })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Crons in this session" })).toBeNull();
});

test("Compact… moves focus into the compact popover", async () => {
  setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Compact…" }));
  const input = await screen.findByRole("textbox", { name: "Focus (optional)" });
  await vi.waitFor(() => expect(input).toHaveFocus());
});

test("Escape from the compact popover returns focus to the ⋯ button", async () => {
  setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Compact…" }));
  const input = await screen.findByRole("textbox", { name: "Focus (optional)" });
  await vi.waitFor(() => expect(input).toHaveFocus());
  await u.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Actions for Dev agent" })).toHaveFocus(),
  );
});

test("a successful Compact returns focus to the ⋯ button", async () => {
  mockApi({
    "POST /api/agents/dev/compact": () =>
      json(
        { item: { id: "q", kind: "compact", from: "@alice", fromKind: "human", createdAt: "x" } },
        202,
      ),
  });
  setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Compact…" }));
  await u.click(await screen.findByRole("button", { name: "Compact" }));
  await vi.waitFor(() => expect(screen.queryByRole("textbox"), "popover still open").toBeNull());
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Actions for Dev agent" })).toHaveFocus(),
  );
});

test("cancelling Terminate… returns focus to the ⋯ button", async () => {
  setup({ agent: agentSummary({ kind: "ephemeral" }), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Terminate…" }));
  const dlg = await screen.findByRole("alertdialog", { name: "Terminate @dev?" });
  await u.click(within(dlg).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Actions for Dev agent" })).toHaveFocus(),
  );
});

test("cancelling Stop crons… opened from the menu returns focus to the ⋯ button", async () => {
  setup({ agent: agentSummary({ crons: [cron] }), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Stop crons…" }));
  const dlg = await screen.findByRole("alertdialog", { name: "Stop @dev's crons?" });
  await u.click(within(dlg).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Actions for Dev agent" })).toHaveFocus(),
  );
});

const archived = (over: Partial<AgentSummary> = {}) =>
  agentSummary({ archivedAt: "2026-11-19T10:00:00.000Z", status: "hibernated", ...over });

test.each([
  [
    "an archived persistent agent",
    archived(),
    ["Usage", "Open tasks", "—", "Reset persona…", "Restore"],
  ],
  [
    "a terminated persistent agent",
    agentSummary({ status: "terminated", terminatedAt: "2026-11-19T10:00:00.000Z" }),
    ["Usage", "Open tasks"],
  ],
  [
    "an ended spawned agent",
    agentSummary({ kind: "ephemeral", status: "terminated" }),
    ["Usage", "Open tasks"],
  ],
] as const)("list: %s", async (_n, agent, items) => {
  setup({ agent, context: "list" });
  expect(layout(await openMenu(userEvent.setup()))).toEqual(items);
});

test("session: an archived agent's menu offers Restore", async () => {
  setup({ agent: archived(), context: "session" });
  const names = itemNames(await openMenu(userEvent.setup()));
  expect(names).toContain("Restore");
  expect(names).not.toContain("Archive…");
  expect(names).not.toContain("New task");
});

test("New task and New schedule open their sheets prefilled with the agent", async () => {
  setup({ agent: agentSummary(), context: "list" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "New task" }));
  await vi.waitFor(() =>
    expect(getSheetState().parent).toMatchObject({ kind: "new-task", assignee: "dev" }),
  );
  resetSheets();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "New schedule" }));
  await vi.waitFor(() =>
    expect(getSheetState().parent).toMatchObject({ kind: "new-schedule", target: "dev" }),
  );
});

test.each(["session", "sidebar", "list"] as const)(
  "Edit (%s) is a plain item that opens Edit agent",
  async (context) => {
    setup({ agent: agentSummary(), context });
    const u = userEvent.setup();
    const menu = await openMenu(u);
    const edit = within(menu).getByRole("menuitem", { name: "Edit" });
    expect(edit.tagName).not.toBe("A");
    expect(edit).not.toHaveAttribute("href");
    await u.click(edit);
    await vi.waitFor(() =>
      expect(getSheetState().parent).toMatchObject({ kind: "edit-agent", slug: "dev" }),
    );
  },
);

test("Archive… archives at once (no confirmation, as before) and toasts with an Undo that restores", async () => {
  const api = mockApi({
    "POST /api/agents/dev/archive": () => json({ agent: archived() }),
    "POST /api/agents/dev/unarchive": () => json({ agent: agentSummary() }),
  });
  setup({ agent: agentSummary(), context: "sidebar" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Archive…" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
  const n = notify.mock.calls[0]?.[0];
  expect(n.text).toBe("Archived @dev.");
  expect(api.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
    "/api/agents/dev/archive",
  ]);
  await n.undo();
  expect(api.calls.some((c) => c.url === "/api/agents/dev/unarchive")).toBe(true);
});

test("a failed archive toasts the server's message, naming the agent", async () => {
  mockApi({
    "POST /api/agents/dev/archive": () =>
      json(
        {
          error: {
            code: "has_reports",
            message: "@a and @b report to this agent. Change their manager first.",
            reports: ["a", "b"],
          },
        },
        409,
      ),
  });
  setup({ agent: agentSummary(), context: "list" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Archive…" }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Couldn't archive @dev: @a and @b report to this agent. Change their manager first.",
    }),
  );
});

test("a network failure on archive says the server can't be reached", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  setup({ agent: agentSummary(), context: "list" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Archive…" }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({ text: "Couldn't archive @dev: can't reach the server." }),
  );
});

test("Restore in an archived agent's menu toasts Restored @slug.", async () => {
  const api = mockApi({
    "POST /api/agents/dev/unarchive": () => json({ agent: agentSummary() }),
    "GET /api/agents/dev": () => json({ agent: agentSummary(), queue: [], lastSeq: 0 }),
  });
  setup({ agent: archived(), context: "list" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Restore" }));
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Restored @dev." }));
  expect(api.calls.some((c) => c.url === "/api/agents/dev/unarchive")).toBe(true);
});

test("Reset persona… is offered for live and archived agents, never for a spawned or terminated one", async () => {
  setup({ agent: archived(), context: "list" });
  expect(itemNames(await openMenu(userEvent.setup()))).toContain("Reset persona…");
  cleanup();
  setup({ agent: agentSummary({ kind: "ephemeral" }), context: "session" });
  expect(itemNames(await openMenu(userEvent.setup()))).not.toContain("Reset persona…");
  cleanup();
  setup({ agent: agentSummary({ status: "terminated" }), context: "session" });
  expect(itemNames(await openMenu(userEvent.setup()))).not.toContain("Reset persona…");
});

test("Reset persona… confirms with the spec copy, cancel sends nothing", async () => {
  const api = mockApi({});
  setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Reset persona…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Reset persona?" });
  expect(dialog).toHaveTextContent(
    "Replace @dev's AGENTS.md with the template's. The current file is saved in state/agents/dev/persona/.",
  );
  expect(within(dialog).getByRole("button", { name: "Reset persona" })).toBeInTheDocument();
  await u.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.calls).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});

test.each([
  [
    { applied: "now", backupDir: "state/agents/dev/persona/x" },
    "Persona reset. Previous file saved.",
  ],
  [{ applied: "now" }, "Persona reset."],
  [{ applied: "on_restart" }, "Persona resets when @dev restarts."],
])("confirming Reset persona posts once and toasts %o", async (r, text) => {
  const api = mockApi({ "POST /api/agents/dev/reset-persona": () => json(r) });
  setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Reset persona…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Reset persona?" });
  await u.click(within(dialog).getByRole("button", { name: "Reset persona" }));
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ text }));
  expect(api.calls.filter((c) => c.url === "/api/agents/dev/reset-persona")).toHaveLength(1);
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test.each([
  ["template_invalid", "Template developer has errors."],
  ["template_missing", "Template developer no longer exists."],
  ["agent_not_found", "No agent named dev"],
])("a reset refused with %s toasts the server's own reason", async (code, message) => {
  mockApi({
    "POST /api/agents/dev/reset-persona": () => json({ error: { code, message } }, 409),
  });
  setup({ agent: agentSummary({ template: "developer" }), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Reset persona…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Reset persona?" });
  await u.click(within(dialog).getByRole("button", { name: "Reset persona" }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: `Couldn't reset the persona of @dev: ${message}`,
    }),
  );
});

test("archive blocked by live spawned agents toasts the server's advice to terminate them", async () => {
  mockApi({
    "POST /api/agents/dev/archive": () =>
      json(
        {
          error: {
            code: "has_reports",
            message: "@dev has live spawned agents: @dev-ab12. Terminate them first.",
            reports: ["dev-ab12"],
          },
        },
        409,
      ),
  });
  setup({ agent: agentSummary(), context: "list" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Archive…" }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Couldn't archive @dev: @dev has live spawned agents: @dev-ab12. Terminate them first.",
    }),
  );
});

test("a restore made while another is in flight reports that restore's outcome, not a success", async () => {
  let release: () => void = () => {};
  const api = mockApi({
    "POST /api/agents/dev/unarchive": () =>
      new Promise<Response>((r) => {
        release = () =>
          r(
            json({ error: { code: "manager_archived", message: "Its manager is archived." } }, 409),
          );
      }),
  });
  const qc = new QueryClient();
  const fromMenu = restoreAgent("dev", qc);
  const inline = restoreAgent("dev", qc, { inline: true });
  await vi.waitFor(() => expect(api.calls).toHaveLength(1));
  release();
  expect(await inline).toBe("Couldn't restore @dev: Its manager is archived.");
  expect(await fromMenu).toBe("Couldn't restore @dev: Its manager is archived.");
  expect(api.calls.filter((c) => c.url === "/api/agents/dev/unarchive")).toHaveLength(1);
});

test("a second Archive while the first is in flight sends one request", async () => {
  let release: () => void = () => {};
  const api = mockApi({
    "POST /api/agents/dev/archive": () =>
      new Promise<Response>((r) => {
        release = () => r(json({ agent: archived() }));
      }),
  });
  setup({ agent: agentSummary(), context: "list" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Archive…" }));
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Archive…" }));
  release();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(api.calls.filter((c) => c.url === "/api/agents/dev/archive")).toHaveLength(1);
});

test("Restore mentions pending messages when the agent has some", async () => {
  mockApi({
    "POST /api/agents/dev/unarchive": () => json({ agent: agentSummary() }),
    "GET /api/agents/dev": () =>
      json({
        agent: agentSummary(),
        queue: [
          {
            id: "q1",
            kind: "message",
            body: "hi",
            from: "@alice",
            fromKind: "human",
            createdAt: "x",
          },
        ],
        lastSeq: 0,
      }),
  });
  setup({ agent: archived(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Restore" }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Restored @dev. Pending messages are sent with the next message.",
    }),
  );
});

// Phones (below 48rem): the same menu as a bottom drawer titled with the agent's name (U4 §11.1).
const tap = (el: Element) => {
  fireEvent.pointerDown(el, { button: 0, pointerType: "touch" });
  fireEvent.click(el);
};
/** Vaul animates the drawer out with a keyframe jsdom never runs: end it, so the content unmounts. */
const endExit = (content: Element) => {
  const end = new Event("animationend", { bubbles: true });
  Object.defineProperty(end, "animationName", { value: getComputedStyle(content).animationName });
  act(() => {
    content.dispatchEvent(end);
  });
};
const openDrawer = async (name = "Dev agent") => {
  tap(await screen.findByRole("button", { name: `Actions for ${name}` }));
  return screen.findByRole("dialog", { name });
};

test("phone: the menu is a drawer titled with the agent's name, its groups split by rules", async () => {
  fakeMatchMedia.install(true, { coarse: true });
  setup({ agent: agentSummary(), context: "session" });
  const drawer = await openDrawer();
  expect(screen.queryByRole("menu")).toBeNull();
  for (const name of ["New task", "Edit", "Compact…", "Archive…"])
    expect(within(drawer).getByRole("button", { name })).toBeInTheDocument();
  expect(within(drawer).getByRole("link", { name: "Usage" })).toBeInTheDocument();
  expect(within(drawer).getAllByRole("separator").length).toBeGreaterThanOrEqual(2);
  // The ] shortcut means nothing on a phone.
  expect(within(drawer).getByRole("button", { name: "Agent details" })).toHaveTextContent(
    /^Agent details$/,
  );
});

test("phone: New task closes the drawer instantly, then opens its sheet prefilled", async () => {
  fakeMatchMedia.install(true, { coarse: true });
  setup({ agent: agentSummary(), context: "list" });
  const drawer = await openDrawer();
  const content = drawer.closest("[data-slot=drawer-content]") ?? drawer;
  fireEvent.click(within(drawer).getByRole("button", { name: "New task" }));
  expect(content).toHaveAttribute("data-instant");
  endExit(content);
  await vi.waitFor(() =>
    expect(getSheetState().parent).toMatchObject({ kind: "new-task", assignee: "dev" }),
  );
});

test("phone: Restore opens no overlay, so the drawer closes normally", async () => {
  mockApi({ "POST /api/agents/dev/unarchive": () => json({ agent: agentSummary() }) });
  fakeMatchMedia.install(true, { coarse: true });
  setup({ agent: archived(), context: "session" });
  const drawer = await openDrawer();
  const content = drawer.closest("[data-slot=drawer-content]") ?? drawer;
  fireEvent.click(within(drawer).getByRole("button", { name: "Restore" }));
  expect(content).not.toHaveAttribute("data-instant");
});

test("phone: Compact… hands focus to the compact popover once the drawer has gone", async () => {
  fakeMatchMedia.install(true, { coarse: true });
  setup({ agent: agentSummary(), context: "session" });
  const drawer = await openDrawer();
  const content = drawer.closest("[data-slot=drawer-content]") ?? drawer;
  fireEvent.click(within(drawer).getByRole("button", { name: "Compact…" }));
  expect(content).toHaveAttribute("data-instant");
  endExit(content);
  const input = await screen.findByRole("textbox", { name: "Focus (optional)" });
  await vi.waitFor(() => expect(input).toHaveFocus());
});

test("phone: closing the drawer with Cancel returns focus to the ⋯", async () => {
  fakeMatchMedia.install(true, { coarse: true });
  setup({ agent: agentSummary(), context: "session" });
  const trigger = await screen.findByRole("button", { name: "Actions for Dev agent" });
  trigger.focus();
  const drawer = await openDrawer();
  const content = drawer.closest("[data-slot=drawer-content]") ?? drawer;
  fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
  endExit(content);
  await vi.waitFor(() => expect(document.querySelector("[data-slot=drawer-content]")).toBeNull());
  await vi.waitFor(() => expect(trigger).toHaveFocus());
});

test("desktop: an item that opens an overlay closes the dropdown instantly; a link doesn't", async () => {
  setup({ agent: agentSummary(), context: "list" });
  const u = userEvent.setup();
  let menu = await openMenu(u);
  await u.click(within(menu).getByRole("menuitem", { name: "Edit" }));
  expect(menu).toHaveAttribute("data-instant");
  resetSheets();
  await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  menu = await openMenu(u);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open tasks" }));
  expect(menu).not.toHaveAttribute("data-instant");
});

test.each([
  ["Terminate…", agentSummary({ kind: "ephemeral" }), "Terminate @dev?"],
  ["Stop crons…", agentSummary({ crons: [cron] }), "Stop @dev's crons?"],
] as const)(
  "phone: %s leaves focus in its confirmation once the drawer has gone",
  async (item, agent, name) => {
    fakeMatchMedia.install(true, { coarse: true });
    setup({ agent, context: "session" });
    const trigger = await screen.findByRole("button", { name: "Actions for Dev agent" });
    trigger.focus();
    const drawer = await openDrawer();
    const content = drawer.closest("[data-slot=drawer-content]") ?? drawer;
    fireEvent.click(within(drawer).getByRole("button", { name: item }));
    const dlg = await screen.findByRole("alertdialog", { name });
    // The drawer's close must not pull focus back to ⋯ under the confirmation (it would flicker on a
    // device; jsdom's focus trap hides it, so watch the call).
    const refocus = vi.spyOn(trigger, "focus");
    await vi.waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    endExit(content);
    await vi.waitFor(() => expect(content.isConnected).toBe(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect(refocus).not.toHaveBeenCalled();
  },
);
