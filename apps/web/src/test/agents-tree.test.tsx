import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
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
  expect(within(links[1] as HTMLElement).getByText("dev-1")).toBeInTheDocument();
});

test("a nested row says who it reports to, for screen readers", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  const hidden = within(links[1] as HTMLElement).getByText("reports to Team Lead (@lead)");
  expect(hidden).toHaveClass("sr-only");
  expect(within(links[0] as HTMLElement).queryByText(/reports to/)).not.toBeInTheDocument();
});

test("runtime badge: Unsandboxed for local, Docker for docker", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(within(links[0] as HTMLElement).getByText("Unsandboxed")).toBeInTheDocument();
  expect(within(links[2] as HTMLElement).getByText("Docker")).toBeInTheDocument();
  expect(within(links[2] as HTMLElement).queryByText("Unsandboxed")).not.toBeInTheDocument();
});

test("restartPending shows the restart icon with hidden text", async () => {
  mockWorld({ agents: tree });
  renderApp("/agents", alice);
  const links = await rows();
  expect(within(links[1] as HTMLElement).getByText("restart pending")).toHaveClass("sr-only");
  expect(within(links[0] as HTMLElement).queryByText("restart pending")).not.toBeInTheDocument();
});

test("the Active / Archived radio pair writes ?archived=only and lists archived agents", async () => {
  const api = mockWorld({
    agents: tree,
    archived: [agentSummary({ slug: "old", displayName: "Old one", archivedAt: "2026-11-01" })],
  });
  const { router } = renderApp("/agents", alice);
  await rows();
  const active = screen.getByRole("radio", { name: "Active" });
  expect(active).toBeChecked();
  await userEvent.click(screen.getByRole("radio", { name: "Archived" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ archived: "only" }));
  const row = await screen.findByRole("link", { name: /Old one/ });
  expect(within(row).getByText("Archived")).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/agents?archived=only")).toBe(true);
});

test("?justArchived shows the Undo line focused; Undo restores", async () => {
  const api = mockWorld({
    agents: tree,
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
  expect(await screen.findByRole("link", { name: "New agent" })).toHaveAttribute(
    "href",
    "/agents/new",
  );
});

test("archived view: a report whose manager isn't listed isn't indented but names it", async () => {
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
  renderApp("/agents?archived=only", alice);
  const row = await screen.findByRole("link", { name: /Old one/ });
  expect(row.querySelector<HTMLElement>("[data-depth]")?.style.paddingLeft).toBe("0px");
  expect(within(row).getByText("reports to @lead")).toHaveClass("sr-only");
});
