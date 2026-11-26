import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, openSheet } from "@/features/sheets/sheet-store";
import { agentSummary, mockWorld, type World } from "@/test/agent-screens-fixtures";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { comboOptionNames } from "@/test/select-helpers";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

beforeEach(() => {
  fakeMatchMedia.install(false);
  resetDrafts();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const user = (handle: string, name: string, disabledAt: string | null = null) => ({
  id: handle,
  ref: refFor(handle),
  name,
  handle,
  email: `${handle}@example.com`,
  createdAt: "2026-11-01T00:00:00.000Z",
  disabledAt,
});
const USERS = [
  user("alice", "Alice"),
  user("bob", "Bob Builder"),
  user("zed", "Zed Gone", "2026-11-10T00:00:00.000Z"),
];
const AGENTS = [
  agentSummary({ handle: "cto", displayName: "CTO" }),
  agentSummary({
    handle: "lead",
    displayName: "Lead",
    template: "lead",
    status: "hibernated",
    reportsTo: { kind: "agent", ref: refFor("cto"), handle: "cto" },
    depth: 1,
  }),
];

async function openNew(world: World = {}) {
  mockWorld({ agents: AGENTS, users: USERS, ...world });
  renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  act(() => openSheet({ kind: "new-agent" }));
  await screen.findByRole("dialog", { name: "New agent" });
  const manager = await screen.findByLabelText("Manager");
  await waitFor(() => expect(manager).toBeEnabled());
  return manager;
}

async function openEdit(world: World = {}, slug = "lead") {
  mockWorld({ agents: AGENTS, users: USERS, ...world });
  renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  act(() => openSheet({ kind: "edit-agent", agentRef: refFor(slug) }));
  const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
  await within(dialog).findByRole("button", { name: "Save changes" });
  const manager = await screen.findByLabelText("Manager");
  await waitFor(() => expect(manager).toBeEnabled());
  return manager;
}

test("New agent preselects you as the manager", async () => {
  const manager = await openNew();
  expect(manager).toHaveTextContent("You (Alice · @alice)");
});

test("the picker has a People group with you first, then an Agents group; disabled users are absent", async () => {
  const manager = await openNew();
  expect(await comboOptionNames(manager)).toEqual([
    "You (Alice · @alice)",
    "Bob Builder@bob",
    "CTO@cto",
    "Lead@lead",
  ]);
  await userEvent.click(manager);
  const groups = screen.getAllByRole("group");
  const names = groups.map((g) => g.getAttribute("aria-labelledby")).filter(Boolean);
  const headings = names.map((id) => document.getElementById(id as string)?.textContent);
  expect(headings).toEqual(["People", "Agents"]);
});

test.each([
  ["@bob", ["Bob Builder@bob"]],
  ["bob", ["Bob Builder@bob"]],
  ["@cto", ["CTO@cto"]],
  ["builder", ["Bob Builder@bob"]],
])("filtering %s matches by name or handle, ignoring a leading @", async (query, expected) => {
  const manager = await openNew();
  await userEvent.click(manager);
  await userEvent.type(await screen.findByPlaceholderText("Search…"), query);
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(expected.length));
  expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-value"))).toEqual(
    expected.map((e) => `o:${refFor(e.split("@").at(-1) as string)}`),
  );
});

test("picking a person sets them as the manager", async () => {
  const manager = await openNew();
  await userEvent.click(manager);
  await userEvent.click(await screen.findByRole("option", { name: "Bob Builder@bob" }));
  expect(manager).toHaveTextContent("Bob Builder");
  expect(manager).toHaveTextContent("@bob");
});

test("if the users list fails, you and the agents are still pickable", async () => {
  const manager = await openNew({
    extra: {
      "GET /api/users": () => json({ error: { code: "boom", message: "No." } }, 500),
    },
  });
  expect(await comboOptionNames(manager)).toEqual(["You (Alice · @alice)", "CTO@cto", "Lead@lead"]);
});

test("Edit leaves the agent and its descendants out, and shows the saved human manager", async () => {
  const manager = await openEdit({
    agents: [
      AGENTS[0] as (typeof AGENTS)[number],
      agentSummary({
        handle: "lead",
        displayName: "Lead",
        template: "lead",
        status: "hibernated",
        reportsTo: { kind: "human", ref: refFor("bob"), handle: "bob" },
      }),
      agentSummary({
        handle: "dev",
        displayName: "Dev",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        depth: 1,
      }),
    ],
  });
  expect(manager).toHaveTextContent("Bob Builder");
  // The saved manager floats to the top of its group, as in every combobox.
  expect(await comboOptionNames(manager)).toEqual([
    "Bob Builder@bob",
    "You (Alice · @alice)",
    "CTO@cto",
  ]);
});

test("a saved human manager shows as a plain handle, not archived, while the users list has failed", async () => {
  const manager = await openEdit({
    agents: [
      agentSummary({
        handle: "lead",
        displayName: "Lead",
        template: "lead",
        status: "hibernated",
        reportsTo: { kind: "human", ref: refFor("bob"), handle: "bob" },
      }),
    ],
    extra: {
      "GET /api/users": () => json({ error: { code: "boom", message: "No." } }, 500),
    },
  });
  await waitFor(() => expect(manager).toHaveTextContent("@bob"));
  expect(manager).not.toHaveTextContent("archived");
});

test("a saved manager who has since been disabled stays shown, named as disabled", async () => {
  const manager = await openEdit({
    agents: [
      agentSummary({
        handle: "lead",
        displayName: "Lead",
        template: "lead",
        status: "hibernated",
        reportsTo: { kind: "human", ref: refFor("zed"), handle: "zed" },
      }),
    ],
  });
  expect(manager).toHaveTextContent("@zed (disabled)");
  expect(await comboOptionNames(manager)).not.toContain("Zed Gone");
});
