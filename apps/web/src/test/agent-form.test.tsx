import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { agentSummary, mockWorld } from "@/test/agent-screens-fixtures";
import { json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { comboOptionNames } from "@/test/select-helpers";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

// New agent is a sheet now: its tests are in features/agents/new-agent-sheet.test.tsx.

/** The manager picker's option names with the muted @slug (chip text repeats it for screen readers) dropped. */
const managerNames = async (trigger: HTMLElement) =>
  (await comboOptionNames(trigger)).map((n) => n.replace(/@.*/, ""));

test("Edit: the manager select leaves out the agent and its descendants, indented", async () => {
  const agents = [
    agentSummary({ slug: "cto", displayName: "CTO" }),
    agentSummary({ slug: "lead", displayName: "Lead", reportsTo: "cto", depth: 1 }),
    agentSummary({ slug: "dev-1", displayName: "Dev", reportsTo: "lead", depth: 2 }),
    agentSummary({ slug: "other", displayName: "Other", reportsTo: "cto", depth: 1 }),
  ];
  mockWorld({ agents });
  renderApp("/agents/lead/edit", alice);
  const select = await screen.findByLabelText("Manager");
  await vi.waitFor(() => expect(select).toHaveTextContent("CTO"));
  // The closed trigger shows the name and @slug, without the item's indent.
  expect(select).toHaveTextContent("@cto");
  expect(select.querySelector("[style*=padding]")).toBeNull();
  expect(await managerNames(select)).toEqual([
    "No manager (reports to the humans)",
    "CTO",
    "Other",
  ]);
  // Template and slug are read-only on Edit.
  expect(screen.queryByLabelText("Template")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
});

test("Edit: saving a running agent says it restarts when idle", async () => {
  const lead = agentSummary({ slug: "lead", displayName: "Lead", status: "idle" });
  const api = mockWorld({
    agents: [lead],
    extra: { "PATCH /api/agents/lead": () => json({ agent: { ...lead, displayName: "Boss" } }) },
  });
  renderApp("/agents/lead/edit", alice);
  const name = (await screen.findByLabelText("Display name")) as HTMLInputElement;
  await vi.waitFor(() => expect(name.value).toBe("Lead"));
  await userEvent.clear(name);
  await userEvent.type(name, "Boss");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByText(
      "Saved. The agent restarts when idle to apply the changes. Its crons from this session stop.",
    ),
  ).toBeInTheDocument();
  expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ displayName: "Boss" });
});

const projectsError = () =>
  json(
    {
      error: {
        code: "validation_error",
        message: "Invalid body",
        fields: { projects: "Project docs isn't registered." },
      },
    },
    400,
  );

test("a server projects error shows under Projects (edit)", async () => {
  const lead = agentSummary({ slug: "lead", template: "lead", projects: ["app"] });
  mockWorld({ agents: [lead], extra: { "PATCH /api/agents/lead": projectsError } });
  renderApp("/agents/lead/edit", alice);
  const group = await screen.findByRole("group", { name: /Projects/ });
  await userEvent.click(await within(group).findByRole("checkbox", { name: /docs/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await within(group).findByText("Project docs isn't registered.")).toBeInTheDocument();
});

test("Edit: a toggle sends the project array, Use template default sends null", async () => {
  const lead = agentSummary({ slug: "lead", template: "lead", projects: ["app"] });
  const api = mockWorld({
    agents: [lead],
    extra: {
      // The server keeps what it saved, so the refetch after Save agrees with the response.
      "PATCH /api/agents/lead": (body) => {
        const projects = (body as { projects: string[] | null }).projects;
        lead.grantsOverridden = projects !== null;
        lead.projects = projects ?? ["app"];
        return json({ agent: { ...lead } });
      },
    },
  });
  renderApp("/agents/lead/edit", alice);
  const group = await screen.findByRole("group", { name: /Projects/ });
  await userEvent.click(await within(group).findByRole("checkbox", { name: /docs/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/^Saved\./);
  await userEvent.click(within(group).getByRole("button", { name: "Use template default" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await vi.waitFor(() =>
    expect(api.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
      { projects: ["app", "docs"] },
      { projects: null },
    ]),
  );
});

test("Edit: the restart line follows the response's restartPending", async () => {
  const lead = agentSummary({ slug: "lead", displayName: "Lead", status: "hibernated" });
  mockWorld({
    agents: [lead],
    extra: {
      "PATCH /api/agents/lead": () =>
        json({ agent: { ...lead, displayName: "Boss", restartPending: true } }),
    },
  });
  renderApp("/agents/lead/edit", alice);
  const name = (await screen.findByLabelText("Display name")) as HTMLInputElement;
  await vi.waitFor(() => expect(name.value).toBe("Lead"));
  await userEvent.clear(name);
  await userEvent.type(name, "Boss");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByText(/^Saved\. The agent restarts when idle to apply the changes\./),
  ).toBeInTheDocument();
});
