import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft, hasDraft } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import {
  agentSummary,
  credential,
  mockWorld,
  templateConfig,
  templateDetail,
  templateSummary,
  type World,
} from "@/test/agent-screens-fixtures";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { comboOptionNames, optionNames, pickOption } from "@/test/select-helpers";

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
  clearDraft("new-agent");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const sheet = () => screen.findByRole("dialog", { name: "New agent" });
const createButton = () => screen.getByRole("button", { name: /^(Create agent|Creating…)$/ });
const more = () => screen.getByRole("button", { name: "More options" });
/** Renders /agents and opens New agent over it, once its body has rendered. */
async function open(world: World = {}, spec: { template?: string } = {}) {
  const api = mockWorld(world);
  const utils = renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  act(() => openSheet({ kind: "new-agent", ...spec }));
  const d = await sheet();
  await within(d).findByRole("button", { name: "Create agent" });
  return { ...utils, api, dialog: d };
}
/** Opened with ?template=lead's prefill, once the template detail has filled the fields. */
async function openLead(world: World = {}) {
  const r = await open(world, { template: "lead" });
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
  return r;
}
const posts = (api: { calls: { method: string; url: string; body: unknown }[] }) =>
  api.calls.filter((c) => c.method === "POST" && c.url === "/api/agents");
const created = (slug = "team-lead") => ({
  "POST /api/agents": () => json({ agent: agentSummary({ slug }) }, 201),
  [`GET /api/agents/${slug}`]: () => json({ agent: agentSummary({ slug }), queue: [], lastSeq: 0 }),
  [`GET /api/agents/${slug}/events?`]: () =>
    json({ events: [], hasMore: { before: false, after: false } }),
});
/** A POST that waits for the test to answer it. */
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

// --- The body ---

test("opens with no credentials and no templates: no gate page, the setup is in the sheet", async () => {
  const { dialog } = await open({ credentials: [], templates: [] });
  expect(within(dialog).getByText("No templates yet.")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "New template" })).toHaveAttribute(
    "type",
    "button",
  );
  expect(field("Display name")).toBeInTheDocument();
  expect(more()).toHaveAttribute("aria-expanded", "true");
  expect(within(dialog).getByText("No Claude credential yet.")).toBeInTheDocument();
});

test("one credential is preselected and More options stays closed", async () => {
  const { dialog } = await openLead();
  expect(more()).toHaveAttribute("aria-expanded", "false");
  expect(within(dialog).queryByLabelText("Credential")).not.toBeInTheDocument();
  await userEvent.click(more());
  expect(field("Credential")).toHaveTextContent("work");
});

test("several credentials and the restored draft's one is gone: Choose a credential.", async () => {
  mockWorld({ credentials: [credential("work"), credential("prod")] });
  const first = renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  await userEvent.click(await screen.findByRole("button", { name: "More options" }));
  await pickOption(field("Credential"), /^prod/);
  act(() => closeSheet());
  first.unmount();
  const { dialog } = await open({ credentials: [credential("work"), credential("other")] });
  expect(more()).toHaveAttribute("aria-expanded", "true");
  expect(within(dialog).getByText("Choose a credential.")).toBeInTheDocument();
  expect(within(dialog).getByText("Credential prod was deleted.")).toBeInTheDocument();
});

test("a template secret that isn't set opens More options and says so", async () => {
  const { dialog } = await open(
    { details: { lead: templateDetail(templateConfig({ secrets: ["GH_TOKEN"] })) }, secrets: [] },
    { template: "lead" },
  );
  await vi.waitFor(() =>
    expect(
      within(dialog).getByText(
        (_c, el) => el?.tagName === "SPAN" && el.textContent === "Secret GH_TOKEN isn't set.",
      ),
    ).toBeInTheDocument(),
  );
  expect(more()).toHaveAttribute("aria-expanded", "true");
});

test("several missing secrets are counted", async () => {
  const { dialog } = await open(
    {
      details: { lead: templateDetail(templateConfig({ secrets: ["A_KEY", "B_KEY", "C_KEY"] })) },
      secrets: [],
    },
    { template: "lead" },
  );
  expect(await within(dialog).findByText("3 secrets aren't set.")).toBeInTheDocument();
});

test("picking a template prefills Display name and Description until touched", async () => {
  await open({
    templates: [templateSummary("lead"), templateSummary("writer")],
    details: {
      lead: templateDetail(templateConfig()),
      writer: templateDetail(
        templateConfig({ name: "writer", displayName: "Writer", description: "Writes docs" }),
      ),
    },
  });
  await pickOption(field("Template"), /^lead/);
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
  await userEvent.click(more());
  expect(field("Description").value).toBe("Leads the team");
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Mine");
  await pickOption(field("Template"), /^writer/);
  await vi.waitFor(() => expect(field("Description").value).toBe("Writes docs"));
  expect(field("Display name").value).toBe("Mine");
});

test("template items show the display name, the description outside it, and broken ones disabled", async () => {
  await open({
    templates: [
      { ...templateSummary("lead"), displayName: "Team Lead", description: "Leads the team" },
      templateSummary("broken", 2),
    ],
  });
  await userEvent.click(field("Template"));
  const lead = await screen.findByRole("option", { name: /Team Lead/ });
  expect(lead).toHaveTextContent("Leads the team");
  expect(screen.getByRole("option", { name: "broken (has errors)" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await userEvent.click(lead);
  // The closed trigger shows only the item text.
  expect(field("Template")).toHaveTextContent("Team Lead");
  expect(field("Template")).not.toHaveTextContent("Leads the team");
});

test.each([
  [[templateSummary("solo", 1)], "/templates/solo"],
  [[templateSummary("one", 1), templateSummary("two", 3)], "/templates"],
])("all templates broken: a link to fix them (%#)", async (templates, href) => {
  const { dialog } = await open({ templates });
  const line = within(dialog).getByText(/^No template is ready: fix the errors in/);
  expect(within(line).getByRole("link")).toHaveAttribute("href", href);
  expect(within(dialog).getByRole("button", { name: "New template" })).toBeInTheDocument();
});

test("the template summary shows the template's description in full", async () => {
  const long = `${"A very long description ".repeat(8)}end.`;
  const { dialog } = await open(
    { details: { lead: templateDetail(templateConfig({ description: long })) } },
    { template: "lead" },
  );
  expect(await within(dialog).findByText(long)).toBeInTheDocument();
});

test("the address follows the display name; a taken one gets a suffix", async () => {
  const { dialog } = await openLead({ agents: [agentSummary({ slug: "team-lead" })] });
  await vi.waitFor(() => expect(within(dialog).getByText("@team-lead-2")).toBeInTheDocument());
});

test("submit with an empty derived slug opens the address input, focused, with its error", async () => {
  const { api } = await openLead();
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "李");
  fireEvent.submit(createButton().closest("form") as HTMLFormElement);
  await vi.waitFor(() => expect(field("Slug")).toHaveFocus());
  expect(screen.getByText("Enter a slug.")).toBeInTheDocument();
  expect(posts(api)).toHaveLength(0);
});

test("leaving Display name with a name that derives nothing opens the address input", async () => {
  await openLead();
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "!!!");
  await userEvent.tab();
  await vi.waitFor(() => expect(field("Slug")).toHaveFocus());
});

test("a server fields.slug error opens the address input with the error", async () => {
  await openLead({
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
  await userEvent.click(createButton());
  expect(await screen.findByText("That slug is taken.")).toBeInTheDocument();
  await vi.waitFor(() => expect(field("Slug")).toHaveFocus());
  expect(field("Slug").value).toBe("team-lead");
});

test("success closes the sheet, clears the draft and navigates to the session", async () => {
  const { api, router } = await openLead({ extra: created() });
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead"));
  expect(getSheetState().parent).toBeUndefined();
  expect(hasDraft("new-agent")).toBe(false);
  expect(notify).not.toHaveBeenCalled();
  expect(posts(api)[0]?.body).toEqual({
    template: "lead",
    slug: "team-lead",
    displayName: "Team Lead",
    description: "Leads the team",
    reportsTo: null,
    credential: "work",
  });
});

test("submit waits for the taken names before deriving the slug", async () => {
  const users = held();
  const { api } = await openLead({
    agents: [],
    extra: { "GET /api/users": users.route, "POST /api/agents": () => new Promise(() => {}) },
  });
  await userEvent.click(createButton());
  expect(posts(api)).toHaveLength(0);
  await act(async () =>
    users.answer(
      json({
        users: [
          {
            id: "u2",
            name: "Lead",
            handle: "team-lead",
            email: "l@x.y",
            createdAt: "2026-01-01",
            disabledAt: null,
          },
        ],
      }),
    ),
  );
  await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
  expect(posts(api)[0]?.body).toMatchObject({ slug: "team-lead-2" });
});

test("Enter while pending submits once", async () => {
  const { api } = await openLead({ extra: { "POST /api/agents": () => new Promise(() => {}) } });
  const name = field("Display name");
  await userEvent.type(name, "{Enter}");
  await screen.findByRole("button", { name: /Creating…/ });
  fireEvent.submit(createButton().closest("form") as HTMLFormElement);
  await userEvent.click(createButton());
  expect(posts(api)).toHaveLength(1);
});

test("a draft whose manager has ended clears it with the reason", async () => {
  const boss = agentSummary({ slug: "boss", displayName: "Boss" });
  mockWorld({ agents: [boss] });
  const first = renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  const manager = await screen.findByLabelText("Manager");
  await vi.waitFor(() => expect(manager).toBeEnabled());
  await userEvent.click(manager);
  await userEvent.click(await screen.findByRole("option", { name: /Boss/ }));
  act(() => closeSheet());
  first.unmount();
  const { dialog } = await open({ agents: [] });
  expect(await within(dialog).findByText("@boss has ended; pick another.")).toBeInTheDocument();
  expect(field("Manager")).toHaveTextContent("No manager");
});

test("focus on open: Template when none is chosen, Display name when one is", async () => {
  await open();
  await vi.waitFor(() => expect(field("Template")).toHaveFocus());
  act(() => closeSheet());
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name")).toHaveFocus());
});

test("on a phone, focus goes to the drawer content", async () => {
  fakeMatchMedia.install(true);
  const { dialog } = await open();
  await vi.waitFor(() => expect(dialog).toHaveFocus());
});

test("while creating, Installing plugins… appears beside the button after 3 s", async () => {
  await openLead({
    details: { lead: templateDetail(templateConfig({ plugins: ["superpowers@market"] })) },
    extra: { "POST /api/agents": () => new Promise<Response>(() => {}) },
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(createButton());
  expect(await screen.findByRole("button", { name: /Creating…/ })).toBeInTheDocument();
  expect(field("Display name")).toBeDisabled();
  expect(screen.queryByText("Installing plugins…")).not.toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.getByText("Installing plugins…")).toBeInTheDocument();
});

test("a 502 shows the form error with a collapsed Show output", async () => {
  await openLead({
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
  await userEvent.click(createButton());
  const alert = await screen.findByText("Plugin install failed: superpowers@market.");
  expect(alert.closest("[role=alert]")).not.toBeNull();
  const details = screen.getByText("Show output").closest("details");
  expect(details).not.toHaveAttribute("open");
});

test("a server projects error opens More options and focuses the group", async () => {
  await openLead({
    extra: {
      "POST /api/agents": () =>
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
  await userEvent.click(createButton());
  const msg = await screen.findByText("Project docs isn't registered.");
  const group = screen.getByRole("group", { name: /Projects/ });
  expect(group).toContainElement(msg);
  await vi.waitFor(() =>
    expect(within(group).getByRole("checkbox", { name: /app/ })).toHaveFocus(),
  );
});

test("an unknown ?template= counts as unchosen", async () => {
  const { api } = await open({}, { template: "nope" });
  await userEvent.type(field("Display name"), "Ada");
  await userEvent.click(createButton());
  expect(await screen.findByText("Choose a template.")).toBeInTheDocument();
  expect(posts(api)).toHaveLength(0);
});

test("the credential select lists names with their kind", async () => {
  await openLead({ credentials: [credential("work"), credential("personal", "api_key")] });
  await userEvent.click(more());
  expect(await optionNames(field("Credential"))).toEqual([
    "work: OAuth token",
    "personal: API key",
  ]);
});

test("the manager picker leaves out spawned agents", async () => {
  await openLead({
    agents: [
      agentSummary({ slug: "cto", displayName: "CTO" }),
      agentSummary({
        slug: "cto-ab12",
        displayName: "Dev · ab12",
        kind: "ephemeral",
        reportsTo: "cto",
        depth: 1,
      }),
    ],
  });
  const select = field("Manager");
  await vi.waitFor(() => expect(select).toBeEnabled());
  expect((await comboOptionNames(select)).map((n) => n.replace(/@.*/, ""))).toEqual([
    "No manager (reports to the humans)",
    "CTO",
  ]);
});

test("projects: From the template, then Custom with Use template default", async () => {
  await openLead();
  await userEvent.click(more());
  const group = screen.getByRole("group", { name: /Projects/ });
  expect(within(group).getByText("From the template")).toBeInTheDocument();
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  expect(within(group).getByText("Custom")).toBeInTheDocument();
  await userEvent.click(within(group).getByRole("button", { name: "Use template default" }));
  expect(within(group).getByText("From the template")).toBeInTheDocument();
});

// --- Dismissed while creating (break-ui M2) ---

test("a late success toasts Open, doesn't navigate, and clears the draft when nothing reopened", async () => {
  const post = held();
  const { router } = await openLead({ extra: { ...created(), "POST /api/agents": post.route } });
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Team Lead");
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  expect(hasDraft("new-agent")).toBe(true);
  act(() => closeSheet());
  await act(async () => post.answer(json({ agent: agentSummary({ slug: "team-lead" }) }, 201)));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const toast = vi.mocked(notify).mock.calls[0]?.[0];
  expect(toast?.text).toBe("Created @team-lead.");
  expect(toast?.action?.label).toBe("Open");
  expect(router.state.location.pathname).toBe("/agents");
  expect(hasDraft("new-agent")).toBe(false);
  await act(async () => toast?.action?.run());
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead"));
});

test("a late success keeps the draft of a New agent reopened and typed into meanwhile", async () => {
  const post = held();
  await openLead({ extra: { ...created(), "POST /api/agents": post.route } });
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  const name = await screen.findByLabelText("Display name");
  await vi.waitFor(() => expect(name).toBeEnabled());
  await userEvent.clear(name);
  await userEvent.type(name, "Second");
  await act(async () => post.answer(json({ agent: agentSummary({ slug: "team-lead" }) }, 201)));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(hasDraft("new-agent")).toBe(true);
  expect(field("Display name").value).toBe("Second");
});

test("a late failure toasts the error with Open form, which reopens the kept draft", async () => {
  const post = held();
  await openLead({ extra: { "POST /api/agents": post.route } });
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Kept");
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  act(() => closeSheet());
  await act(async () =>
    post.answer(json({ error: { code: "boom", message: "The server fell over." } }, 500)),
  );
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const toast = vi.mocked(notify).mock.calls[0]?.[0];
  expect(toast?.text).toBe("The server fell over.");
  expect(toast?.action?.label).toBe("Open form");
  expect(hasDraft("new-agent")).toBe(true);
  act(() => toast?.action?.run());
  await sheet();
  expect(await screen.findByLabelText("Display name")).toHaveValue("Kept");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
});

// --- Entry points ---

test("/agents/new?template=x lands on /agents with New agent open", async () => {
  mockWorld();
  const { router } = renderApp("/agents/new?template=lead", alice);
  await sheet();
  expect(router.state.location.pathname).toBe("/agents");
  expect(getSheetState().parent).toMatchObject({
    kind: "new-agent",
    template: "lead",
    at: "/agents",
  });
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
});

test("/agents/new with no template opens it unchosen", async () => {
  mockWorld();
  const { router } = renderApp("/agents/new", alice);
  await sheet();
  expect(router.state.location.pathname).toBe("/agents");
  expect(getSheetState().parent).toEqual(expect.objectContaining({ kind: "new-agent" }));
  expect(getSheetState().parent).not.toHaveProperty("template");
});

test("the sidebar + opens New agent", async () => {
  mockWorld();
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New agent" }));
  await sheet();
});

test("the Agents header opens New agent", async () => {
  mockWorld({ agents: [agentSummary({ slug: "dev" })] });
  renderApp("/agents", alice);
  const main = await screen.findByRole("main");
  await userEvent.click(await within(main).findByRole("button", { name: "New agent" }));
  await sheet();
});

test("the Agents empty state opens New agent", async () => {
  mockWorld({ agents: [], credentials: [], templates: [] });
  renderApp("/agents", alice);
  const main = await screen.findByRole("main");
  expect(await within(main).findByText("No agents yet.")).toBeInTheDocument();
  await userEvent.click(within(main).getByRole("button", { name: "Create your first agent" }));
  await sheet();
});

test("the palette's New agent opens the sheet", async () => {
  mockWorld();
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const palette = await screen.findByRole("dialog", { name: "Search" });
  const actions = within(palette).getByRole("group", { name: "Actions" });
  await userEvent.click(within(actions).getByRole("option", { name: "New agent" }));
  await sheet();
});

test("the template editor's Create agent opens New agent with that template", async () => {
  mockWorld({ extra: { "GET /api/templates/lead": () => json(templateDetail(templateConfig())) } });
  const { router } = renderApp("/templates/lead", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Create agent" }));
  await sheet();
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent", template: "lead" });
  expect(router.state.location.pathname).toBe("/templates/lead");
});

// --- Carried over from the New agent page ---

test("a docker template shows the summary; a local one says Unsandboxed and the validator's warning", async () => {
  const { unmount } = await open(
    {
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
    },
    { template: "lead" },
  );
  expect(
    await screen.findByText("Docker · model opus · skills: grilling · plugins: 1"),
  ).toBeInTheDocument();
  act(() => closeSheet());
  unmount();
  await open(
    {
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
    },
    { template: "lead" },
  );
  expect(await screen.findByText("Unsandboxed")).toBeInTheDocument();
  expect(screen.getByText("The local runtime is disabled on this factory.")).toBeInTheDocument();
});

test("a secret that isn't set warns under the template and links to the prefilled add form", async () => {
  await openLead({
    details: { lead: templateDetail(templateConfig({ secrets: ["GH_TOKEN"] })) },
    secrets: [],
  });
  expect(
    await screen.findByText(
      (_c, el) =>
        el?.tagName === "SPAN" &&
        /^Secret GH_TOKEN isn't set\. The agent/.test(el.textContent ?? ""),
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /add it/ })).toHaveAttribute(
    "href",
    "/settings/secrets?addSecret=GH_TOKEN",
  );
});

test("the slow line is per attempt: a resubmit after a slow failure starts without it", async () => {
  let n = 0;
  const failNext: { current: () => void } = { current: () => {} };
  await openLead({
    details: { lead: templateDetail(templateConfig({ plugins: ["superpowers@market"] })) },
    extra: {
      "POST /api/agents": () => {
        n++;
        return new Promise<Response>((resolve) => {
          failNext.current = () => resolve(json({ error: { code: "x", message: "boom" } }, 500));
        });
      },
    },
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.getByText("Installing plugins…")).toBeInTheDocument();
  await act(async () => failNext.current());
  await screen.findByRole("button", { name: "Create agent" });
  expect(screen.queryByText("Installing plugins…")).not.toBeInTheDocument();
  await user.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  expect(n).toBe(2);
  expect(screen.queryByText("Installing plugins…")).not.toBeInTheDocument();
});

test("toggling the grants back to the template's set is not Custom", async () => {
  const { api } = await openLead({
    extra: { "POST /api/agents": () => new Promise<Response>(() => {}) },
  });
  await userEvent.click(more());
  const group = screen.getByRole("group", { name: /Projects/ });
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  expect(within(group).getByText("From the template")).toBeInTheDocument();
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
  expect(posts(api)[0]?.body).not.toHaveProperty("projects");
});

test("no projects registered says where to add one", async () => {
  await openLead({
    projects: [],
    details: { lead: templateDetail(templateConfig({ projects: [] })) },
  });
  await userEvent.click(more());
  const line = screen.getByText(
    (_c, el) => el?.tagName === "P" && el.textContent === "No projects yet. Add one in Settings.",
  );
  expect(within(line).getByRole("link")).toHaveAttribute("href", "/settings/projects");
});

test("the template error waits for the list to close, and a pick doesn't flash it", async () => {
  await open();
  await userEvent.click(field("Template"));
  await screen.findByRole("listbox");
  expect(screen.queryByText("Choose a template.")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByText("Choose a template.")).toBeInTheDocument();
  await pickOption(field("Template"), /^lead/);
  expect(screen.queryByText("Choose a template.")).not.toBeInTheDocument();
});

test("the template prefill never overwrites a field the user is in or has typed into", async () => {
  let land: (r: Response) => void = () => {};
  await open({
    extra: {
      "GET /api/templates/lead": () =>
        new Promise<Response>((resolve) => {
          land = resolve;
        }),
    },
  });
  await pickOption(field("Template"), /^lead/);
  await userEvent.click(more());
  // Straight into Description while the template detail is still in flight.
  await userEvent.type(field("Description"), "Mine");
  await act(async () => land(json(templateDetail(templateConfig()))));
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
  expect(field("Description").value).toBe("Mine");
});

test("the manager picker pads by depth, at most three levels, then marks deeper ones with └", async () => {
  const chain = ["a", "b", "c", "d", "e"];
  await openLead({
    agents: chain.map((slug, depth) =>
      agentSummary({
        slug,
        displayName: slug.toUpperCase(),
        depth,
        ...(depth ? { reportsTo: chain[depth - 1] } : {}),
      }),
    ),
  });
  const select = field("Manager");
  await vi.waitFor(() => expect(select).toBeEnabled());
  await userEvent.click(select);
  const listbox = await screen.findByRole("listbox");
  const rows = chain.map((slug) => {
    const item = within(listbox).getByRole("option", { name: new RegExp(`@${slug}`) });
    const name = item.querySelector<HTMLElement>("[style*=padding]");
    return [name?.style.paddingInlineStart, name?.textContent?.replace(/@.*/, "")];
  });
  expect(rows).toEqual([
    ["0rem", "A"],
    ["0.75rem", "B"],
    ["1.5rem", "C"],
    ["2.25rem", "D"],
    ["2.25rem", "└E"],
  ]);
});
