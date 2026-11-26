import type { AgentSummary, ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openSheet, resetSheets } from "@/features/sheets/sheet-store";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, resetSeq, se } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0)); // Thu 19 Nov, local time
  resetSeq();
  sessionStorage.clear();
});
afterEach(() => {
  resetSheets();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();
const SLUG = "tech-lead-ab12";
const REF = refFor(SLUG);
const BODY =
  "It stops now, ending any work in progress, and its session can't continue. Messages waiting for it are dropped. Its workspace is deleted 3 days later unless you pin it; worktrees it made in projects stay.";

const spawned = (over: Partial<AgentSummary> = {}): AgentSummary =>
  agentSummary({
    handle: SLUG,
    displayName: "Tech Lead · ab12",
    kind: "ephemeral",
    template: "tech-lead",
    reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
    depth: 1,
    ...over,
  });
/** Terminated today at 14:32 by @lead, in its 3-day grace. */
const terminated = (over: Partial<AgentSummary> = {}): AgentSummary =>
  spawned({
    status: "terminated",
    terminatedAt: local(19, 14, 32),
    terminatedBy: { ref: refFor("lead"), handle: "lead" },
    workspacePinned: false,
    workspaceGraceEndsAt: local(22, 14, 32),
    ...over,
  });

/** Opens the spawned agent's session; `current` is what GET /api/agents/tech-lead-ab12 returns. */
async function open(first: AgentSummary, extra: Record<string, Handler> = {}) {
  const state = { agent: first };
  const api = mockApi({
    [`GET /api/agents/${REF}`]: () =>
      json({
        agent: state.agent,
        queue: [],
        lastSeq: 1,
      }),
    [`GET /api/agents/${REF}/events?`]: () =>
      json({
        hasMore: { before: false, after: false },
        events: [se({ type: "assistant_text", text: "history" })],
      }),
    "GET /api/agents?ended=exclude": () =>
      json({
        agents: [agentSummary({ handle: "lead", displayName: "Lead" }), state.agent],
        running: { count: 1 },
      }),
    "GET /api/agents?ended=only": () => json({ agents: [], more: false, running: { count: 1 } }),
    "GET /api/principals": () =>
      json({
        principals: [
          {
            id: "p-lead",
            ref: refFor("lead"),
            kind: "agent",
            handle: "lead",
            name: "Lead",
            state: "live",
            avatar: null,
          },
          {
            id: "p-or",
            ref: "hhhhhhhh",
            kind: "human",
            handle: "or",
            name: "Or",
            state: "live",
            avatar: null,
          },
        ],
      }),
    ...extra,
  });
  const app = renderApp(`/agents/${REF}/session`, alice);
  await screen.findByText("history");
  return { api, state, app };
}
/** Agent details (closed by default at this test's width), opened from the header. */
async function details() {
  await userEvent.click(screen.getByRole("button", { name: "Agent details" }));
  await vi.waitFor(() => expect(document.getElementById("agent-details")).not.toBeNull());
  return document.getElementById("agent-details") as HTMLElement;
}
/** The header's ⋯ menu (the sidebar row has one too): Compact… and Terminate… live there (U2 §8.4). */
async function menuItem(name: string) {
  await userEvent.click(
    within(screen.getByRole("banner")).getByRole("button", {
      name: "Actions for Tech Lead · ab12",
    }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
const sentence = () =>
  (document.querySelector("[data-terminated-text]") as HTMLElement | null)?.textContent;
const terminatedFrame = () =>
  act(() =>
    ws.onMessage?.({
      type: "agent_status",
      agent: REF,
      status: "terminated",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    } as ServerMessage),
  );

test("a live spawned agent: Terminate… in the ⋯ menu, no Edit; 'Spawned by @lead' in Agent details", async () => {
  await open(spawned({ status: "working", turnOpen: true }));
  const header = screen.getByRole("banner");
  const buttons = within(header)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(buttons.slice(-2)).toEqual(["Agent details", "Actions for Tech Lead · ab12"]);
  expect(buttons).not.toContain("Stop");
  expect(within(header).queryByRole("link", { name: /Edit/ })).toBeNull();
  await userEvent.click(
    within(header).getByRole("button", { name: "Actions for Tech Lead · ab12" }),
  );
  const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
  expect(items).toContain("Terminate…");
  expect(items).not.toContain("Edit");
  await userEvent.keyboard("{Escape}");
  const panel = await details();
  expect(panel.textContent).toContain("Spawned by");
  expect(panel.textContent).not.toContain("Reports to");
});

test("the header keeps a spawned agent's ' · ab12' tail; the title says Terminated", async () => {
  await open(terminated());
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(within(h1).getByText("Tech Lead · ab12")).toBeInTheDocument();
  const tail = within(h1).getByText("· ab12");
  expect(tail).toHaveAttribute("aria-hidden", "true");
  expect(document.title).toBe("Terminated · Tech Lead · ab12 · Session · Open Factory");
});

test("the Terminate dialog: exact copy, Cancel focused; a failure stays open; success focuses Pin workspace", async () => {
  let fail = true;
  const { api, state } = await open(spawned(), {
    [`POST /api/agents/${REF}/terminate`]: () => {
      if (fail)
        return json({ error: { code: "internal", message: "The factory couldn't stop it." } }, 500);
      state.agent = terminated({ terminatedBy: { ref: "hhhhhhhh", handle: "alice" } });
      return json({ agent: state.agent });
    },
  });
  await menuItem("Terminate…");
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading", { name: `Terminate @${SLUG}?` })).toBeInTheDocument();
  expect(within(dialog).getByText(BODY)).toBeInTheDocument();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(dialog).getByRole("button", { name: `Terminate @${SLUG}` }));
  expect(await within(dialog).findByText("The factory couldn't stop it.")).toBeInTheDocument();
  expect(within(dialog).getByRole("alert")).toHaveTextContent("The factory couldn't stop it.");
  fail = false;
  await userEvent.click(within(dialog).getByRole("button", { name: `Terminate @${SLUG}` }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.calls.filter((c) => c.url === `/api/agents/${REF}/terminate`)).toHaveLength(2);
  const pin = await screen.findByRole("button", { name: "Pin workspace" });
  await vi.waitFor(() => expect(document.activeElement).toBe(pin));
  expect(
    screen.getByText("This agent was terminated. Its session is read-only."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /Message/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Terminate|Compact|Stop/ })).toBeNull();
});

test("terminated while viewing: popovers close, the read-only line takes focus, the draft can be copied", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { state } = await open(spawned());
  await userEvent.type(screen.getByRole("combobox", { name: /Message/ }), "half a thought");
  await menuItem("Compact…");
  expect(await screen.findByLabelText("Focus (optional)")).toBeInTheDocument();
  state.agent = terminated({ terminatedBy: { ref: "hhhhhhhh", handle: "or" } });
  terminatedFrame();
  const line = await screen.findByText("This agent was terminated. Its session is read-only.");
  expect(screen.queryByLabelText("Focus (optional)")).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(line));
  expect(line).toHaveAttribute("tabindex", "-1");
  const copy = screen.getByRole("button", { name: "Copy unsent message" });
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledWith("half a thought");
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Copy unsent message" })).toBeNull(),
  );
  expect(localStorage.getItem(`of-draft:v1:agent:${REF}`)).toBeNull();
  // The detail was refetched for the header's dates.
  expect(await screen.findByText(/Terminated by/)).toBeInTheDocument();
});

test("a send that races the termination says so", async () => {
  const { state } = await open(spawned(), {
    [`POST /api/agents/${REF}/input`]: () => {
      state.agent = terminated();
      return json(
        { error: { code: "agent_terminated", message: `@${SLUG} was terminated.` } },
        409,
      );
    },
  });
  await userEvent.type(screen.getByRole("combobox", { name: /Message/ }), "late");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  const alert = await screen.findByText(`@${SLUG} was terminated, so this wasn't sent.`);
  expect(alert.closest("[role=alert]")).not.toBeNull();
  // Once the detail catches up the composer is read-only, the line and the draft copy stay.
  expect(
    await screen.findByText("This agent was terminated. Its session is read-only."),
  ).toBeInTheDocument();
  expect(screen.getByText(`@${SLUG} was terminated, so this wasn't sent.`)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy unsent message" })).toBeInTheDocument();
});

test("Agent details: in the grace period, with Pin workspace; credential omitted when gone", async () => {
  await open(terminated({ credential: null }));
  const panel = await details();
  expect(sentence()).toBe(
    "Terminated by @lead, Lead today at 14:32. Workspace will be deleted on Sun at 14:32 unless you pin it.",
  );
  expect(within(panel).getByRole("button", { name: "Pin workspace" })).toBeInTheDocument();
  expect(panel.textContent).not.toContain("Credential");
  expect(panel.textContent).toContain("Spawned by");
});

test("Agent details: an agent that terminated it is a link to that agent's chat", async () => {
  await open(terminated());
  const panel = await details();
  const link = await within(panel).findByRole("link", { name: /@lead/ });
  expect(link).toHaveAttribute("href", expect.stringContaining(`/agents/${refFor("lead")}/chat`));
  expect(link.closest("[data-terminated-text]")).not.toBeNull();
});

test.each([
  [
    "due for deletion",
    {},
    "Terminated by @lead, Lead on 14 Nov at 14:32. Workspace due for deletion since 17 Nov at 14:32 unless you pin it.",
    "Pin workspace",
  ],
  [
    "pinned",
    { workspacePinned: true },
    "Terminated by @lead, Lead on 14 Nov at 14:32. Workspace pinned.",
    "Unpin workspace",
  ],
  [
    "deleted",
    { workspaceDeletedAt: local(17, 14, 40) },
    "Terminated by @lead, Lead on 14 Nov at 14:32. Workspace deleted on 17 Nov at 14:40.",
    undefined,
  ],
  [
    "TTL and stuck",
    { terminatedBy: null, workspacePinned: true, stuck: true as const },
    "Terminated on 14 Nov at 14:32 after 3 days without activity. Workspace pinned. Its container couldn't be removed; the factory keeps retrying.",
    "Unpin workspace",
  ],
  [
    "by a human",
    { terminatedBy: { ref: "hhhhhhhh", handle: "or" }, workspacePinned: true },
    "Terminated by O@or, Or on 14 Nov at 14:32. Workspace pinned.",
    "Unpin workspace",
  ],
] as const)("Agent details: %s", async (_, over, text, button) => {
  await open(
    terminated({
      terminatedAt: local(14, 14, 32),
      workspaceGraceEndsAt: local(17, 14, 32),
      ...over,
    }),
  );
  const panel = await details();
  expect(sentence()).toBe(text);
  const toggle = within(panel).queryByRole("button", { name: /^(Pin|Unpin) workspace$/ });
  expect(toggle?.textContent ?? undefined).toBe(button);
  // The header offers the same toggle, as its own button.
  const header = screen.getByRole("banner");
  expect(
    within(header).queryByRole("button", { name: /^(Pin|Unpin) workspace$/ })?.textContent ??
      undefined,
  ).toBe(button);
  // A person is a chip without a link; only an agent links to its chat.
  if (text.includes("Terminated by O@or"))
    expect(within(panel).queryByRole("link", { name: /@or/ })).toBeNull();
});

test("Agent details: What's kept? explains in a popover", async () => {
  await open(terminated());
  await details();
  await userEvent.click(screen.getByRole("button", { name: "What's kept?" }));
  expect(
    await screen.findByText(
      "The session history stays here for good. The workspace (its files and Claude config) is deleted 3 days after it was terminated, unless you pin it. Worktrees and branches it made in projects are never deleted.",
    ),
  ).toBeInTheDocument();
});

test("Pin / Unpin is one toggle that keeps focus and announces; within the grace Unpin acts at once", async () => {
  const { api, state } = await open(terminated(), {
    [`PUT /api/agents/${REF}/workspace-pin`]: () => {
      state.agent = terminated({ workspacePinned: true });
      return json({ agent: state.agent });
    },
    [`DELETE /api/agents/${REF}/workspace-pin`]: () => {
      state.agent = terminated({ workspacePinned: false });
      return json({ agent: state.agent });
    },
  });
  const toggle = screen.getByRole("button", { name: "Pin workspace" });
  await userEvent.click(toggle);
  await vi.waitFor(() => expect(toggle).toHaveAccessibleName("Unpin workspace"));
  expect(document.activeElement).toBe(toggle);
  expect(await screen.findByText("Workspace pinned.")).toBeInTheDocument();
  expect(screen.getByText("Workspace pinned.").closest("[role=status]")).not.toBeNull();
  await userEvent.click(toggle);
  await vi.waitFor(() => expect(toggle).toHaveAccessibleName("Pin workspace"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(toggle);
  expect(await screen.findByText("Workspace unpinned.")).toBeInTheDocument();
  expect(api.calls.map((c) => `${c.method} ${c.url}`)).toContain(
    `DELETE /api/agents/${REF}/workspace-pin`,
  );
});

test("Unpin after the grace confirms: the workspace is deleted", async () => {
  const old = { terminatedAt: local(14, 14, 32), workspaceGraceEndsAt: local(17, 14, 32) };
  const { api, state } = await open(terminated({ ...old, workspacePinned: true }), {
    [`DELETE /api/agents/${REF}/workspace-pin`]: () => {
      state.agent = terminated({ ...old, workspacePinned: false });
      return json({ agent: state.agent });
    },
  });
  await userEvent.click(screen.getByRole("button", { name: "Unpin workspace" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByRole("heading", { name: `Unpin and delete @${SLUG}'s workspace?` }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "Its files and Claude config are removed within 10 minutes; its session history stays.",
    ),
  ).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete workspace" }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
  expect(await screen.findByRole("button", { name: "Pin workspace" })).toBeInTheDocument();
  expect(await screen.findByText("Workspace unpinned.")).toBeInTheDocument();
});

const frameNow = () =>
  ws.onMessage?.({
    type: "agent_status",
    agent: REF,
    status: "terminated",
    turnOpen: false,
    restartPending: false,
    restartWaitingOn: 0,
  } as ServerMessage);

test("the terminated frame arriving before the response: the dialog stays open until it, then Pin takes focus", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let framed = false;
  const { state } = await open(spawned(), {
    [`POST /api/agents/${REF}/terminate`]: async () => {
      state.agent = terminated({ terminatedBy: { ref: "hhhhhhhh", handle: "alice" } });
      act(() => frameNow());
      framed = true;
      await held;
      return json({ agent: state.agent });
    },
  });
  await menuItem("Terminate…");
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: `Terminate @${SLUG}` }));
  await vi.waitFor(() => expect(framed).toBe(true));
  // The view has turned read-only behind it, but the request is still pending.
  expect(
    await screen.findByText("This agent was terminated. Its session is read-only."),
  ).toBeInTheDocument();
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  await act(async () => release());
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  const pin = await screen.findByRole("button", { name: "Pin workspace" });
  await vi.waitFor(() => expect(document.activeElement).toBe(pin));
});

test("a failed terminate request after the agent was terminated anyway closes the dialog", async () => {
  const { state } = await open(spawned(), {
    [`POST /api/agents/${REF}/terminate`]: async () => {
      state.agent = terminated({ terminatedBy: { ref: refFor("lead"), handle: "lead" } });
      act(() => frameNow());
      // The frame commits on the next animation frame; the failure comes back once it has rendered.
      await vi.waitFor(() =>
        expect(
          screen.getByText("This agent was terminated. Its session is read-only."),
        ).toBeInTheDocument(),
      );
      return json({ error: { code: "internal", message: "Something broke." } }, 500);
    },
  });
  await menuItem("Terminate…");
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: `Terminate @${SLUG}` }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByText("Something broke.")).toBeNull();
  const pin = await screen.findByRole("button", { name: "Pin workspace" });
  await vi.waitFor(() => expect(document.activeElement).toBe(pin));
});

test("an errored spawned agent: the recovery actions in the header, Terminate… in the menu", async () => {
  await open(spawned({ status: "errored", errorKind: "resume", lastError: "boom" }));
  const header = screen.getByRole("banner");
  const names = within(header)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(names.slice(-4)).toEqual([
    "Restart",
    "Start a new session",
    "Agent details",
    "Actions for Tech Lead · ab12",
  ]);
  expect(within(header).queryByRole("button", { name: /Compact|Stop/ })).toBeNull();
  await menuItem("Terminate…");
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
});

test("Edit agent on a spawned agent says it can't be edited", async () => {
  mockApi({
    [`GET /api/agents/${REF}`]: () => json({ agent: spawned(), queue: [], lastSeq: 1 }),
    "GET /api/agents?ended=exclude": () => json({ agents: [spawned()], running: { count: 1 } }),
    "GET /api/templates": () => json({ templates: [] }),
  });
  renderApp(`/agents/${REF}/chat`, alice);
  await screen.findByRole("heading", { level: 1 });
  act(() => openSheet({ kind: "edit-agent", agentRef: REF }));
  const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
  expect(await within(dialog).findByText("Spawned agents can't be edited.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: /Save|Archive/ })).toBeNull();
  expect(within(dialog).queryByRole("textbox")).toBeNull();
});
