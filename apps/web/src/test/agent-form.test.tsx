import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  agentSummary,
  credential,
  mockWorld,
  templateConfig,
  templateDetail,
  templateSummary,
} from "@/test/agent-screens-fixtures";
import { json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const ready = async () => {
  await screen.findByRole("button", { name: "Create agent" });
  // The template detail fills the fields once it loads.
  await vi.waitFor(() => expect(field("Display name").value).not.toBe(""));
};

test("the prerequisites replace the form when there's no credential", async () => {
  mockWorld({ credentials: [] });
  renderApp("/agents/new", alice);
  const line = await screen.findByText(
    (_c, el) =>
      el?.tagName === "P" && el.textContent === "Add a Claude credential in Settings first.",
  );
  expect(within(line).getByRole("link")).toHaveAttribute("href", "/settings#credentials");
  expect(screen.queryByRole("button", { name: "Create agent" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
});

test("?template=lead preselects it and fills the fields and grants from it", async () => {
  mockWorld({ templates: [templateSummary("lead"), templateSummary("broken", 2)] });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const select = field("Template") as unknown as HTMLSelectElement;
  expect(select.value).toBe("lead");
  expect(within(select).getByRole("option", { name: "broken (has errors)" })).toBeDisabled();
  expect(field("Display name").value).toBe("Team Lead");
  expect(field("Description").value).toBe("Leads the team");
  expect(screen.getByRole("checkbox", { name: /app/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /docs/ })).not.toBeChecked();
});

test("the slug is prefilled from the template name only when it's free", async () => {
  mockWorld();
  const first = renderApp("/agents/new?template=lead", alice);
  await ready();
  expect(field("Slug").value).toBe("lead");
  first.unmount();
  vi.unstubAllGlobals();

  mockWorld({ agents: [agentSummary({ slug: "lead" })] });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  expect(field("Slug").value).toBe("");
});

test("a docker template shows the summary and no runtime warning", async () => {
  mockWorld({
    details: {
      lead: templateDetail(
        templateConfig({
          runtime: "docker",
          model: "opus",
          skills: ["grilling"],
          plugins: ["a@b"],
        }),
      ),
    },
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  expect(screen.queryByText(/can't start yet/)).not.toBeInTheDocument();
  expect(
    screen.getByText("Docker · model opus · skills: grilling · plugins: 1"),
  ).toBeInTheDocument();
});

test("a local template with the gate off shows the validator's warning", async () => {
  mockWorld({
    details: {
      lead: templateDetail(templateConfig({ runtime: "local" }), [
        {
          severity: "warning",
          file: "template.yaml",
          message: "The local runtime is disabled on this factory.",
          path: "runtime",
        },
      ]),
    },
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  expect(
    await screen.findByText("The local runtime is disabled on this factory."),
  ).toBeInTheDocument();
});

test("a secret that isn't set warns and links to the prefilled add form", async () => {
  mockWorld({
    details: { lead: templateDetail(templateConfig({ secrets: ["GH_TOKEN"] })) },
    secrets: [],
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  expect(
    screen.getByText(
      (_c, el) =>
        el?.tagName === "SPAN" && /^Secret GH_TOKEN isn't set\./.test(el.textContent ?? ""),
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /add it/ })).toHaveAttribute(
    "href",
    "/settings?addSecret=GH_TOKEN#secrets",
  );
});

test("slug validates on blur, never while typing", async () => {
  mockWorld();
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const slug = field("Slug");
  await userEvent.clear(slug);
  await userEvent.type(slug, "Bad_Slug");
  expect(
    screen.queryByText(/lowercase letters, numbers and inner hyphens/),
  ).not.toBeInTheDocument();
  await userEvent.tab();
  expect(await screen.findByText(/Use 3–40 lowercase letters/)).toBeInTheDocument();
  expect(slug).toHaveAttribute("aria-invalid", "true");
  await userEvent.type(slug, "x");
  expect(screen.queryByText(/Use 3–40 lowercase letters/)).not.toBeInTheDocument();
});

test("a 400 with fields.slug puts the error under Slug and focuses it", async () => {
  const api = mockWorld({
    extra: {
      "POST /api/agents": () =>
        json(
          {
            error: {
              code: "slug_taken",
              message: "That slug is taken.",
              fields: { slug: "That slug is taken." },
            },
          },
          409,
        ),
    },
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByText("That slug is taken.")).toBeInTheDocument();
  expect(field("Slug")).toHaveFocus();
  const post = api.calls.find((c) => c.method === "POST");
  // Untouched grants are left to the template.
  expect(post?.body).toEqual({
    template: "lead",
    slug: "lead",
    displayName: "Team Lead",
    description: "Leads the team",
    reportsTo: null,
    credential: "work",
  });
});

test("Edit: the manager select leaves out the agent and its descendants, indented", async () => {
  const agents = [
    agentSummary({ slug: "cto", displayName: "CTO" }),
    agentSummary({ slug: "lead", displayName: "Lead", reportsTo: "cto", depth: 1 }),
    agentSummary({ slug: "dev-1", displayName: "Dev", reportsTo: "lead", depth: 2 }),
    agentSummary({ slug: "other", displayName: "Other", reportsTo: "cto", depth: 1 }),
  ];
  mockWorld({ agents });
  renderApp("/agents/lead/edit", alice);
  const select = (await screen.findByLabelText("Manager")) as HTMLSelectElement;
  await vi.waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  expect([...select.options].map((o) => o.textContent)).toEqual([
    "No manager (reports to the humans)",
    "CTO (@cto)",
    "    Other (@other)",
  ]);
  expect(select.value).toBe("cto");
  // Template and slug are read-only on Edit.
  expect(screen.queryByLabelText("Template")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
});

test("projects: From the template, then Custom with Use template default", async () => {
  mockWorld();
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const group = screen.getByRole("group", { name: /Projects/ });
  expect(within(group).getByText("From the template")).toBeInTheDocument();
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  expect(within(group).getByText("Custom")).toBeInTheDocument();
  await userEvent.click(within(group).getByRole("button", { name: "Use template default" }));
  expect(within(group).getByText("From the template")).toBeInTheDocument();
  expect(within(group).getByRole("checkbox", { name: /docs/ })).not.toBeChecked();
  expect(within(group).getByRole("checkbox", { name: /app/ })).toBeChecked();
});

test("no projects registered says where to add one", async () => {
  mockWorld({ projects: [], details: { lead: templateDetail(templateConfig({ projects: [] })) } });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const line = screen.getByText(
    (_c, el) => el?.tagName === "P" && el.textContent === "No projects yet. Add one in Settings.",
  );
  expect(within(line).getByRole("link")).toHaveAttribute("href", "/settings#projects");
});

test("while creating the fields are disabled; Installing plugins… appears after 3 s", async () => {
  mockWorld({
    details: { lead: templateDetail(templateConfig({ plugins: ["superpowers@market"] })) },
    extra: { "POST /api/agents": () => new Promise<Response>(() => {}) },
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByRole("button", { name: /Creating…/ })).toBeInTheDocument();
  expect(field("Display name")).toBeDisabled();
  expect(screen.queryByText("Installing plugins…")).not.toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.getByText("Installing plugins…")).toBeInTheDocument();
});

test("a 502 shows the form error with a collapsed Show output", async () => {
  mockWorld({
    extra: {
      "POST /api/agents": () =>
        json(
          {
            error: {
              code: "plugin_install_failed",
              message: "Plugin install failed: superpowers@market.",
              output: "npm ERR! nope",
            },
          },
          502,
        ),
    },
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  const alert = await screen.findByText("Plugin install failed: superpowers@market.");
  expect(alert.closest("[role=alert]")).not.toBeNull();
  const summary = screen.getByText("Show output");
  const details = summary.closest("details");
  expect(details).not.toHaveAttribute("open");
  expect(within(details as HTMLElement).getByText("npm ERR! nope")).toBeInTheDocument();
});

test("success navigates to the new agent's session view", async () => {
  mockWorld({
    extra: {
      "POST /api/agents": () => json({ agent: agentSummary({ slug: "lead" }) }, 201),
      "GET /api/agents/lead": () =>
        json({ agent: agentSummary({ slug: "lead" }), queue: [], lastSeq: 0 }),
      "GET /api/agents/lead/events?": () =>
        json({ events: [], hasMore: { before: false, after: false } }),
    },
  });
  const { router } = renderApp("/agents/new?template=lead", alice);
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/lead"));
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

test("the credential select lists names with their kind", async () => {
  mockWorld({ credentials: [credential("work"), credential("personal", "api_key")] });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const select = field("Credential") as unknown as HTMLSelectElement;
  expect([...select.options].map((o) => o.textContent)).toEqual([
    "work: OAuth token",
    "personal: API key",
  ]);
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

test("a server projects error shows under Projects and focuses the group (create)", async () => {
  mockWorld({ extra: { "POST /api/agents": projectsError } });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  const msg = await screen.findByText("Project docs isn't registered.");
  const group = screen.getByRole("group", { name: /Projects/ });
  expect(group).toContainElement(msg);
  expect(group.getAttribute("aria-describedby")).toContain(msg.closest("[id]")?.id);
  expect(group).toHaveAttribute("aria-invalid", "true");
  await vi.waitFor(() =>
    expect(within(group).getByRole("checkbox", { name: /app/ })).toHaveFocus(),
  );
});

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
      "PATCH /api/agents/lead": (body) =>
        json({
          agent: {
            ...lead,
            grantsOverridden: (body as { projects: unknown }).projects !== null,
          },
        }),
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

test("toggling the grants back to the template's set is not Custom", async () => {
  const api = mockWorld({
    extra: { "POST /api/agents": () => new Promise<Response>(() => {}) },
  });
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const group = screen.getByRole("group", { name: /Projects/ });
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  expect(within(group).getByText("Custom")).toBeInTheDocument();
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  expect(within(group).getByText("From the template")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await vi.waitFor(() => expect(api.calls.some((c) => c.method === "POST")).toBe(true));
  expect(api.calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("projects");
});

test("an unknown ?template= counts as unchosen", async () => {
  const api = mockWorld();
  renderApp("/agents/new?template=nope", alice);
  await screen.findByRole("button", { name: "Create agent" });
  await vi.waitFor(() =>
    expect((field("Template") as unknown as HTMLSelectElement).disabled).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByText("Choose a template.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
});

test("a local template's summary says Unsandboxed", async () => {
  mockWorld();
  renderApp("/agents/new?template=lead", alice);
  await ready();
  expect(screen.getByText("Unsandboxed")).toBeInTheDocument();
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

test("display name over the shared limit errors on blur", async () => {
  mockWorld();
  renderApp("/agents/new?template=lead", alice);
  await ready();
  const name = field("Display name");
  await userEvent.clear(name);
  await userEvent.type(name, "x".repeat(81));
  await userEvent.tab();
  expect(await screen.findByText(/80 characters or fewer/)).toBeInTheDocument();
});

test("the template prefill never overwrites a field the user is in or has typed into", async () => {
  let land: (r: Response) => void = () => {};
  mockWorld({
    extra: {
      "GET /api/templates/lead": () =>
        new Promise<Response>((resolve) => {
          land = resolve;
        }),
    },
  });
  renderApp("/agents/new", alice);
  await screen.findByRole("option", { name: "lead" });
  await userEvent.selectOptions(field("Template") as unknown as HTMLSelectElement, "lead");
  // Straight into Slug and Description while the template detail is still in flight.
  await userEvent.type(field("Description"), "Mine");
  await userEvent.click(field("Slug"));
  await act(async () => land(json(templateDetail(templateConfig()))));
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
  await userEvent.type(field("Slug"), "lead-one");
  expect(field("Slug").value).toBe("lead-one");
  expect(field("Description").value).toBe("Mine");
});
