import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import {
  agentSummary,
  credential,
  mockWorld,
  templateSummary,
  type World,
} from "@/test/agent-screens-fixtures";
import { json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const tree = [
  agentSummary({
    slug: "lead",
    displayName: "Team Lead",
    template: "tech-lead",
    status: "working",
    turnOpen: true,
  }),
  agentSummary({
    slug: "dev-1",
    displayName: "Developer",
    template: "developer",
    reportsTo: "lead",
    depth: 1,
    restartPending: true,
    restartWaitingOn: 1,
  }),
  agentSummary({
    slug: "reviewer",
    displayName: "Reviewer",
    template: "proxy-reviewer",
    runtime: "docker",
    status: "hibernated",
  }),
];

const rows = async () => {
  const list = await screen.findByRole("list", { name: "Agents" });
  return within(list).getAllByRole("link");
};

test("rows keep server order and indent the name cell by depth", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(links.map((l) => l.getAttribute("href"))).toEqual([
    "/agents/lead/chat",
    "/agents/dev-1/chat",
    "/agents/reviewer/chat",
  ]);
  const nameCell = (l: HTMLElement) => l.querySelector<HTMLElement>("[data-depth]");
  expect(nameCell(links[0] as HTMLElement)?.style.paddingLeft).toBe("0px");
  expect(nameCell(links[1] as HTMLElement)?.style.paddingLeft).toBe("20px");
  expect(within(links[1] as HTMLElement).getByText("developer")).toBeInTheDocument();
  expect(within(links[1] as HTMLElement).getAllByText("@dev-1").length).toBeGreaterThan(0);
});

test("a nested row says who it reports to, for screen readers", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(
    within(links[1] as HTMLElement).getByText("reports to Team Lead (@lead)"),
  ).toBeInTheDocument();
  expect(within(links[0] as HTMLElement).queryByText(/reports to/)).not.toBeInTheDocument();
});

test("restartPending shows the restart icon with hidden text", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(within(links[1] as HTMLElement).getByText("restart pending")).toBeInTheDocument();
  expect(within(links[0] as HTMLElement).queryByText("restart pending")).not.toBeInTheDocument();
});

test("the Active / Ended radio pair writes ?ended=only and lists ended agents", async () => {
  const api = mockWorld({
    agents: tree,
    archived: [agentSummary({ slug: "old", displayName: "Old one", archivedAt: "2026-11-01" })],
  });
  const { router } = renderApp("/agents", alice);
  await rows();
  const active = screen.getByRole("radio", { name: "Active" });
  expect(active).toBeChecked();
  await userEvent.click(screen.getByRole("radio", { name: "Ended" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ ended: "only" }));
  const row = await screen.findByRole("link", { name: /Old one/ });
  expect(within(row).getByText("Archived")).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/agents?ended=only")).toBe(true);
});

test.each<[string, World]>([
  ["no credential and no template", { credentials: [], templates: [] }],
  ["ready", { credentials: [credential()], templates: [templateSummary("lead")] }],
])(
  "empty state (%s): No agents yet. and Create your first agent opens New agent",
  async (_n, world) => {
    mockWorld({ agents: [], ...world });
    renderApp("/agents", alice);
    const main = await screen.findByRole("main");
    expect(await within(main).findByText("No agents yet.")).toBeInTheDocument();
    // No gate: whatever is missing is set up inside the sheet.
    expect(within(main).queryByRole("link", { name: /credential|template/i })).toBeNull();
    await userEvent.click(within(main).getByRole("button", { name: "Create your first agent" }));
    expect(getSheetState().parent).toMatchObject({ kind: "new-agent" });
  },
);

test("the header's New agent opens the sheet", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  // The sidebar's + opens it too: the page header is in the main region.
  const main = await screen.findByRole("main");
  await userEvent.click(await within(main).findByRole("button", { name: "New agent" }));
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent" });
});

test("ended view: a report whose manager isn't listed isn't indented but names it", async () => {
  mockWorld({
    archived: [
      agentSummary({
        slug: "old",
        displayName: "Old one",
        reportsTo: "lead",
        depth: 1,
        archivedAt: "2026-11-01",
      }),
    ],
  });
  renderApp("/agents?ended=only", alice);
  const row = await screen.findByRole("link", { name: /Old one/ });
  expect(row.querySelector<HTMLElement>("[data-depth]")?.style.paddingLeft).toBe("0px");
  expect(within(row).getByText("reports to @lead")).toBeInTheDocument();
});

describe("the Ended view (S7 UI design §3)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 20, 10, 0));
  });
  afterEach(() => vi.useRealTimers());
  const at = (d: number, h = 14, m = 32) => new Date(2026, 10, d, h, m).toISOString();
  const spawned = (over: Parameters<typeof agentSummary>[0]) =>
    agentSummary({
      kind: "ephemeral",
      status: "terminated",
      reportsTo: "lead",
      depth: 1,
      template: "tech-lead",
      terminatedAt: at(19),
      terminatedBy: "lead",
      workspacePinned: false,
      ...over,
    });
  const ended = [
    spawned({
      slug: "tech-lead-ab12",
      displayName: "Tech Lead · ab12",
      workspaceGraceEndsAt: at(22),
    }),
    spawned({
      slug: "tech-lead-cd34",
      displayName: "Tech Lead · cd34",
      workspacePinned: true,
      workspaceGraceEndsAt: at(22),
    }),
    spawned({
      slug: "tech-lead-ef56",
      displayName: "Tech Lead · ef56",
      workspaceGraceEndsAt: at(17),
      workspaceDeletedAt: at(17, 14, 40),
    }),
    agentSummary({ slug: "old", displayName: "Old one", archivedAt: at(19, 9) }),
  ];
  const endedWorld = (agents: typeof ended, more = false) =>
    mockWorld({
      extra: {
        "GET /api/agents?ended=only": () => json({ agents, more, running: { count: 0, max: 8 } }),
      },
    });
  const note = (row: HTMLElement) => row.querySelector("[data-agent-note]")?.textContent ?? null;

  test("a flat list in server order (newest end first), each row noting its end and workspace", async () => {
    endedWorld(ended);
    renderApp("/agents?ended=only", alice);
    const links = await rows();
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/agents/tech-lead-ab12/chat",
      "/agents/tech-lead-cd34/chat",
      "/agents/tech-lead-ef56/chat",
      "/agents/old/chat",
    ]);
    // Flat: no row is indented, even though the spawned ones report to @lead.
    for (const l of links)
      expect(l.querySelector<HTMLElement>("[data-depth]")?.style.paddingLeft).toBe("0px");
    const [a, b, c, d] = links as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(note(a)).toBe("Terminated 19 Nov · workspace kept until 22 Nov");
    expect(note(b)).toBe("Terminated 19 Nov · workspace pinned");
    expect(note(c)).toBe("Terminated 19 Nov · workspace deleted");
    expect(note(d)).toBe("Archived 19 Nov");
    // The status slot: a label with no dot for both end states.
    expect(within(a).getByText("Terminated")).toBeInTheDocument();
    expect(within(d).getByText("Archived")).toBeInTheDocument();
    expect(a.querySelector("[data-status-dot]")).toBeNull();
    expect(screen.queryByText(/Showing the latest/)).toBeNull();
    expect(screen.queryByText(/of 8 running/)).toBeNull();
  });

  test("a workspace past its grace but not deleted yet is due for deletion, never 'kept until' a past day", async () => {
    endedWorld([
      spawned({
        slug: "tech-lead-gh78",
        displayName: "Tech Lead · gh78",
        terminatedAt: at(16),
        workspaceGraceEndsAt: at(19),
      }),
    ]);
    renderApp("/agents?ended=only", alice);
    const [a] = (await rows()) as [HTMLElement];
    expect(note(a)).toBe("Terminated 16 Nov · workspace due for deletion");
  });

  test("empty: 'No ended agents.'", async () => {
    endedWorld([]);
    renderApp("/agents?ended=only", alice);
    expect(await screen.findByText("No ended agents.")).toBeInTheDocument();
  });

  test("with more, a line under the list says only the latest 200 are shown", async () => {
    endedWorld(ended, true);
    renderApp("/agents?ended=only", alice);
    const list = await screen.findByRole("list", { name: "Agents" });
    const line = await screen.findByText("Showing the latest 200 ended agents.");
    expect(list.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("usage in the tree (S10 §12.1)", () => {
  const t = (costUsd: number, turns: number) => ({
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    turns,
  });
  const usageRow = (
    slug: string,
    kind: "persistent" | "ephemeral",
    own: ReturnType<typeof t>,
    spawned?: ReturnType<typeof t>,
    total = own,
  ) => ({
    slug,
    displayName: slug,
    kind,
    archived: false,
    terminated: false,
    own,
    ...(spawned ? { spawned } : {}),
    total,
  });
  const usageWorld = () =>
    mockWorld({
      agents: [
        agentSummary({ slug: "lead", displayName: "Team Lead" }),
        agentSummary({ slug: "dev-1", displayName: "Developer", reportsTo: "lead", depth: 1 }),
        agentSummary({ slug: "idle", displayName: "Idle one" }),
      ],
      extra: {
        "GET /api/usage/agents?window=rolling": () =>
          json({
            agents: [
              usageRow("lead", "persistent", t(1.2, 3), t(3.4, 5), t(4.6, 8)),
              usageRow("dev-1", "ephemeral", t(0.5, 2)),
              usageRow("idle", "persistent", t(0, 0)),
            ],
          }),
      },
    });

  test("a persistent row shows the total with the spelled-out text; a spawned row its own; no turns is a dash", async () => {
    usageWorld();
    renderApp("/agents", alice);
    const [lead, dev, idle] = (await rows()) as [HTMLElement, HTMLElement, HTMLElement];
    expect(await within(lead).findByText("$4.60")).toBeInTheDocument();
    expect(
      within(lead).getByText("Estimated cost, last 7 days: $4.60 (own $1.20, spawned $3.40)"),
    ).toBeInTheDocument();
    expect(within(dev).getByText("$0.50")).toBeInTheDocument();
    expect(within(dev).getByText("Estimated cost, last 7 days: $0.50")).toBeInTheDocument();
    expect(within(idle).getByText("—")).toBeInTheDocument();
    expect(within(idle).getByText("Estimated cost, last 7 days: none")).toBeInTheDocument();
    // No tooltip trigger inside a row link, and the only title is the name's (U4 §11.6).
    expect(lead.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
    expect([...lead.querySelectorAll("[title]")].map((e) => e.getAttribute("title"))).toEqual([
      "Team Lead",
    ]);
  });

  test.each([
    ["Active tree", "/agents"],
    ["Ended list", "/agents?ended=only"],
  ])("the muted line above the %s explains the column", async (_view, url) => {
    mockWorld({
      agents: [agentSummary({ slug: "lead", displayName: "Team Lead" })],
      archived: [agentSummary({ slug: "old", displayName: "Old", status: "terminated" })],
      extra: { "GET /api/usage/agents?window=rolling": () => json({ agents: [] }) },
    });
    renderApp(url, alice);
    await screen.findByRole("list", { name: "Agents" });
    expect(
      screen.getByText(
        "Costs are estimates for the last 7 days. A persistent agent's figure includes the agents it spawned.",
      ),
    ).toBeInTheDocument();
  });

  test("an agent with no row in the loaded usage shows a dash; nothing while usage hasn't loaded", async () => {
    mockWorld({
      agents: [
        agentSummary({ slug: "lead", displayName: "Team Lead" }),
        agentSummary({ slug: "solo", displayName: "Solo" }),
      ],
      extra: {
        "GET /api/usage/agents?window=rolling": () =>
          json({ agents: [usageRow("lead", "persistent", t(1.2, 3), t(0, 0), t(1.2, 3))] }),
      },
    });
    renderApp("/agents", alice);
    const [lead, solo] = (await rows()) as [HTMLElement, HTMLElement];
    // Own turns but no spawned turns: no "(own …, spawned —)" parenthesis.
    expect(await within(lead).findByText("Estimated cost, last 7 days: $1.20")).toBeInTheDocument();
    expect(within(solo).getByText("—")).toBeInTheDocument();
    expect(within(solo).getByText("Estimated cost, last 7 days: none")).toBeInTheDocument();
  });

  test("the cost cell stays empty while usage fails to load", async () => {
    mockWorld({
      agents: [agentSummary({ slug: "solo", displayName: "Solo" })],
      extra: {
        "GET /api/usage/agents?window=rolling": () => json({ error: { code: "x" } }, 500),
      },
    });
    renderApp("/agents", alice);
    const [solo] = (await rows()) as [HTMLElement];
    expect(within(solo).queryByText("—")).toBeNull();
    expect(within(solo).queryByText(/Estimated cost/)).toBeNull();
  });
});

describe("Agents page identity and tree lines (U2 §7)", () => {
  const A = (slug: string, over: Parameters<typeof agentSummary>[0] = {}) =>
    agentSummary({ slug, displayName: slug, ...over });
  const lines = (l: HTMLElement) => l.querySelectorAll("[data-tree-line]").length;

  test("template shown only when it differs from the slug stem", async () => {
    mockWorld({
      agents: [A("dev-abcd", { template: "dev" }), A("lead", { template: "ceo" })],
    });
    renderApp("/agents", alice);
    const [a, b] = (await rows()) as [HTMLElement, HTMLElement];
    expect(within(a).queryByText("dev")).not.toBeInTheDocument();
    expect(within(b).getByText("ceo")).toBeInTheDocument();
  });

  test("'Unsandboxed' only for local runtime; Docker never shown", async () => {
    mockWorld({ agents: [A("a", { runtime: "local" }), A("b", { runtime: "docker" })] });
    renderApp("/agents", alice);
    const [a, b] = (await rows()) as [HTMLElement, HTMLElement];
    expect(within(a).getByText("Unsandboxed")).toBeInTheDocument();
    expect(within(b).queryByText("Unsandboxed")).not.toBeInTheDocument();
    expect(screen.queryByText("Docker")).not.toBeInTheDocument();
  });

  test("continuous tree lines: one line element per ancestor level with later siblings", async () => {
    mockWorld({
      agents: [
        A("root"),
        A("a", { reportsTo: "root" }),
        A("a1", { reportsTo: "a" }),
        A("a2", { reportsTo: "a" }),
        A("b", { reportsTo: "root" }),
        A("b1", { reportsTo: "b" }),
      ],
    });
    renderApp("/agents", alice);
    const r = await rows();
    // root, a, a1, a2, b, b1: a1 sits under a, which has a later sibling (b); a2 too; b1's parent b is last.
    expect(r.map((l) => lines(l))).toEqual([0, 0, 1, 1, 0, 0]);
  });

  test("the status label is part of the row's accessible name; the name carries its full value in title", async () => {
    mockWorld({
      agents: [A("lead", { displayName: "A very long team lead display name", status: "working" })],
    });
    renderApp("/agents", alice);
    const [lead] = (await rows()) as [HTMLElement];
    expect(lead).toHaveAccessibleName(/Working/);
    const name = lead.querySelector("[title]");
    expect(name).toHaveAttribute("title", "A very long team lead display name");
    expect(name).toHaveTextContent("A very long team lead display name");
  });

  test("rows deeper than the cap show a depth marker", async () => {
    const chain = Array.from({ length: 12 }, (_, i) =>
      A(i === 0 ? "n0" : `n${i}`, i === 0 ? {} : { reportsTo: `n${i - 1}` }),
    );
    mockWorld({ agents: chain });
    renderApp("/agents", alice);
    const r = await rows();
    expect(within(r[8] as HTMLElement).queryByText(/└ \d+/)).not.toBeInTheDocument();
    const marker = within(r[11] as HTMLElement).getByText("└ 11");
    // One unbreakable token, so a narrow name cell can't wrap the number under the elbow.
    expect(marker.textContent).not.toMatch(/[ \t\n]/);
  });
});
