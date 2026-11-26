import type { AgentSummary } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { MANAGE_ORG_HELP } from "@/features/agents/manage-org-help";
import { hasDraft, resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { FORM_MSG } from "@/lib/form-messages.ts";
import {
  agentSummary,
  credential,
  mockWorld,
  project,
  type World,
} from "@/test/agent-screens-fixtures";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json } from "@/test/mock-api";
import { refFor } from "@/test/refs";
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
    handle: "lead",
    displayName: "Lead",
    description: "Leads",
    template: "lead",
    status: "hibernated",
    projects: ["app"],
    ...over,
  });
const patches = (api: { calls: { method: string; url: string; body: unknown }[] }) =>
  api.calls.filter((c) => c.method === "PATCH").map((c) => c.body);

/** Renders `path` and opens Edit agent for `handle` over it, once its form has rendered. */
async function open(world: World = {}, { handle = "lead", path = "/agents", form = true } = {}) {
  const api = mockWorld({ agents: [lead()], ...world });
  const utils = renderApp(path, alice);
  if (path === "/agents") await screen.findByRole("heading", { level: 1, name: "Agents" });
  else await waitFor(() => expect(utils.router.state.status).toBe("idle"));
  act(() => openSheet({ kind: "edit-agent", agentRef: refFor(handle) }));
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
  [`GET /api/agents/${refFor("lead")}/events?`]: () =>
    json({ events: [], hasMore: { before: false, after: false } }),
};

async function rename(to: string) {
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), to);
}

// --- The body ---

test("header Edit agent, an @handle · Template description, every field and no template input", async () => {
  const { dialog } = await open(
    {
      agents: [lead({ handle: "a-very-long-agent-handle-that-wraps", template: "lead" })],
    },
    { handle: "a-very-long-agent-handle-that-wraps" },
  );
  expect(
    within(dialog).getByText(
      (_c, el) =>
        el?.getAttribute("data-slot") === "sheet-description" &&
        el.textContent === "@a-very-long-agent-handle-that-wraps · Template lead",
    ),
  ).toBeInTheDocument();
  expect(field("Display name")).toHaveValue("Lead");
  expect(field("Manager")).toBeInTheDocument();
  expect(field("Description")).toHaveValue("Leads");
  expect(field("Credential")).toHaveTextContent("work");
  expect(within(dialog).getByRole("group", { name: /Projects/ })).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Template")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
  expect(footerClose(dialog)).toBeInTheDocument();
});

test("the manager picker leaves out the agent and its descendants", async () => {
  const agents = [
    agentSummary({ handle: "cto", displayName: "CTO" }),
    lead({ reportsTo: { kind: "agent", ref: refFor("cto"), handle: "cto" }, depth: 1 }),
    agentSummary({
      handle: "dev-1",
      displayName: "Dev",
      reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
      depth: 2,
    }),
    agentSummary({
      handle: "other",
      displayName: "Other",
      reportsTo: { kind: "agent", ref: refFor("cto"), handle: "cto" },
      depth: 1,
    }),
  ];
  await open({ agents });
  const select = field("Manager");
  await vi.waitFor(() => expect(select).toHaveTextContent("CTO"));
  // The closed trigger shows the name and @handle.
  expect(select).toHaveTextContent("@cto");
  expect(await comboOptionNames(select)).toEqual([
    "You (Alice · @alice)",
    "CTO@cto",
    "Other@other",
  ]);
});

const SELF = FORM_MSG.restartsSelf;
const RUNNING_HELP =
  "A running agent restarts when idle to apply a change. Crons it set in this session stop.";

test("every restart notice fits the outcome line: at most 40 characters, no user value", () => {
  for (const m of [FORM_MSG.restartsSelf, FORM_MSG.restartsReports, FORM_MSG.restartsBoth]) {
    expect(m.length, m).toBeLessThanOrEqual(40);
    expect(m).not.toContain("@");
  }
});

test("the restart notice shows on a running agent's change, and goes when it's undone", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    credentials: [credential("work"), credential("prod")],
  });
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
  await pickOption(field("Credential"), /^prod/);
  expect(await screen.findByText(SELF)).toBeInTheDocument();
  await pickOption(field("Credential"), /^work/);
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
});

test("the restart help is there before any edit and unchanged by one, so nothing moves", async () => {
  const { dialog } = await open({
    agents: [
      lead({ status: "working" }),
      agentSummary({
        handle: "dev-1",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "working",
        depth: 1,
      }),
      agentSummary({
        handle: "dev-2",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "idle",
        depth: 1,
      }),
      agentSummary({
        handle: "dev-3",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "hibernated",
        depth: 1,
      }),
    ],
    credentials: [credential("work"), credential("prod")],
  });
  const help = `${RUNNING_HELP} Its direct reports @dev-1 and @dev-2 restart too when a name or description changes.`;
  const before = await within(dialog).findByText(help);
  expect(before.closest("[data-slot=sheet-footer]")).toBeNull();
  await pickOption(field("Credential"), /^prod/);
  await rename("Boss");
  expect(await screen.findByText(FORM_MSG.restartsBoth)).toBeInTheDocument();
  expect(within(dialog).getByText(help)).toBe(before);
});

test("Save is described by the restart notice, so it is heard", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    credentials: [credential("work"), credential("prod")],
  });
  expect(saveButton()).not.toHaveAccessibleDescription();
  await pickOption(field("Credential"), /^prod/);
  await vi.waitFor(() => expect(saveButton()).toHaveAccessibleDescription(SELF));
});

test("the restart notice is the footer's notice; a save failure replaces it until the next edit", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    credentials: [credential("work"), credential("prod")],
    extra: {
      [`PATCH /api/agents/${refFor("lead")}`]: () =>
        Promise.reject(new TypeError("Failed to fetch")),
    },
  });
  await pickOption(field("Credential"), /^prod/);
  const notice = await screen.findByText(SELF);
  expect(notice.closest("[data-slot=sheet-footer]")).not.toBeNull();
  expect(notice).toHaveAttribute("data-shown");
  await userEvent.click(saveButton());
  const error = await screen.findByText("Couldn't reach the server. Try again.");
  expect(error.closest("[role=alert]")?.closest("[data-slot=sheet-footer]")).not.toBeNull();
  expect(screen.getByText(SELF)).not.toHaveAttribute("data-shown");
  expect(saveButton()).not.toHaveAccessibleDescription();
  await rename("Boss");
  expect(screen.queryByText("Couldn't reach the server. Try again.")).toBeNull();
  expect(screen.getByText(SELF)).toHaveAttribute("data-shown");
});

test("a text change restarts the running direct reports too", async () => {
  await open({
    agents: [
      lead({ status: "idle" }),
      agentSummary({
        handle: "dev-1",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "working",
        depth: 1,
      }),
      agentSummary({
        handle: "dev-2",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "hibernated",
        depth: 1,
      }),
    ],
    credentials: [credential("work"), credential("prod")],
  });
  expect(
    await screen.findByText(
      `${RUNNING_HELP} Its direct report @dev-1 restarts too when a name or description changes.`,
    ),
  ).toBeInTheDocument();
  await pickOption(field("Credential"), /^prod/);
  // A credential is the agent's own: its reports don't restart.
  expect(await screen.findByText(SELF)).toBeInTheDocument();
  await rename("Boss");
  expect(await screen.findByText(FORM_MSG.restartsBoth)).toBeInTheDocument();
});

test("a stopped agent's text change still restarts its running reports", async () => {
  await open({
    agents: [
      lead(),
      agentSummary({
        handle: "dev-1",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "idle",
        depth: 1,
      }),
      agentSummary({
        handle: "dev-2",
        reportsTo: { kind: "agent", ref: refFor("lead"), handle: "lead" },
        status: "working",
        depth: 1,
      }),
    ],
  });
  expect(
    await screen.findByText(
      "Its direct reports @dev-1 and @dev-2 restart when idle if a name or description changes.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/^A running agent/)).not.toBeInTheDocument();
  await userEvent.clear(field("Description"));
  await userEvent.type(field("Description"), "New");
  expect(await screen.findByText(FORM_MSG.restartsReports)).toBeInTheDocument();
});

test("the credential select is disabled while the list loads", async () => {
  await open({ extra: { "GET /api/credentials": () => new Promise<Response>(() => {}) } });
  expect(field("Credential")).toBeDisabled();
  expect(field("Credential")).toHaveTextContent("work");
});

test("no restart notice or help for an agent that isn't running", async () => {
  await open({ credentials: [credential("work"), credential("prod")] });
  await pickOption(field("Credential"), /^prod/);
  await vi.waitFor(() => expect(field("Credential")).toHaveTextContent("prod"));
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
  expect(screen.queryByText(/restarts? (too )?when/)).not.toBeInTheDocument();
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

test("save over another page closes the sheet, clears the draft, sends the diff and toasts Saved @handle.", async () => {
  const { api } = await open({
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ displayName: "Boss" })) },
  });
  await rename(" Boss ");
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(true);
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toEqual([{ displayName: "Boss" }]);
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(false);
  expect(vi.mocked(notify).mock.calls.map((c) => c[0].text)).toEqual(["Saved @lead."]);
});

// --- Rename ---

const peer = (handle: string, over: Partial<AgentSummary> = {}) =>
  agentSummary({ handle, displayName: handle, ...over });
const changeHandle = async (to: string) => {
  const change = screen.queryByRole("button", { name: "Change" });
  if (change) await userEvent.click(change);
  const input = field("Handle");
  await userEvent.clear(input);
  await userEvent.type(input, to);
};

test("a taken handle shows 'Another agent or person has this handle' on blur, and sends nothing", async () => {
  const { api } = await open({ agents: [lead(), peer("dev")] });
  await changeHandle("dev");
  await userEvent.tab();
  expect(await screen.findByText("Another agent or person has this handle")).toBeInTheDocument();
  expect(field("Handle")).toHaveAttribute("aria-invalid", "true");
  await userEvent.click(saveButton());
  expect(patches(api)).toEqual([]);
});

test("the agent's own handle is not taken, and the old handle is offered for typing again", async () => {
  await open({ agents: [lead()] });
  await changeHandle("boss");
  await changeHandle("lead");
  await userEvent.tab();
  expect(screen.queryByText("Another agent or person has this handle")).not.toBeInTheDocument();
});

test("a bad handle shows the schema's message on blur and clears while typing a good one", async () => {
  await open({ agents: [lead()] });
  await changeHandle("-bad");
  await userEvent.tab();
  expect(await screen.findByText("Start and end with a letter or number")).toBeInTheDocument();
  await userEvent.clear(field("Handle"));
  await userEvent.type(field("Handle"), "good");
  await waitFor(() =>
    expect(screen.queryByText("Start and end with a letter or number")).not.toBeInTheDocument(),
  );
});

test("a 409 from the server lands on the Handle field with the same message", async () => {
  await open({
    agents: [lead()],
    extra: {
      [`PATCH /api/agents/${refFor("lead")}`]: () =>
        json(
          {
            error: {
              code: "handle_taken",
              message: "Another agent or person has this handle",
              fields: { handle: "Another agent or person has this handle" },
            },
          },
          409,
        ),
    },
  });
  await changeHandle("boss");
  await userEvent.click(saveButton());
  expect(await screen.findByText("Another agent or person has this handle")).toBeInTheDocument();
  expect(getSheetState().parent).toBeDefined();
});

test("a rename closes the sheet and toasts '@old is now @new'; Undo puts the old handle back", async () => {
  const { api } = await open({
    agents: [lead()],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ handle: "boss" })) },
  });
  await changeHandle("boss");
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toEqual([{ handle: "boss" }]);
  const toast = vi.mocked(notify).mock.calls.at(-1)?.[0];
  expect(toast?.text).toBe("@lead is now @boss");
  await toast?.undo?.();
  expect(patches(api)).toEqual([{ handle: "boss" }, { handle: "lead" }]);
});

test("Undo says '@old was taken' when someone took the handle meanwhile", async () => {
  await open({
    agents: [lead()],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ handle: "boss" })) },
  });
  await changeHandle("boss");
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  const toast = vi.mocked(notify).mock.calls.at(-1)?.[0];
  vi.mocked(fetch).mockImplementationOnce(async () =>
    json({ error: { code: "handle_taken", message: "taken", fields: { handle: "taken" } } }, 409),
  );
  await expect(toast?.undo?.()).rejects.toMatchObject({
    status: 409,
    message: "Couldn't undo: @lead was taken",
  });
});

test("renaming a running agent doesn't show the restart note", async () => {
  await open({ agents: [lead({ status: "idle" })] });
  await changeHandle("boss");
  expect(screen.queryByText(/^Saving restarts/)).not.toBeInTheDocument();
});

// --- Model and effort ---

const agentConfig = (overlay: Record<string, unknown> = {}, version = "v1") => ({
  overlay,
  version,
  template: {
    name: "lead",
    doc: { template: { effort: "high" }, settings: {}, mcp: { mcpServers: {} } },
    valid: true,
  },
  merged: { template: { effort: "high" }, settings: {}, mcp: { mcpServers: {} } },
  issues: [],
});
const savedConfig = (overlay: Record<string, unknown>) => ({
  ...agentConfig(overlay, "v2"),
  changes: ["model: sonnet → opus"],
  restartChecked: true,
  checked: "full" as const,
});
const templateConfig = {
  doc: { template: { effort: "high" }, settings: {}, mcp: { mcpServers: {} } },
  hashes: { "template.yaml": "h", "settings.json": null, "mcp.json": null },
  issues: [],
  localSkills: [],
  agents: { live: 1, archived: 0, cantStart: 0 },
};
const configRoutes = (overlay: Record<string, unknown> = {}) => ({
  "GET /api/templates/lead/config": () => json(templateConfig),
  [`GET /api/agents/${refFor("lead")}/config`]: () => json(agentConfig(overlay)),
});
const puts = (api: { calls: { method: string; url: string; body: unknown }[] }) =>
  api.calls.filter((c) => c.method === "PUT" && c.url === `/api/agents/${refFor("lead")}/config`);

test("Model and Effort show what the agent overrides, each inherit option naming the template's value", async () => {
  await open({
    agents: [
      lead({
        model: { value: "opus", source: "agent" },
        effort: { value: "high", source: "template" },
      }),
    ],
    extra: configRoutes({ template: { model: "opus" } }),
  });
  expect(field("Model")).toHaveTextContent("opus");
  await vi.waitFor(() => expect(field("Effort")).toHaveTextContent("Template's (high)"));
  await userEvent.click(field("Model"));
  expect(
    await screen.findByRole("option", { name: "Template's (Claude Code default)" }),
  ).toBeVisible();
});

test("a model change alone is saved through the agent's config, keeping its other overlay keys, with no PATCH", async () => {
  const overlay = { settings: { env: { A: "1" } } };
  const { api } = await open({
    extra: {
      ...configRoutes(overlay),
      [`PUT /api/agents/${refFor("lead")}/config`]: () =>
        json(savedConfig({ ...overlay, template: { model: "opus" } })),
    },
  });
  await pickOption(field("Model"), "opus");
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(puts(api).map((c) => c.body)).toEqual([
    { overlay: { settings: { env: { A: "1" } }, template: { model: "opus" } }, baseVersion: "v1" },
  ]);
  expect(patches(api)).toEqual([]);
});

test("a running agent's model change says it restarts when idle", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    extra: configRoutes(),
  });
  await pickOption(field("Model"), "opus");
  expect(await screen.findByText(SELF)).toBeInTheDocument();
});

test("when the config write fails after the agent saved, the outcome says which part was saved and a retry sends only the config", async () => {
  let reject = true;
  const { api } = await open({
    extra: {
      ...configRoutes(),
      [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ displayName: "Boss" })),
      [`PUT /api/agents/${refFor("lead")}/config`]: () =>
        reject
          ? json(
              { error: { code: "invalid_config", message: "The configuration has errors." } },
              400,
            )
          : json(savedConfig({ template: { model: "opus" } })),
    },
  });
  await rename("Boss");
  await pickOption(field("Model"), "opus");
  await userEvent.click(saveButton());
  expect(
    await screen.findByText(
      "Saved your changes, but not Model and Effort: The configuration has errors.",
    ),
  ).toBeInTheDocument();
  // The sheet stays, with the model still chosen.
  expect(getSheetState().parent).toBeDefined();
  expect(field("Model")).toHaveTextContent("opus");
  expect(patches(api)).toEqual([{ displayName: "Boss" }]);
  reject = false;
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toHaveLength(1);
  expect(puts(api)).toHaveLength(2);
});

test("a config write that fails with nothing else saved says Model and Effort weren't saved", async () => {
  await open({
    extra: {
      ...configRoutes(),
      [`PUT /api/agents/${refFor("lead")}/config`]: () =>
        json({ error: { code: "invalid_config", message: "The configuration has errors." } }, 400),
    },
  });
  await pickOption(field("Model"), "opus");
  await userEvent.click(saveButton());
  expect(
    await screen.findByText("Model and Effort weren't saved: The configuration has errors."),
  ).toBeInTheDocument();
  expect(getSheetState().parent).toBeDefined();
});

test("on its own session, a display-name-only save toasts nothing", async () => {
  await open(
    {
      extra: {
        ...sessionRoutes,
        [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ displayName: "Boss" })),
      },
    },
    { path: `/agents/${refFor("lead")}` },
  );
  expect(getSheetState().parent?.at).toBe(`/agents/${refFor("lead")}/chat`);
  await rename("Boss");
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(notify).not.toHaveBeenCalled();
});

test("on its own session, any other field toasts Saved @handle.", async () => {
  await open(
    {
      extra: {
        ...sessionRoutes,
        [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ description: "New" })),
      },
    },
    { path: `/agents/${refFor("lead")}` },
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
        [`PATCH /api/agents/${refFor("lead")}`]: saved(
          lead({ displayName: "Boss", restartPending: true }),
        ),
      },
    },
    { path: `/agents/${refFor("lead")}` },
  );
  await rename("Boss");
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead. Restarts when idle.");
});

test("a running agent's save says it restarts", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    extra: {
      [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ status: "idle", displayName: "Boss" })),
    },
  });
  await rename("Boss");
  expect(screen.getByText(SELF)).toBeInTheDocument();
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead. Restarts when idle.");
});

test("Enter twice while saving sends one PATCH", async () => {
  const patch = held();
  const { api } = await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
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
      [`PATCH /api/agents/${refFor("lead")}`]: () =>
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
  const msg = await within(group).findByText("Project docs isn't registered.");
  expect(msg.closest(".field-note")).not.toBeNull();
  expect(group).toHaveAttribute("aria-invalid", "true");
  await vi.waitFor(() =>
    expect(within(group).getByRole("checkbox", { name: /app/ })).toHaveFocus(),
  );
  expect(getSheetState().parent?.kind).toBe("edit-agent");
});

test("a toggle sends the project array", async () => {
  const agent = lead({ projects: ["app", "docs"] });
  const { api } = await open({
    agents: [agent],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead()) },
  });
  const group = screen.getByRole("group", { name: /Projects/ });
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  await userEvent.click(saveButton());
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patches(api)).toEqual([{ projects: ["app"] }]);
});

// --- Dismissed while saving (break-ui M2) ---

test("a late success toasts Saved @handle. and clears the draft when nothing reopened", async () => {
  const patch = held();
  await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead.");
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(false);
});

test("a late success keeps the draft of the same agent reopened and typed into meanwhile", async () => {
  const patch = held();
  await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "edit-agent", agentRef: refFor("lead") }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name")).toBeEnabled());
  await rename("Second");
  act(() => closeSheet());
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(true);
});

test("a late success over the same agent's Edit reopened on the sent values clears the draft and closes it", async () => {
  const patch = held();
  const { api } = await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "edit-agent", agentRef: refFor("lead") }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name")).toHaveValue("Boss"));
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "Saved @lead." }));
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(false);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull());
  expect(patches(api)).toHaveLength(1);
});

test("a save landing after a sign-out neither toasts nor touches a draft", async () => {
  const patch = held();
  await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => resetDrafts());
  // The next user types the same value: the late success must not take it for the sent draft.
  act(() => openSheet({ kind: "edit-agent", agentRef: refFor("lead") }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name")).toBeEnabled());
  await rename("Boss");
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(true);
  expect(screen.getByRole("dialog", { name: "Edit agent" })).toBeInTheDocument();
});

test("a failed save landing after a sign-out doesn't toast", async () => {
  const patch = held();
  await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
  await rename("Kept");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => resetDrafts());
  await act(async () =>
    patch.answer(json({ error: { code: "boom", message: "The server fell over." } }, 500)),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
});

test("a late success still clears its draft when only another agent's Edit opened meanwhile", async () => {
  const patch = held();
  await open({
    agents: [lead(), agentSummary({ handle: "other", displayName: "Other" })],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route },
  });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "edit-agent", agentRef: refFor("other") }));
  await sheet();
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(false);
});

test("a late failure toasts the error with Open form, which reopens the kept draft", async () => {
  const patch = held();
  await open({ extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route } });
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
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(true);
  act(() => toast?.action?.run());
  await sheet();
  expect(await screen.findByLabelText("Display name")).toHaveValue("Kept");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
});

test("archived elsewhere while saving: success keeps the archived state open and toasts", async () => {
  const patch = held();
  const agent = lead();
  const { dialog, queryClient } = await open({
    agents: [agent],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route },
  });
  await rename("Boss");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  agent.archivedAt = "2026-11-20T10:00:00.000Z";
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", refFor("lead")] }));
  await within(dialog).findByText("This agent is archived.");
  await act(async () => patch.answer(json({ agent: lead({ displayName: "Boss" }) })));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead.");
  expect(getSheetState().parent?.kind).toBe("edit-agent");
});

test("archived elsewhere while saving: a failure toasts with Open form", async () => {
  const patch = held();
  const agent = lead();
  const { dialog, queryClient } = await open({
    agents: [agent],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: patch.route },
  });
  await rename("Kept");
  await userEvent.click(saveButton());
  await screen.findByRole("button", { name: /Saving…/ });
  agent.archivedAt = "2026-11-20T10:00:00.000Z";
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", refFor("lead")] }));
  await within(dialog).findByText("This agent is archived.");
  await act(async () =>
    patch.answer(json({ error: { code: "agent_archived", message: "@lead is archived." } }, 409)),
  );
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  const toast = vi.mocked(notify).mock.calls[0]?.[0];
  expect(toast?.text).toBe("Couldn't save @lead: @lead is archived.");
  expect(toast?.action?.label).toBe("Open form");
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(true);
});

// --- States ---

test("an archived agent says so with a Restore button and no form; Restore brings the form back", async () => {
  const archived = lead({ archivedAt: "2026-11-20T10:00:00.000Z" });
  const { api, dialog } = await open(
    {
      agents: [],
      archived: [archived],
      extra: {
        [`POST /api/agents/${refFor("lead")}/unarchive`]: () => {
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
  expect(api.calls.filter((c) => c.url === `/api/agents/${refFor("lead")}/unarchive`)).toHaveLength(
    1,
  );
  expect(notify).not.toHaveBeenCalled();
});

test("a refused Restore says why inline", async () => {
  const { dialog } = await open(
    {
      agents: [],
      archived: [lead({ archivedAt: "2026-11-20T10:00:00.000Z" })],
      extra: {
        [`POST /api/agents/${refFor("lead")}/unarchive`]: () =>
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

test("an unknown ref: No agent at this link.", async () => {
  const { dialog } = await open(
    {
      extra: {
        [`GET /api/agents/${refFor("x")}`]: () =>
          json({ error: { code: "agent_not_found", message: "No agent x." } }, 404),
      },
    },
    { handle: "x", form: false },
  );
  expect(await within(dialog).findByText("No agent at this link.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
});

test("archived by another tab while open: the sheet flips and keeps the draft", async () => {
  const agent = lead();
  const { dialog, queryClient } = await open({ agents: [agent] });
  await rename("Half typed");
  agent.archivedAt = "2026-11-20T10:00:00.000Z";
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", refFor("lead")] }));
  expect(await within(dialog).findByText("This agent is archived.")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Display name")).not.toBeInTheDocument();
  expect(hasDraft(`edit-agent:${refFor("lead")}`)).toBe(true);
  agent.archivedAt = null;
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", refFor("lead")] }));
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
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", refFor("lead")] }));
  await within(dialog).findByLabelText("Display name");
  expect(x).toHaveFocus();
});

test("deleted by another tab while open: the sheet flips to not found", async () => {
  const { dialog, queryClient } = await open();
  mockWorld({
    agents: [],
    extra: {
      [`GET /api/agents/${refFor("lead")}`]: () =>
        json({ error: { code: "agent_not_found", message: "No agent lead." } }, 404),
    },
  });
  await act(() => queryClient.invalidateQueries({ queryKey: ["agent", refFor("lead")] }));
  expect(await within(dialog).findByText("No agent at this link.")).toBeInTheDocument();
});

test("focus on open goes to Display name", async () => {
  await open();
  await waitFor(() => expect(field("Display name")).toHaveFocus());
});

test("Add credential expands inline under Credential and nothing stacks", async () => {
  const { dialog } = await open();
  const add = within(dialog).getByRole("button", { name: "Add credential" });
  expect(add).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(add);
  const g = await screen.findByRole("group", { name: "Add credential" });
  expect(add).toHaveAttribute("aria-expanded", "true");
  expect(g.tagName).not.toBe("FORM");
  expect(getSheetState().child).toBeUndefined();
});

test("leaving an unchosen Credential for its own Add credential button doesn't flag it", async () => {
  const { dialog } = await open({
    agents: [lead({ credential: null })],
    credentials: [credential("work"), credential("prod")],
  });
  const trigger = field("Credential");
  expect(trigger).toHaveTextContent("Choose a credential");
  act(() => trigger.focus());
  await userEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
  await screen.findByRole("group", { name: "Add credential" });
  expect(trigger).not.toHaveAttribute("aria-invalid");
});

test("a pasted token added inline is selected, focused and noted, and Save sends it", async () => {
  const credentials = [credential("work")];
  const { dialog, api } = await open({
    credentials,
    extra: {
      "POST /api/credentials": (body: unknown) => {
        const c = credential((body as { name: string }).name);
        credentials.push(c);
        return json({ credential: c }, 201);
      },
      [`PATCH /api/agents/${refFor("lead")}`]: () => json({ agent: lead({ credential: "prod" }) }),
    },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
  const g = await screen.findByRole("group", { name: "Add credential" });
  await userEvent.click(within(g).getByRole("radio", { name: "Paste a token" }));
  await userEvent.type(within(g).getByLabelText("Name"), "prod");
  await userEvent.type(within(g).getByLabelText("Token"), "sk-ant-oat-1");
  await userEvent.click(within(g).getByRole("button", { name: "Verify and add" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Add credential" })).toBeNull());
  expect(field("Credential")).toHaveTextContent("prod");
  await waitFor(() => expect(field("Credential")).toHaveFocus());
  expect(within(dialog).getByText("Added prod.")).toBeInTheDocument();
  await userEvent.click(saveButton());
  await waitFor(() => expect(patches(api)).toHaveLength(1));
  expect(patches(api)[0]).toMatchObject({ credential: "prod" });
});

test("Save while Add credential is open and dirty focuses it instead of saving", async () => {
  const { dialog, api } = await open();
  await userEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
  const g = await screen.findByRole("group", { name: "Add credential" });
  await userEvent.type(within(g).getByLabelText("Name"), "prod");
  await rename("Boss");
  await userEvent.click(saveButton());
  expect(patches(api)).toHaveLength(0);
  expect(await within(g).findByText("Add the credential or cancel it first.")).toBeInTheDocument();
  expect(g).toHaveFocus();
});

test("Add project expands inline and the new project joins the grants", async () => {
  const projects = [project("app")];
  const { dialog } = await open({
    projects,
    extra: {
      "POST /api/projects": () => {
        projects.push(project("web"));
        return json({ project: project("web") }, 201);
      },
    },
  });
  const group = within(dialog).getByRole("group", { name: /Projects/ });
  const add = within(group).getByRole("button", { name: "Add project" });
  await userEvent.click(add);
  const g = await screen.findByRole("group", { name: "Add project" });
  await userEvent.type(within(g).getByLabelText("Name"), "web");
  await userEvent.type(within(g).getByLabelText("Path"), "/src/web");
  await userEvent.click(within(g).getByRole("button", { name: "Add project" }));
  const web = await within(group).findByRole("checkbox", { name: /web/ });
  expect(web).toBeChecked();
  await waitFor(() => expect(web).toHaveFocus());
});

// --- Entry points ---

// --- Colour (I2 §12.6) ---

const radio = (name: string) => screen.getByRole("radio", { name });

test("Colour sits after Display name, names Auto's seeded hue, and sends color alone without a restart", async () => {
  const api = await open({
    agents: [lead({ status: "idle" })],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ status: "idle", color: 4 })) },
  });
  const group = screen.getByRole("radiogroup", { name: /^Colour/ });
  expect(screen.getByText(/^Colour · Auto \(\w+\)$/)).toBeInTheDocument();
  expect(field("Display name").compareDocumentPosition(group)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  await userEvent.click(radio("Teal"));
  expect(screen.getByText("Colour · Teal")).toBeInTheDocument();
  expect(screen.queryByText(SELF)).not.toBeInTheDocument();
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(vi.mocked(notify).mock.calls[0]?.[0].text).toBe("Saved @lead.");
  expect(patches(api.api)).toEqual([{ color: 4 }]);
});

test("a saved colour invalidates the inbox list so chat rows recolour", async () => {
  const { queryClient } = await open({
    agents: [lead({ status: "idle" })],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ status: "idle", color: 4 })) },
  });
  // A cached inbox list (inactive here, as when the sheet is over /agents): the save must mark it stale.
  const inboxKey = ["inbox", "list"];
  queryClient.setQueryData(inboxKey, { chats: [], items: [], nextCursor: null });
  expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(false);
  await userEvent.click(radio("Teal"));
  await userEvent.click(saveButton());
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(true);
});

test("arrow keys move and select, Home and End jump, roving tabindex follows", async () => {
  await open();
  await userEvent.click(radio("Auto"));
  await userEvent.keyboard("{ArrowRight}");
  expect(radio("Olive")).toHaveAttribute("aria-checked", "true");
  expect(radio("Olive")).toHaveFocus();
  expect(radio("Olive")).toHaveAttribute("tabindex", "0");
  expect(radio("Auto")).toHaveAttribute("tabindex", "-1");
  await userEvent.keyboard("{End}");
  expect(radio("Ruby")).toHaveAttribute("aria-checked", "true");
  expect(screen.getByText("Colour · Ruby")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  expect(radio("Auto")).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{ArrowLeft}{Home}");
  expect(radio("Auto")).toHaveAttribute("aria-checked", "true");
  expect(radio("Auto")).toHaveFocus();
});

test("an agent whose template has an avatar.svg gets the line, not the group", async () => {
  await open({ agents: [lead({ avatarVersion: "v1" })] });
  expect(screen.getByText("This template's avatar.svg sets the avatar.")).toBeInTheDocument();
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
});

test("a running agent's colour with another field still restarts", async () => {
  await open({
    agents: [lead({ status: "idle" })],
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ status: "idle", color: 2 })) },
  });
  await userEvent.click(radio("Moss"));
  await rename("Boss");
  expect(screen.getByText(SELF)).toBeInTheDocument();
});

test("Can manage the org: a switch described by the spec's help, and its change is sent", async () => {
  const { api } = await open({
    extra: { [`PATCH /api/agents/${refFor("lead")}`]: saved(lead({ manageOrg: true })) },
  });
  const sw = screen.getByRole("switch", { name: "Can manage the org" });
  expect(sw).not.toBeChecked();
  expect(sw).toHaveAccessibleDescription(MANAGE_ORG_HELP);
  await userEvent.click(sw);
  await userEvent.click(saveButton());
  await waitFor(() => expect(patches(api)).toEqual([{ manageOrg: true }]));
});

test("Can manage the org: on a running agent the change shows the restart notice", async () => {
  await open({ agents: [lead({ status: "idle" })] });
  await userEvent.click(screen.getByRole("switch", { name: "Can manage the org" }));
  expect(await screen.findByText(SELF)).toBeInTheDocument();
});
