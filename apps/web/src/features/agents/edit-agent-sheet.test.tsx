import type { AgentSummary } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { hasDraft, resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { agentSummary, credential, mockWorld, type World } from "@/test/agent-screens-fixtures";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { comboOptionNames, pickOption } from "@/test/select-helpers";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));

beforeEach(() => {
  fakeMatchMedia.install(false);
  resetDrafts();
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const sheet = () => screen.findByRole("dialog", { name: "Edit agent" });
/** The footer's Close (the header's X has the same name). */
const footerClose = (dialog: HTMLElement) =>
  within(dialog.querySelector<HTMLElement>("[data-slot=sheet-footer]") ?? dialog).getByRole(
    "button",
    { name: "Close" },
  );
const saveButton = () => screen.getByRole("button", { name: /^(Save changes|Saving…)$/ });
/** A stopped agent: saving it restarts nothing. */
const lead = (over: Partial<AgentSummary> = {}) =>
  agentSummary({
    slug: "lead",
    displayName: "Lead",
    description: "Leads",
    template: "lead",
    status: "hibernated",
    projects: ["app"],
    ...over,
  });
const patches = (api: { calls: { method: string; url: string; body: unknown }[] }) =>
  api.calls.filter((c) => c.method === "PATCH").map((c) => c.body);

/** Renders `path` and opens Edit agent for `slug` over it, once its form has rendered. */
async function open(world: World = {}, { slug = "lead", path = "/agents", form = true } = {}) {
  const api = mockWorld({ agents: [lead()], ...world });
  const utils = renderApp(path, alice);
  if (path === "/agents") await screen.findByRole("heading", { level: 1, name: "Agents" });
  else await waitFor(() => expect(utils.router.state.status).toBe("idle"));
  act(() => openSheet({ kind: "edit-agent", slug }));
  const dialog = await sheet();
  if (form) {
    await within(dialog).findByRole("button", { name: "Save changes" });
    await vi.waitFor(() => expect(field("Display name")).toBeEnabled());
  }
  return { ...utils, api, dialog };
}
/** A PATCH that waits for the test to answer it. */
function held() {
  let answer: (r: Response) => void = () => {};
  return {
    route: () =>
      new Promise<Response>((r) => {
        answer = r;
      }),
    answer: (r: Response) => answer(r),
  };
}
const saved = (a: AgentSummary) => () => json({ agent: a });
/** The session page's own reads, for a sheet opened over /agents/lead. */
const sessionRoutes = {
  "GET /api/agents/lead/events?": () =>
    json({ events: [], hasMore: { before: false, after: false } }),
};

async function rename(to: string) {
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), to);
}

// --- The body ---

test("header Edit agent, a wrapping @slug · Template description, every field and no template or slug input", async () => {
  const { dialog } = await open(
    {
      agents: [lead({ slug: "a-very-long-agent-slug-that-wraps", template: "lead" })],
    },
    { slug: "a-very-long-agent-slug-that-wraps" },
  );
  const description = within(dialog).getByText(
    (_c, el) =>
      el?.getAttribute("data-slot") === "sheet-description" &&
      el.textContent === "@a-very-long-agent-slug-that-wraps · Template lead",
  );
  expect(description.className).not.toMatch(/truncate/);
  expect(description.className).toMatch(/overflow-wrap:anywhere/);
  expect(within(description).getByText("lead")).toHaveClass("font-mono");
  expect(field("Display name")).toHaveValue("Lead");
  expect(field("Manager")).toBeInTheDocument();
  expect(field("Description")).toHaveValue("Leads");
  expect(field("Credential")).toHaveTextContent("work");
  expect(within(dialog).getByRole("group", { name: /Projects/ })).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Template")).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText(/Slug|Address/)).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
  expect(footerClose(dialog)).toBeInTheDocument();
});

test("the manager picker leaves out the agent and its descendants", async () => {
  const agents = [
    agentSummary({ slug: "cto", displayName: "CTO" }),
    lead({ reportsTo: "cto", depth: 1 }),
    agentSummary({ slug: "dev-1", displayName: "Dev", reportsTo: "lead", depth: 2 }),
    agentSummary({ slug: "other", displayName: "Other", reportsTo: "cto", depth: 1 }),
  ];
  await open({ agents });
  const select = field("Manager");
  await vi.waitFor(() => expect(select).toHaveTextContent("CTO"));
  expect((await comboOptionNames(select)).map((n) => n.replace(/@.*/, ""))).toEqual([
    "No manager (reports to the humans)",
    "CTO",
    "Other",
  ]);
});

test("the restart notice names the dirty credential on a running agent, and goes when it's undone", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    credentials: [credential("work"), credential("prod")],
  });
  const notice =
    "Saving restarts @lead the next time it is idle, to apply the new credential. Crons it set in this session stop.";
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
  await pickOption(field("Credential"), /^prod/);
  expect(await screen.findByText(notice)).toBeInTheDocument();
  await pickOption(field("Credential"), /^work/);
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
});

test("the restart notice names every changed kind", async () => {
  await open({
    agents: [lead({ status: "working" }), agentSummary({ slug: "cto", displayName: "CTO" })],
    credentials: [credential("work"), credential("prod")],
  });
  await pickOption(field("Credential"), /^prod/);
  await userEvent.click(
    within(screen.getByRole("group", { name: /Projects/ })).getByRole("checkbox", {
      name: /docs/,
    }),
  );
  expect(
    await screen.findByText(
      "Saving restarts @lead the next time it is idle, to apply the new credential and the new projects. Crons it set in this session stop.",
    ),
  ).toBeInTheDocument();
});

test("no restart notice for an agent that isn't running", async () => {
  await open({ credentials: [credential("work"), credential("prod")] });
  await pickOption(field("Credential"), /^prod/);
  await vi.waitFor(() => expect(field("Credential")).toHaveTextContent("prod"));
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
});

test("Nothing to save: no field changed. stays inline and sends nothing", async () => {
  const { api, dialog } = await open();
  await userEvent.click(saveButton());
  expect(await within(dialog).findByText("Nothing to save: no field changed.")).toBeInTheDocument();
  expect(patches(api)).toEqual([]);
  expect(getSheetState().parent?.kind).toBe("edit-agent");
  expect(notify).not.toHaveBeenCalled();
});

// --- Save (§6.4, §10.2) ---

test("save over another page closes the sheet, clears the draft, sends the diff and toasts Saved @slug.", async () => {
  const { api } = await open({
    extra: { "PATCH /api/agents/lead": saved(lead({ displayName: "Boss" })) },
  });
  await rename(" Boss ");
  expect(hasDraft("edit-agent:lead")).toBe(true);
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toEqual([{ displayName: "Boss" }]);
  expect(hasDraft("edit-agent:lead")).toBe(false);
  expect(vi.mocked(notify).mock.calls.map((c) => c[0].text)).toEqual(["Saved @lead."]);
});

test("on its own session, a display-name-only save toasts nothing", async () => {
  await open(
    { extra: { ...sessionRoutes, "PATCH /api/agents/lead": saved(lead({ displayName: "Boss" })) } },
    { path: "/agents/lead" },
  );
  expect(getSheetState().parent?.at).toBe("/agents/lead");
  await rename("Boss");
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(notify).not.toHaveBeenCalled();
});

test("on its own session, any other field toasts Saved @slug.", async () => {
  await open(
    { extra: { ...sessionRoutes, "PATCH /api/agents/lead": saved(lead({ description: "New" })) } },
    { path: "/agents/lead" },
  );
  await userEvent.clear(field("Description"));
  await userEvent.type(field("Description"), "New");
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead.");
});

test("a save that restarts always says so, even display name only on its own session", async () => {
  await open(
    {
      extra: {
        ...sessionRoutes,
        "PATCH /api/agents/lead": saved(lead({ displayName: "Boss", restartPending: true })),
      },
    },
    { path: "/agents/lead" },
  );
  await rename("Boss");
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead. Restarts when idle.");
});

test("a running agent's save says it restarts", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    extra: { "PATCH /api/agents/lead": saved(lead({ status: "idle", displayName: "Boss" })) },
  });
  await rename("Boss");
  expect(
    screen.getByText(
      "Saving restarts @lead the next time it is idle, to apply the new display name. Crons it set in this session stop.",
    ),
  ).toBeInTheDocument();
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead. Restarts when idle.");
});

test("Enter twice while saving sends one PATCH", async () => {
  const patch = held();
  const { api } = await open({ extra: { "PATCH /api/agents/lead": patch.route } });
  await rename("Boss");
  await userEvent.type(field("Display name"), "{Enter}");
  await screen.findByRole("button", { name: /Saving…/ });
  await userEvent.click(saveButton());
  await act(async () => {
    field("Display name").form?.requestSubmit();
  });
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toHaveLength(1);
});

test("a server projects error shows under Projects", async () => {
  const { dialog } = await open({
    extra: {
      "PATCH /api/agents/lead": () =>
        json(
          {
            error: {
              code: "validation_error",
              message: "Invalid body",
              fields: { projects: "Project docs isn't registered." },
            },
          },
          400,
        ),
    },
  });
  const group = within(dialog).getByRole("group", { name: /Projects/ });
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  await userEvent.click(saveButton());
  expect(await within(group).findByText("Project docs isn't registered.")).toBeInTheDocument();
  expect(getSheetState().parent?.kind).toBe("edit-agent");
});

test("a toggle sends the project array; Use template default sends null", async () => {
  const agent = lead({ grantsOverridden: true, projects: ["app", "docs"] });
  const { api } = await open({
    agents: [agent],
    extra: { "PATCH /api/agents/lead": saved(lead()) },
  });
  const group = screen.getByRole("group", { name: /Projects/ });
  await userEvent.click(within(group).getByRole("button", { name: "Use template default" }));
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toEqual([{ projects: null }]);
});

// --- Dismissed while saving (break-ui M2) ---

test("a late success toasts Saved @slug. and clears the draft when nothing reopened", async () => {
  const patch = held();
  await open({ extra: { "PATCH /api/agents/lead": patch.route } });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead.");
  expect(hasDraft("edit-agent:lead")).toBe(false);
});

test("a late success keeps the draft of the same agent reopened and typed into meanwhile", async () => {
  const patch = held();
  await open({ extra: { "PATCH /api/agents/lead": patch.route } });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "edit-agent", slug: "lead" }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name")).toBeEnabled());
  await rename("Second");
  act(() => closeSheet());
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(hasDraft("edit-agent:lead")).toBe(true);
});

test("a late success still clears its draft when only another agent's Edit opened meanwhile", async () => {
  const patch = held();
  await open({
    agents: [lead(), agentSummary({ slug: "other", displayName: "Other" })],
    extra: { "PATCH /api/agents/lead": patch.route },
  });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "edit-agent", slug: "other" }));
  await sheet();
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(hasDraft("edit-agent:lead")).toBe(false);
});

test("a late failure toasts the error with Open form, which reopens the kept draft", async () => {
  const patch = held();
  await open({ extra: { "PATCH /api/agents/lead": patch.route } });
  await rename("Kept");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  await act(async () =>
    patch.answer(json({ error: { code: "boom", message: "The server fell over." } }, 500)),
  );
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  const toast = vi.mocked(notify).mock.calls[0]?.[0];
  expect(toast?.text).toBe("Couldn't save @lead: The server fell over.");
  expect(toast?.action?.label).toBe("Open form");
  expect(hasDraft("edit-agent:lead")).toBe(true);
  act(() => toast?.action?.run());
  await sheet();
  expect(await screen.findByLabelText("Display name")).toHaveValue("Kept");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
});

// --- States ---

test("an archived agent says so with a Restore button and no form; Restore brings the form back", async () => {
  const archived = lead({ archivedAt: "2026-11-20T10:00:00.000Z" });
  const { api, dialog } = await open(
    {
      agents: [],
      archived: [archived],
      extra: {
        "POST /api/agents/lead/unarchive": () => {
          archived.archivedAt = null;
          return json({ agent: archived });
        },
      },
    },
    { form: false },
  );
  expect(await within(dialog).findByText("This agent is archived.")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Display name")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
  expect(await within(dialog).findByLabelText("Display name")).toHaveValue("Lead");
  // Restore went away with the notice: focus follows to the form.
  await waitFor(() => expect(field("Display name")).toHaveFocus());
  expect(api.calls.filter((c) => c.url === "/api/agents/lead/unarchive")).toHaveLength(1);
  expect(notify).not.toHaveBeenCalled();
});

test("a refused Restore says why inline", async () => {
  const { dialog } = await open(
    {
      agents: [],
      archived: [lead({ archivedAt: "2026-11-20T10:00:00.000Z" })],
      extra: {
        "POST /api/agents/lead/unarchive": () =>
          json({ error: { code: "manager_archived", message: "Its manager is archived." } }, 409),
      },
    },
    { form: false },
  );
  await userEvent.click(await within(dialog).findByRole("button", { name: "Restore" }));
  expect(
    await within(dialog).findByText("Couldn't restore @lead: Its manager is archived."),
  ).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Restore" })).toBeInTheDocument();
});

test("a spawned agent can't be edited", async () => {
  const { dialog } = await open({ agents: [lead({ kind: "ephemeral" })] }, { form: false });
  expect(await within(dialog).findByText("Spawned agents can't be edited.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  expect(footerClose(dialog)).toBeInTheDocument();
});

test("an unknown slug: There is no agent @x.", async () => {
  const { dialog } = await open(
    {
      extra: {
        "GET /api/agents/x": () =>
          json({ error: { code: "agent_not_found", message: "No agent x." } }, 404),
      },
    },
    { slug: "x", form: false },
  );
  expect(await within(dialog).findByText("There is no agent @x.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
});

test("archived by another tab while open: the sheet flips and keeps the draft", async () => {
  const agent = lead();
  const { dialog, queryClient } = await open({ agents: [agent] });
  await rename("Half typed");
  agent.archivedAt = "2026-11-20T10:00:00.000Z";
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", "lead"] }));
  expect(await within(dialog).findByText("This agent is archived.")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Display name")).not.toBeInTheDocument();
  expect(hasDraft("edit-agent:lead")).toBe(true);
  agent.archivedAt = null;
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", "lead"] }));
  expect(await within(dialog).findByLabelText("Display name")).toHaveValue("Half typed");
});

test("restored by another tab while focus is in the sheet: the form comes back without taking focus", async () => {
  const agent = lead({ archivedAt: "2026-11-20T10:00:00.000Z" });
  const { dialog, queryClient } = await open({ agents: [], archived: [agent] }, { form: false });
  await within(dialog).findByText("This agent is archived.");
  const x = within(
    dialog.querySelector<HTMLElement>("[data-slot=sheet-header]") ?? dialog,
  ).getByRole("button", { name: "Close" });
  x.focus();
  agent.archivedAt = null;
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", "lead"] }));
  await within(dialog).findByLabelText("Display name");
  expect(x).toHaveFocus();
});

test("deleted by another tab while open: the sheet flips to not found", async () => {
  const { dialog, queryClient } = await open();
  mockWorld({
    agents: [],
    extra: {
      "GET /api/agents/lead": () =>
        json({ error: { code: "agent_not_found", message: "No agent lead." } }, 404),
    },
  });
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", "lead"] }));
  expect(await within(dialog).findByText("There is no agent @lead.")).toBeInTheDocument();
});

test("focus on open goes to Display name", async () => {
  await open();
  await waitFor(() => expect(field("Display name")).toHaveFocus());
});

test("Add credential stacks over Edit agent and names it", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Add credential" }));
  const child = await screen.findByRole("dialog", { name: "Add credential" });
  expect(
    within(child).getByText(
      "For Edit agent. Saved to Settings → Credentials; other agents can use it.",
    ),
  ).toBeInTheDocument();
});

test("Add project stacks over Edit agent", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Add project" }));
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeInTheDocument();
});

// --- Entry points ---

test("/agents/lead/edit lands on /agents/lead with Edit agent open", async () => {
  mockWorld({ agents: [lead()], extra: sessionRoutes });
  const { router } = renderApp("/agents/lead/edit", alice);
  await sheet();
  expect(router.state.location.pathname).toBe("/agents/lead");
  expect(getSheetState().parent).toMatchObject({
    kind: "edit-agent",
    slug: "lead",
    at: "/agents/lead",
  });
  expect(await screen.findByLabelText("Display name")).toHaveValue("Lead");
});
