import type { AgentSummary } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AgentMenu } from "@/features/agents/agent-menu";
import { CronsStopLayer, useStopCrons } from "@/features/session/stop-crons";
import { getSheetState, resetSheets } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toaster", () => ({ notify }));

afterEach(() => {
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
      stub("/agents/$slug/edit"),
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
      "Re-sync from template…",
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
      "Re-sync from template…",
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
      "Re-sync from template…",
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
      json({ item: { id: "q", kind: "compact", from: "@alice", createdAt: "x" } }, 202),
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
  ["an archived persistent agent", archived(), ["Usage", "Open tasks", "—", "Restore"]],
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
  expect(names).not.toContain("Re-sync from template…");
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

test.each([
  [{ applied: "now" }, "Re-synced. Nothing differed."],
  [
    { applied: "now", backupDir: "state/agents/dev/resync/x" },
    "Re-synced. Previous files saved in state/agents/dev/resync/x.",
  ],
  [{ applied: "on_restart" }, "Re-synced. The changes apply when @dev restarts (when idle)."],
])(
  "Re-sync from template… runs at once (no confirmation, as before) and toasts %o",
  async (r, text) => {
    mockApi({ "POST /api/agents/dev/resync": () => json({ agent: agentSummary(), ...r }) });
    setup({ agent: agentSummary(), context: "session" });
    const u = userEvent.setup();
    await openMenu(u);
    await u.click(screen.getByRole("menuitem", { name: "Re-sync from template…" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ text }));
  },
);

test.each([
  ["template_invalid", "Couldn't re-sync @dev: Template developer has errors."],
  ["template_missing", "Couldn't re-sync @dev: Template developer no longer exists."],
])("a re-sync refused with %s toasts the template problem", async (code, text) => {
  mockApi({
    "POST /api/agents/dev/resync": () => json({ error: { code, message: "x" } }, 409),
  });
  setup({ agent: agentSummary({ template: "developer" }), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Re-sync from template…" }));
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ text }));
});

test("a failed plugin install on re-sync names the backup folder", async () => {
  mockApi({
    "POST /api/agents/dev/resync": () =>
      json({ error: { code: "plugin_install_failed", message: "x", output: "boom" } }, 502),
  });
  setup({ agent: agentSummary(), context: "session" });
  const u = userEvent.setup();
  await openMenu(u);
  await u.click(screen.getByRole("menuitem", { name: "Re-sync from template…" }));
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Couldn't re-sync @dev: Plugin install failed. Some files were already copied (previous versions in state/agents/dev/resync/). Fix the template and re-sync again.",
    }),
  );
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
        queue: [{ id: "q1", kind: "message", body: "hi", from: "@alice", createdAt: "x" }],
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
