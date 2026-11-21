import type { AgentSummary } from "@open-factory/shared";
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
import { json, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";

afterEach(() => {
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
  context: "session" | "sidebar";
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
  return render(<RouterProvider router={router} />);
}

const openMenu = async (u: ReturnType<typeof userEvent.setup>, name = "Dev agent") => {
  await u.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  return screen.findByRole("menu");
};
const itemNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent?.replace(/\]$/, "").trim());

test.each([
  ["session", ["Agent details", "Compact…", "Edit", "Usage", "Open tasks"]],
  ["sidebar", ["Open session", "Edit", "Usage", "Open tasks"]],
] as const)("%s items for a live persistent agent", async (context, items) => {
  setup({ agent: agentSummary(), context });
  const menu = await openMenu(userEvent.setup());
  expect(itemNames(menu)).toEqual(items);
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
