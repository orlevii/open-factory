import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
afterEach(() => vi.unstubAllGlobals());

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
    "/agents/lead",
    "/agents/dev-1",
    "/agents/reviewer",
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
  const hidden = within(links[1] as HTMLElement).getByText("reports to Team Lead (@lead)");
  expect(hidden).toHaveClass("sr-only");
  expect(within(links[0] as HTMLElement).queryByText(/reports to/)).not.toBeInTheDocument();
});

test("runtime badge: Unsandboxed for local, nothing for docker", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(within(links[0] as HTMLElement).getByText("Unsandboxed")).toBeInTheDocument();
  expect(within(links[2] as HTMLElement).queryByText("Docker")).not.toBeInTheDocument();
  expect(within(links[2] as HTMLElement).queryByText("Unsandboxed")).not.toBeInTheDocument();
});

test("restartPending shows the restart icon with hidden text", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(within(links[1] as HTMLElement).getByText("restart pending")).toHaveClass("sr-only");
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

test("?justArchived shows the Undo line focused; Undo restores", async () => {
  const api = mockWorld({
    agents: tree,
    archived: [agentSummary({ slug: "reviewer", archivedAt: "2026-11-19T10:00:00Z" })],
    extra: {
      "POST /api/agents/reviewer/unarchive": () => json({ agent: tree[2] }),
      "GET /api/agents/reviewer": () => json({ agent: tree[2], queue: [], lastSeq: 0 }),
    },
  });
  renderApp("/agents?justArchived=reviewer", alice);
  expect(await screen.findByText("Archived @reviewer.")).toBeInTheDocument();
  const undo = screen.getByRole("button", { name: "Undo" });
  await vi.waitFor(() => expect(undo).toHaveFocus());
  await userEvent.click(undo);
  expect(await screen.findByText("Restored @reviewer.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "POST" && c.url.endsWith("/reviewer/unarchive"))).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
});

test("Undo mentions pending messages when the agent has some", async () => {
  mockWorld({
    agents: tree,
    archived: [agentSummary({ slug: "reviewer", archivedAt: "2026-11-19T10:00:00Z" })],
    extra: {
      "POST /api/agents/reviewer/unarchive": () => json({ agent: tree[2] }),
      "GET /api/agents/reviewer": () =>
        json({
          agent: tree[2],
          queue: [{ id: "q1", kind: "message", body: "hi", from: "@alice", createdAt: "x" }],
          lastSeq: 0,
        }),
    },
  });
  renderApp("/agents?justArchived=reviewer", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(
    await screen.findByText("Restored @reviewer. Pending messages are sent with the next message."),
  ).toBeInTheDocument();
});

test("an Undo failure shows the error with a link to the edit page", async () => {
  mockWorld({
    agents: tree,
    archived: [agentSummary({ slug: "reviewer", archivedAt: "2026-11-19T10:00:00Z" })],
    extra: {
      "POST /api/agents/reviewer/unarchive": () =>
        json(
          {
            error: {
              code: "manager_archived",
              message: "Its manager @boss is archived. Change its manager first.",
            },
          },
          409,
        ),
    },
  });
  renderApp("/agents?justArchived=reviewer", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  const alert = await screen.findByText(/Its manager @boss is archived/);
  expect(alert.closest("[role=alert]")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Edit @reviewer" })).toHaveAttribute(
    "href",
    "/agents/reviewer/edit",
  );
});

test.each<[string, World, string, string]>([
  [
    "no credential wins over everything",
    { credentials: [], templates: [] },
    "No agents yet. Add a Claude credential in Settings first.",
    "/settings#credentials",
  ],
  [
    "no templates",
    { templates: [] },
    "No agents yet. Start by creating a template.",
    "/templates/new",
  ],
  [
    "no valid template",
    { templates: [templateSummary("tech-lead", 2)] },
    "No agents yet. No template is ready: fix the errors in tech-lead.",
    "/templates/tech-lead",
  ],
  [
    "ready",
    { credentials: [credential()], templates: [templateSummary("lead")] },
    "No agents yet. Create one from a template.",
    "/agents/new",
  ],
])("empty state: %s", async (_name, world, text, href) => {
  mockWorld({ agents: [], ...world });
  renderApp("/agents", alice);
  const line = await screen.findByText((_c, el) => el?.tagName === "P" && el.textContent === text);
  expect(within(line).getByRole("link")).toHaveAttribute("href", href);
});

test("the header links to New agent", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  // The sidebar's + links there too: the page header is in the main region.
  const main = await screen.findByRole("main");
  expect(await within(main).findByRole("link", { name: "New agent" })).toHaveAttribute(
    "href",
    "/agents/new",
  );
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
  expect(within(row).getByText("reports to @lead")).toHaveClass("sr-only");
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
      "/agents/tech-lead-ab12",
      "/agents/tech-lead-cd34",
      "/agents/tech-lead-ef56",
      "/agents/old",
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

  test("with more, a muted line under the list says only the latest 200 are shown", async () => {
    endedWorld(ended, true);
    renderApp("/agents?ended=only", alice);
    const list = await screen.findByRole("list", { name: "Agents" });
    const line = await screen.findByText("Showing the latest 200 ended agents.");
    expect(line).toHaveClass("text-muted-foreground");
    expect(list.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("an old ?archived=only bookmark lands on ?ended=only", async () => {
    endedWorld(ended);
    const { router } = renderApp("/agents?archived=only", alice);
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ ended: "only" }));
    expect(screen.getByRole("radio", { name: "Ended" })).toBeChecked();
    expect(await screen.findByRole("link", { name: /Old one/ })).toBeInTheDocument();
  });
});

test("on mobile, a spawned agent's name keeps its ' · ab12' tail; the head truncates", async () => {
  vi.stubGlobal("innerWidth", 400);
  mockWorld({
    agents: [
      tree[0] as ReturnType<typeof agentSummary>,
      agentSummary({
        slug: "tech-lead-ab12",
        displayName: "A very long tech lead display name · ab12",
        kind: "ephemeral",
        reportsTo: "lead",
        depth: 1,
      }),
    ],
  });
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /A very long tech lead display name/ });
  const head = within(row).getByText("A very long tech lead display name");
  const tail = within(row).getByText("· ab12");
  expect(head).toHaveClass("truncate");
  expect(tail).toHaveClass("shrink-0");
  expect(tail).not.toHaveClass("truncate");
  // Spawned agents nest under their spawner in the Active view.
  expect(row.querySelector<HTMLElement>("[data-depth]")?.style.paddingLeft).toBe("20px");
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

  test("a persistent row shows the total with the spelled-out sr-only text; a spawned row its own; no turns is a dash", async () => {
    usageWorld();
    renderApp("/agents", alice);
    const [lead, dev, idle] = (await rows()) as [HTMLElement, HTMLElement, HTMLElement];
    expect(await within(lead).findByText("$4.60")).toBeInTheDocument();
    expect(
      within(lead).getByText("Estimated cost, last 7 days: $4.60 (own $1.20, spawned $3.40)"),
    ).toHaveClass("sr-only");
    expect(within(dev).getByText("$0.50").parentElement).toHaveClass("tabular-nums");
    expect(within(dev).getByText("Estimated cost, last 7 days: $0.50")).toHaveClass("sr-only");
    expect(within(idle).getByText("—")).toBeInTheDocument();
    expect(within(idle).getByText("Estimated cost, last 7 days: none")).toHaveClass("sr-only");
    // Hidden below md; no tooltip trigger or title inside a row link.
    expect(within(lead).getByText("$4.60").parentElement).toHaveClass("hidden", "md:block");
    expect(lead.querySelector("[title], [data-slot=tooltip-trigger]")).toBeNull();
  });

  test("the name keeps a minimum width: two lines from md, full columns only on a wide tree", async () => {
    usageWorld();
    renderApp("/agents", alice);
    const list = await screen.findByRole("list", { name: "Agents" });
    const [lead] = (await rows()) as [HTMLElement];
    // The full columns key on the tree's own width (a container query), not the window's: with the
    // sidebar open a 1024px window leaves the name track about 40px.
    expect(list).toHaveClass("@container");
    expect(lead).toHaveClass("md:grid-cols-[7rem_minmax(8rem,1fr)_4rem]");
    expect(lead).toHaveClass("@min-[54rem]:grid-cols-[7rem_minmax(0,1fr)_10rem_10rem_7rem_4rem]");
    // The second line (slug, template, runtime) can shrink below a 40-char template's width at 320.
    expect(lead.querySelector(".basis-full")).toHaveClass("min-w-0", "flex-wrap");
    expect(within(lead).getByText("$4.60").parentElement).toHaveClass(
      "md:col-start-3",
      "md:row-start-1",
      "@min-[54rem]:col-start-6",
    );
  });

  test("the muted line above the Active tree explains the column", async () => {
    usageWorld();
    renderApp("/agents", alice);
    await screen.findByRole("list", { name: "Agents" });
    const line = screen.getByText(
      "Costs are estimates for the last 7 days. A persistent agent's figure includes the agents it spawned.",
    );
    // Only where the cost cells are: they are hidden below md.
    expect(line).toHaveClass("hidden", "md:block");
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
    expect(within(solo).getByText("Estimated cost, last 7 days: none")).toHaveClass("sr-only");
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

  test("the explanation line also shows above the Ended list", async () => {
    mockWorld({
      archived: [agentSummary({ slug: "old", displayName: "Old", status: "terminated" })],
      extra: { "GET /api/usage/agents?window=rolling": () => json({ agents: [] }) },
    });
    renderApp("/agents?ended=only", alice);
    await screen.findByRole("list", { name: "Agents" });
    expect(screen.getByText(/^Costs are estimates for the last 7 days\./)).toBeInTheDocument();
  });

  test("the tree asks for the rolling window", async () => {
    const api = usageWorld();
    renderApp("/agents", alice);
    await screen.findByRole("list", { name: "Agents" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.url === "/api/usage/agents?window=rolling")).toBe(true),
    );
  });
});

describe("Agents page identity and tree lines (U2 §7)", () => {
  const A = (slug: string, over: Parameters<typeof agentSummary>[0] = {}) =>
    agentSummary({ slug, displayName: slug, ...over });
  const lines = (l: HTMLElement) => l.querySelectorAll("[data-tree-line]").length;

  test("row starts with AgentChip (avatar, name, @slug)", async () => {
    mockWorld({ agents: [A("lead", { displayName: "Team Lead" })] });
    renderApp("/agents", alice);
    const [row] = (await rows()) as [HTMLElement];
    expect(row.querySelector("svg, img")).not.toBeNull();
    expect(within(row).getByText("Team Lead")).toBeInTheDocument();
    expect(within(row).getAllByText("@lead").length).toBeGreaterThan(0);
  });

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

  test("rows deeper than the cap show a depth marker", async () => {
    const chain = Array.from({ length: 12 }, (_, i) =>
      A(i === 0 ? "n0" : `n${i}`, i === 0 ? {} : { reportsTo: `n${i - 1}` }),
    );
    mockWorld({ agents: chain });
    renderApp("/agents", alice);
    const r = await rows();
    expect(within(r[8] as HTMLElement).queryByText(/└ \d+/)).not.toBeInTheDocument();
    expect(within(r[11] as HTMLElement).getByText("└ 11")).toBeInTheDocument();
  });
});
