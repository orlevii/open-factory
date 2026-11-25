import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { MANAGE_ORG_HELP } from "@/features/agents/manage-org-help";
import { credentialsQueryOptions } from "@/features/settings/api";
import { clearDraft, clearInlineDrafts, hasDraft, resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet, resetSheets } from "@/features/sheets/sheet-store";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";
import {
  agentSummary,
  credential,
  mockWorld,
  project,
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
  clearInlineDrafts("new-agent");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The sheet suspends on credentials and templates, and React holds a revealed Suspense fallback for
 *  300 ms before showing the content. Fetching them first (the same mocked calls the sheet would make,
 *  fresh for its staleTime) takes that fixed wait out of every test that opens it. */
const warm = (qc: QueryClient, template?: string) =>
  Promise.all([
    qc.prefetchQuery(credentialsQueryOptions),
    qc.prefetchQuery(templatesQueryOptions),
    // As the template's own "New agent" button does on intent.
    template ? qc.prefetchQuery(templateQueryOptions(template)) : undefined,
  ]);

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const sheet = () => screen.findByRole("dialog", { name: "New agent" });
const createButton = () => screen.getByRole("button", { name: /^(Create agent|Creating…)$/ });
const more = () => screen.getByRole("button", { name: "More options" });
/** Renders /agents and opens New agent over it, once its body has rendered. */
async function open(world: World = {}, spec: { template?: string } = {}) {
  const api = mockWorld(world);
  const utils = renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  await warm(utils.queryClient, spec.template);
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
  [`GET /api/agents/${slug}`]: () =>
    json({
      agent: agentSummary({ slug }),
      queue: [],
      lastSeq: 0,
    }),
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
  await warm(first.queryClient);
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  await userEvent.click(await screen.findByRole("button", { name: "More options" }));
  await pickOption(field("Credential"), /^prod/);
  act(() => closeSheet());
  first.unmount();
  const { dialog } = await open({ credentials: [credential("work"), credential("other")] });
  expect(more()).toHaveAttribute("aria-expanded", "true");
  expect(within(dialog).getByText("Choose a credential.")).toBeInTheDocument();
  expect(within(dialog).getByText("That credential was deleted.")).toBeInTheDocument();
});

test("leaving an unchosen Credential for its own Add credential button doesn't flag it", async () => {
  mockWorld({ credentials: [credential("work"), credential("prod")] });
  const first = renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  await warm(first.queryClient);
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  await userEvent.click(await screen.findByRole("button", { name: "More options" }));
  await pickOption(field("Credential"), /^prod/);
  act(() => closeSheet());
  first.unmount();
  // The restored draft's credential is gone: with two left, none is chosen.
  const { dialog } = await open({ credentials: [credential("work"), credential("other")] });
  const trigger = field("Credential");
  expect(trigger).toHaveTextContent("Choose a credential");
  expect(trigger).not.toHaveAttribute("aria-invalid");
  act(() => trigger.focus());
  await userEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
  await screen.findByRole("group", { name: "Add credential" });
  expect(trigger).not.toHaveAttribute("aria-invalid");
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
  [
    [templateSummary("solo", 1)],
    "No template is ready: fix the errors in solo.",
    "/templates/solo",
  ],
  [
    [templateSummary("one", 1), templateSummary("two", 3)],
    "No template is ready: fix the errors in 2 templates.",
    "/templates",
  ],
])("all templates broken: a link to fix them (%#)", async (templates, text, href) => {
  const { dialog } = await open({ templates });
  const line = within(dialog).getByText(/^No template is ready: fix the errors in/);
  expect(line).toHaveTextContent(text);
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

const templateConfigRoute = () =>
  json({
    doc: { template: { model: "sonnet" }, settings: {}, mcp: { mcpServers: {} } },
    hashes: { "template.yaml": "h", "settings.json": null, "mcp.json": null },
    issues: [],
    localSkills: [],
    agents: { live: 0, archived: 0, cantStart: 0 },
  });
const newAgentConfig = (overlay: Record<string, unknown> = {}) => ({
  overlay,
  version: "v1",
  template: { name: "lead", doc: null, valid: true },
  merged: null,
  issues: [],
});
const configPuts = (api: { calls: { method: string; url: string; body: unknown }[] }) =>
  api.calls.filter((c) => c.method === "PUT" && c.url === "/api/agents/team-lead/config");

test("Model and Effort sit under More options, off with 'Choose a template first' until a template is picked", async () => {
  const { dialog } = await open();
  await userEvent.click(more());
  expect(field("Model")).toBeDisabled();
  expect(field("Effort")).toBeDisabled();
  expect(field("Model")).toHaveAccessibleDescription("Choose a template first");
  expect(within(dialog).getAllByText("Choose a template first")).toHaveLength(2);
});

test("with a template, each inherit option names the template's value", async () => {
  await openLead({ extra: { "GET /api/templates/lead/config": templateConfigRoute } });
  await userEvent.click(more());
  await vi.waitFor(() => expect(field("Model")).toHaveTextContent("Template's (sonnet)"));
  expect(field("Model")).toBeEnabled();
  expect(field("Effort")).toHaveTextContent("Template's (Claude Code default)");
});

test("a chosen model is written to the new agent's config after it is created", async () => {
  const { api } = await openLead({
    extra: {
      ...created(),
      "GET /api/templates/lead/config": templateConfigRoute,
      "GET /api/agents/team-lead/config": () => json(newAgentConfig()),
      "PUT /api/agents/team-lead/config": () =>
        json({
          ...newAgentConfig({ template: { model: "opus" } }),
          changes: [],
          restartChecked: false,
          checked: "full",
        }),
    },
  });
  await userEvent.click(more());
  await pickOption(field("Model"), "opus");
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(configPuts(api)).toHaveLength(1));
  expect(configPuts(api)[0]?.body).toEqual({
    overlay: { template: { model: "opus" } },
    baseVersion: "v1",
  });
  expect(posts(api)).toHaveLength(1);
});

test("an agent created with no model chosen makes no config write", async () => {
  const { api, router } = await openLead({ extra: created() });
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead/chat"));
  expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
});

test("if the config write fails, the agent still exists and a toast says Model and effort weren't set", async () => {
  const { api, router } = await openLead({
    extra: {
      ...created(),
      "GET /api/templates/lead/config": templateConfigRoute,
      "GET /api/agents/team-lead/config": () => json(newAgentConfig()),
      "PUT /api/agents/team-lead/config": () =>
        json({ error: { code: "invalid_config", message: "The configuration has errors." } }, 400),
    },
  });
  await userEvent.click(more());
  await pickOption(field("Effort"), "high");
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead/chat"));
  expect(posts(api)).toHaveLength(1);
  expect(vi.mocked(notify).mock.calls.map((c) => c[0].text)).toEqual([
    "Created @team-lead. Model and effort weren't set: The configuration has errors.",
  ]);
});

test("success closes the sheet, clears the draft and navigates to the session", async () => {
  const { api, router } = await openLead({ extra: created() });
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead/chat"));
  expect(getSheetState().parent).toBeUndefined();
  expect(hasDraft("new-agent")).toBe(false);
  expect(notify).not.toHaveBeenCalled();
  expect(posts(api)[0]?.body).toEqual({
    template: "lead",
    slug: "team-lead",
    displayName: "Team Lead",
    description: "Leads the team",
    reportsTo: "alice", // no manager picked: the signed-in human manages it
    credential: "work",
  });
});

test("without a signed-in handle and no manager picked, Create agent refuses with Choose a manager.", async () => {
  const { api, queryClient, dialog } = await openLead({ extra: created() });
  act(() =>
    queryClient.setQueryData(["session"], { ...alice, user: { ...alice.user, handle: "" } }),
  );
  await userEvent.click(createButton());
  expect(await within(dialog).findByText("Choose a manager.")).toBeInTheDocument();
  expect(posts(api)).toHaveLength(0);
});

test("a created agent sets a cached setup answer's hasAgent without asking the server again", async () => {
  const { api, queryClient, router } = await openLead({ extra: created() });
  queryClient.setQueryData(["setup"], { hasCredential: true, hasTemplate: true, hasAgent: false });
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead/chat"));
  expect(queryClient.getQueryData(["setup"])).toEqual({
    hasCredential: true,
    hasTemplate: true,
    hasAgent: true,
  });
  expect(api.calls.some((c) => c.url === "/api/setup")).toBe(false);
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
  await warm(first.queryClient);
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  const manager = await screen.findByLabelText("Manager");
  await vi.waitFor(() => expect(manager).toBeEnabled());
  await userEvent.click(manager);
  await userEvent.click(await screen.findByRole("option", { name: /Boss/ }));
  act(() => closeSheet());
  first.unmount();
  const { dialog } = await open({ agents: [] });
  expect(
    await within(dialog).findByText("That agent has ended; pick another."),
  ).toBeInTheDocument();
  expect(field("Manager")).toHaveTextContent("You (Alice · @alice)");
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

test("a failing submit with no credential chosen opens More options every time, and focuses Credential", async () => {
  mockWorld({ credentials: [credential("work"), credential("prod")] });
  const first = renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  await warm(first.queryClient, "lead");
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
  await userEvent.click(more());
  await pickOption(field("Credential"), /^prod/);
  act(() => closeSheet());
  first.unmount();
  // The restored draft's credential is gone and two are left: none is chosen.
  const { api } = await open({ credentials: [credential("work"), credential("other")] });
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Ada");
  for (let i = 0; i < 2; i++) {
    expect(more()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(more());
    expect(more()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(createButton());
    await vi.waitFor(() => expect(field("Credential")).toHaveFocus());
    expect(more()).toHaveAttribute("aria-expanded", "true");
    expect(field("Credential")).toHaveAttribute("aria-invalid", "true");
  }
  expect(posts(api)).toHaveLength(0);
});

test("Change is a skip control: pressing it doesn't validate the Display name being left", async () => {
  const { dialog } = await open();
  const name = field("Display name");
  await userEvent.clear(name);
  expect(name).toHaveFocus();
  await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));
  expect(within(dialog).queryByText("Enter a display name.")).toBeNull();
  expect(name).not.toHaveAttribute("aria-invalid");
});

test("tabbing through untouched fields shows nothing", async () => {
  const { dialog } = await open();
  await vi.waitFor(() => expect(field("Template")).toHaveFocus());
  for (let i = 0; i < 8; i++) await userEvent.tab();
  expect(dialog.querySelector('[aria-invalid="true"]')).toBeNull();
  expect(within(dialog).queryByText("Choose a template.")).toBeNull();
  expect(within(dialog).queryByText("Enter a display name.")).toBeNull();
});

test("a template error is the field's note", async () => {
  await open();
  await userEvent.click(createButton());
  const msg = await screen.findByText("Choose a template.");
  expect(msg.closest(".field-note")).not.toBeNull();
  await vi.waitFor(() => expect(field("Template")).toHaveFocus());
});

test("leaving a changed Template that now fails for its own New template button doesn't flag it", async () => {
  const templates = [templateSummary("lead"), templateSummary("writer")];
  const { dialog, queryClient } = await open({ templates });
  await pickOption(field("Template"), /^lead/);
  // Broken elsewhere: the chosen template now has errors, so the field's check fails.
  templates[0] = templateSummary("lead", 2);
  await act(() => queryClient.invalidateQueries({ queryKey: ["templates"] }));
  await vi.waitFor(() => expect(field("Template")).toHaveTextContent("Choose a template"));
  act(() => field("Template").focus());
  await userEvent.click(within(dialog).getByRole("button", { name: "New template" }));
  await child("New template");
  expect(within(dialog).queryByText("That template has errors; fix it first.")).toBeNull();
  expect(field("Template")).not.toHaveAttribute("aria-invalid");
});

test("a first click on More options, with Template focused, opens it and flags nothing", async () => {
  const { dialog } = await open();
  await vi.waitFor(() => expect(field("Template")).toHaveFocus());
  await userEvent.click(more());
  expect(more()).toHaveAttribute("aria-expanded", "true");
  expect(field("Template")).not.toHaveAttribute("aria-invalid");
  expect(within(dialog).queryByText("Choose a template.")).toBeNull();
});

test("leaving a changed Template that now fails for More options doesn't flag it", async () => {
  const templates = [templateSummary("lead"), templateSummary("writer")];
  const { dialog, queryClient } = await open({ templates });
  await pickOption(field("Template"), /^lead/);
  templates[0] = templateSummary("lead", 2);
  await act(() => queryClient.invalidateQueries({ queryKey: ["templates"] }));
  await vi.waitFor(() => expect(field("Template")).toHaveTextContent("Choose a template"));
  act(() => field("Template").focus());
  await userEvent.click(more());
  expect(more()).toHaveAttribute("aria-expanded", "true");
  expect(within(dialog).queryByText("That template has errors; fix it first.")).toBeNull();
  expect(field("Template")).not.toHaveAttribute("aria-invalid");
});

test("leaving a changed Credential that is now gone for Add credential doesn't flag it", async () => {
  const credentials = [credential("work"), credential("prod"), credential("other")];
  const { dialog, queryClient } = await open({ credentials });
  await userEvent.click(more());
  await pickOption(field("Credential"), /^prod/);
  // Deleted elsewhere: the chosen credential is gone and two are left, so the field's check fails.
  credentials.splice(1, 1);
  await act(() => queryClient.invalidateQueries());
  await vi.waitFor(() => expect(field("Credential")).toHaveTextContent("Choose a credential"));
  act(() => field("Credential").focus());
  await userEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
  await inline("Add credential");
  // "Choose a credential." stays as More options' reason; the field's note line is what must stay empty.
  expect(dialog.querySelector("#field-credential-error")).not.toHaveAttribute("data-shown");
  expect(field("Credential")).not.toHaveAttribute("aria-invalid");
});

test("leaving a changed, invalid Slug flags it", async () => {
  await openLead();
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "!!!");
  await userEvent.tab();
  await vi.waitFor(() => expect(field("Slug")).toHaveFocus());
  await userEvent.type(field("Slug"), "-bad-");
  await userEvent.tab();
  await vi.waitFor(() => expect(field("Slug")).toHaveAttribute("aria-invalid", "true"));
});

test("no templates: the label is plain text and a failing submit focuses the empty state", async () => {
  const { dialog } = await open({ templates: [] });
  expect(dialog.querySelector('label[for="field-template"]')).toBeNull();
  const empty = within(dialog).getByText("No templates yet.");
  await userEvent.type(field("Display name"), "Ada");
  await userEvent.click(createButton());
  const msg = await within(dialog).findByText("Choose a template.");
  await vi.waitFor(() => expect(empty).toHaveFocus());
  expect(empty.getAttribute("aria-describedby")?.split(" ")).toContain(msg.closest("[id]")?.id);
});

test("every template broken: the empty state carries the note too", async () => {
  const { dialog } = await open({ templates: [templateSummary("lead", 1)] });
  expect(dialog.querySelector('label[for="field-template"]')).toBeNull();
  const empty = within(dialog).getByText(/No template is ready/);
  expect(empty).toHaveAttribute("id", "field-template");
  await userEvent.type(field("Display name"), "Ada");
  await userEvent.click(createButton());
  await within(dialog).findByText("Choose a template.");
  await vi.waitFor(() => expect(empty).toHaveFocus());
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
  // Shown unchosen: the trigger reads its placeholder and focus opens on Template, as with no template at all.
  const template = screen.getByRole("combobox", { name: "Template" });
  expect(template).toHaveTextContent("Choose a template");
  await waitFor(() => expect(template).toHaveFocus());
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
        reportsTo: { kind: "agent", handle: "cto" },
        depth: 1,
      }),
    ],
  });
  const select = field("Manager");
  await vi.waitFor(() => expect(select).toBeEnabled());
  expect(await comboOptionNames(select)).toEqual(["You (Alice · @alice)", "CTO@cto"]);
});

test("projects: the template's set is checked, and a toggle changes it", async () => {
  await openLead();
  await userEvent.click(more());
  const group = screen.getByRole("group", { name: /Projects/ });
  // The lead template grants app, not docs.
  expect(within(group).getByRole("checkbox", { name: /app/ })).toBeChecked();
  expect(within(group).getByRole("checkbox", { name: /docs/ })).not.toBeChecked();
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  expect(within(group).getByRole("checkbox", { name: /docs/ })).toBeChecked();
  expect(within(group).getByRole("checkbox", { name: /app/ })).toBeChecked();
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
  await waitFor(() => expect(router.state.location.pathname).toBe("/agents/team-lead/chat"));
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

test("a late success keeps a draft reopened, typed into and closed again meanwhile", async () => {
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
  act(() => closeSheet());
  await act(async () => post.answer(json({ agent: agentSummary({ slug: "team-lead" }) }, 201)));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(hasDraft("new-agent")).toBe(true);
});

test("a late success over a New agent reopened on the sent values clears the draft and closes it", async () => {
  const post = held();
  const { api } = await openLead({ extra: { ...created(), "POST /api/agents": post.route } });
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Team Lead");
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  expect(await screen.findByLabelText("Display name")).toHaveValue("Team Lead");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
  await act(async () => post.answer(json({ agent: agentSummary({ slug: "team-lead" }) }, 201)));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      text: "Created @team-lead.",
      action: { label: "Open", run: expect.any(Function) },
    }),
  );
  expect(hasDraft("new-agent")).toBe(false);
  // The form holding the created values closes instead of inviting a second Create.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "New agent" })).toBeNull());
  expect(posts(api)).toHaveLength(1);
});

test("a late success over a reopened, untouched New agent keeps it open while a stacked New template is on it", async () => {
  const post = held();
  await openLead({ extra: { ...created(), "POST /api/agents": post.route } });
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Team Lead");
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  act(() => closeSheet());
  act(() => openSheet({ kind: "new-agent" }));
  const parent = await sheet();
  expect(await screen.findByLabelText("Display name")).toHaveValue("Team Lead");
  await userEvent.click(within(parent).getByRole("button", { name: "New template" }));
  await screen.findByRole("dialog", { name: "New template" });
  await act(async () => post.answer(json({ agent: agentSummary({ slug: "team-lead" }) }, 201)));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  // The child (and whatever the user is typing in it) stays; the sent draft is still cleared.
  expect(getSheetState().child?.kind).toBe("new-template");
  expect(getSheetState().parent?.kind).toBe("new-agent");
  expect(hasDraft("new-agent")).toBe(false);
});

test("a late success after a sign-out neither toasts nor touches the next user's draft", async () => {
  const post = held();
  await openLead({ extra: { ...created(), "POST /api/agents": post.route } });
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Team Lead");
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  act(() => closeSheet());
  act(() => resetDrafts());
  // The next user types the same values: the late success must not take them for the sent draft.
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  await sheet();
  const name = await screen.findByLabelText("Display name");
  await vi.waitFor(() => expect(name).toHaveValue("Team Lead"));
  await userEvent.clear(name);
  await userEvent.type(name, "Team Lead");
  expect(hasDraft("new-agent")).toBe(true);
  await act(async () => post.answer(json({ agent: agentSummary({ slug: "team-lead" }) }, 201)));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
  expect(hasDraft("new-agent")).toBe(true);
  expect(screen.getByRole("dialog", { name: "New agent" })).toBeInTheDocument();
});

test("a late failure after a sign-out doesn't toast", async () => {
  const post = held();
  await openLead({ extra: { "POST /api/agents": post.route } });
  await userEvent.click(createButton());
  await screen.findByRole("button", { name: /Creating…/ });
  act(() => closeSheet());
  act(() => resetDrafts());
  await act(async () =>
    post.answer(json({ error: { code: "boom", message: "The server fell over." } }, 500)),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(notify).not.toHaveBeenCalled();
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

test("a sheet opened for a template prefills from it", async () => {
  mockWorld();
  const { queryClient } = renderApp("/agents", alice);
  await warm(queryClient, "lead");
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  await sheet();
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
});

/** A world whose `lead` detail answers only when `land()` is called. */
function lateDetail() {
  let land!: () => void;
  const landed = new Promise<void>((r) => {
    land = r;
  });
  const world: World = {
    extra: {
      "GET /api/templates/lead": async () => {
        await landed;
        return json(templateDetail(templateConfig()));
      },
    },
  };
  return { world, land };
}

test("a template detail that lands after the sheet opened still prefills it", async () => {
  const late = lateDetail();
  mockWorld(late.world);
  const { queryClient } = renderApp("/agents", alice);
  await warm(queryClient);
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  await within(await sheet()).findByRole("button", { name: "Create agent" });
  await vi.waitFor(() => expect(field("Display name")).toHaveFocus());
  late.land();
  await vi.waitFor(() => expect(field("Display name").value).toBe("Team Lead"));
});

test("a field the user enters before the template detail lands stays theirs", async () => {
  const late = lateDetail();
  mockWorld(late.world);
  const { queryClient } = renderApp("/agents", alice);
  await warm(queryClient);
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  await within(await sheet()).findByRole("button", { name: "Create agent" });
  await userEvent.click(more());
  await userEvent.click(field("Display name"));
  late.land();
  await vi.waitFor(() => expect(field("Description").value).toBe("Leads the team"));
  expect(field("Display name").value).toBe("");
});

test("the sidebar + opens New agent", async () => {
  mockWorld();
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New agent" }));
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

// --- Carried over from the New agent page ---

test("a docker template shows the summary; a local one says Unsandboxed and the validator's warning", async () => {
  const { unmount } = await open(
    {
      templates: [templateSummary("lead"), templateSummary("writer")],
      details: {
        lead: templateDetail(
          templateConfig({
            runtime: "docker",
            model: "opus",
            skills: ["grilling"],
          }),
        ),
      },
    },
    { template: "lead" },
  );
  expect(await screen.findByText("Docker · model opus · skills: grilling")).toBeInTheDocument();
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

test("a touched Projects group sends its set", async () => {
  const { api } = await openLead({
    extra: { "POST /api/agents": () => new Promise<Response>(() => {}) },
  });
  await userEvent.click(more());
  const group = screen.getByRole("group", { name: /Projects/ });
  await userEvent.click(within(group).getByRole("checkbox", { name: /docs/ }));
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
  expect(posts(api)[0]?.body).toHaveProperty("projects", expect.arrayContaining(["docs"]));
});

test("Can manage the org: a switch, off, described by the lead and the spec's help", async () => {
  const { dialog } = await openLead();
  const sw = within(dialog).getByRole("switch", { name: "Can manage the org" });
  expect(sw).not.toBeChecked();
  expect(sw).toHaveAccessibleDescription(MANAGE_ORG_HELP);
});

test("Can manage the org: switched on, the create posts manageOrg true", async () => {
  const { api } = await openLead({ extra: created() });
  await userEvent.click(screen.getByRole("switch", { name: "Can manage the org" }));
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
  expect(posts(api)[0]?.body).toHaveProperty("manageOrg", true);
});

test("Can manage the org: left off, the create posts no manageOrg", async () => {
  const { api } = await openLead({ extra: created() });
  await userEvent.click(createButton());
  await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
  expect(posts(api)[0]?.body).not.toHaveProperty("manageOrg");
});

test("no projects registered says so beside Add project", async () => {
  const { dialog } = await openLead({
    projects: [],
    details: { lead: templateDetail(templateConfig({ projects: [] })) },
  });
  await userEvent.click(more());
  const group = within(dialog).getByRole("group", { name: /Projects/ });
  expect(within(group).getByText("No projects yet.")).toBeInTheDocument();
  expect(within(group).queryByRole("link")).not.toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "Add project" })).toBeInTheDocument();
});

test("the template error waits for the list to close, and a pick doesn't flash it", async () => {
  await open();
  await userEvent.click(createButton());
  expect(await screen.findByText("Choose a template.")).toBeInTheDocument();
  await userEvent.click(field("Template"));
  await screen.findByRole("listbox");
  await userEvent.keyboard("{Escape}");
  expect(field("Template")).toHaveAccessibleDescription("Choose a template.");
  await pickOption(field("Template"), /^lead/);
  // The note keeps its last text hidden (no layout shift); what counts is that it isn't shown.
  expect(screen.getByText("Choose a template.").closest("p")).not.toHaveAttribute("data-shown");
  expect(field("Template")).not.toHaveAttribute("aria-invalid");
});

test("opening and closing the template list untouched says nothing", async () => {
  await open();
  await userEvent.click(field("Template"));
  await screen.findByRole("listbox");
  await userEvent.keyboard("{Escape}");
  await act(async () => {});
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

test("the manager picker marks agents deeper than three levels with └", async () => {
  const chain = ["a", "b", "c", "d", "e"];
  await openLead({
    agents: chain.map((slug, depth) =>
      agentSummary({
        slug,
        displayName: slug.toUpperCase(),
        depth,
        ...(depth ? { reportsTo: { kind: "agent", handle: chain[depth - 1] as string } } : {}),
      }),
    ),
  });
  const select = field("Manager");
  await vi.waitFor(() => expect(select).toBeEnabled());
  await userEvent.click(select);
  const listbox = await screen.findByRole("listbox");
  const rows = chain.map((slug) => {
    const item = within(listbox).getByRole("option", { name: `${slug.toUpperCase()}@${slug}` });
    return item.textContent?.replace(/@.*/, "");
  });
  expect(rows).toEqual(["A", "B", "C", "D", "└E"]);
});

// --- Inline prerequisites (spec §4.9) ---

const child = (name: string) => screen.findByRole("dialog", { name });
/** An inline prerequisite: a group, never a nested form. */
const inline = (name: string) => screen.findByRole("group", { name });
const noGroup = (name: string) => expect(screen.queryByRole("group", { name })).toBeNull();
/** A GET that answers only when the test says so, with the list the test passes. */
function heldList<T>(key: string) {
  const answers: ((r: Response) => void)[] = [];
  return {
    route: () => new Promise<Response>((r) => answers.push(r)),
    answer: (body: T) => answers.shift()?.(json({ [key]: body })),
    get waiting() {
      return answers.length;
    },
  };
}
/** Resolves once the POST to `url` has reached the (mocked) server. */
const posted = (api: { calls: { method: string; url: string }[] }, url: string) =>
  waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.url === url)).toBe(true));
/** A server that keeps what it is given: the POST adds to the list later GETs read. */
function storing() {
  const credentials = [credential("work")];
  return {
    credentials,
    "POST /api/credentials": (body: unknown) => {
      const c = credential((body as { name: string }).name);
      credentials.push(c);
      return json({ credential: c }, 201);
    },
  };
}
function storingSecrets() {
  const secrets: { name: string; updatedAt: string; usedBy: string[] }[] = [];
  return {
    secrets,
    extra: {
      "PUT /api/secrets/GH_TOKEN": () => {
        const secret = { name: "GH_TOKEN", updatedAt: "2026-11-22T08:00:00.000Z", usedBy: [] };
        secrets.push(secret);
        return json({ secret });
      },
    },
  };
}
async function fillCredential(name: string, token = "sk-ant-oat-1") {
  const g = await inline("Add credential");
  await userEvent.click(await within(g).findByRole("radio", { name: "Paste a token" }));
  await userEvent.type(await within(g).findByLabelText("Name"), name);
  await userEvent.type(within(g).getByLabelText("Token"), token);
  return g;
}
async function addCredential(name: string, token?: string) {
  const g = await fillCredential(name, token);
  await userEvent.click(within(g).getByRole("button", { name: "Verify and add" }));
  return g;
}
async function openAddCredential(world: World = {}) {
  const r = await openLead(world);
  await userEvent.click(more());
  const trigger = within(r.dialog).getByRole("button", { name: "Add credential" });
  await userEvent.click(trigger);
  return { ...r, trigger };
}

test("Add credential expands inline under the Credential field, a disclosure, and keeps the typed values", async () => {
  const { dialog } = await openLead();
  await userEvent.clear(field("Display name"));
  await userEvent.type(field("Display name"), "Mine");
  await userEvent.click(more());
  const add = within(dialog).getByRole("button", { name: "Add credential" });
  expect(add).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(add);
  const g = await inline("Add credential");
  expect(add).toHaveAttribute("aria-expanded", "true");
  expect(g.closest("form")).toBe(dialog.querySelector("form"));
  expect(g.tagName).not.toBe("FORM");
  expect(getSheetState().child).toBeUndefined();
  expect(field("Display name").value).toBe("Mine");
  await waitFor(() => expect(within(g).getByLabelText("Name")).toHaveFocus());
  // Its buttons are secondary: Create agent stays the one primary.
  expect(within(g).getByRole("button", { name: /Start sign-in|Verify and add/ })).toHaveAttribute(
    "data-variant",
    "outline",
  );
});

test("Enter in the credential's Name submits nothing of the agent form", async () => {
  const { api } = await openAddCredential();
  const g = await inline("Add credential");
  await userEvent.type(within(g).getByLabelText("Name"), "prod{Enter}");
  expect(posts(api)).toHaveLength(0);
  expect(screen.getByRole("dialog", { name: "New agent" })).toBeInTheDocument();
});

test("Enter in the token submits only the credential", async () => {
  const { credentials, ...extra } = storing();
  const { api } = await openAddCredential({ credentials, extra });
  const g = await fillCredential("prod");
  await userEvent.type(within(g).getByLabelText("Token"), "{Enter}");
  await posted(api, "/api/credentials");
  expect(posts(api)).toHaveLength(0);
  await waitFor(() => expect(field("Credential")).toHaveTextContent("prod"));
});

test("Escape collapses only the expansion: the sheet stays and focus returns to the trigger", async () => {
  const { trigger } = await openAddCredential();
  const g = await inline("Add credential");
  await waitFor(() => expect(within(g).getByLabelText("Name")).toHaveFocus());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => noGroup("Add credential"));
  expect(screen.getByRole("dialog", { name: "New agent" })).toBeInTheDocument();
  expect(getSheetState().parent?.kind).toBe("new-agent");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(trigger).toHaveFocus());
  // With the expansion gone, Escape closes the sheet as before.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
});

test("Escape does nothing while the credential is being verified", async () => {
  const post = held();
  const { api } = await openAddCredential({ extra: { "POST /api/credentials": post.route } });
  const g = await addCredential("prod");
  await posted(api, "/api/credentials");
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("group", { name: "Add credential" })).toBeInTheDocument();
  expect(getSheetState().parent?.kind).toBe("new-agent");
  expect(g).toBeInTheDocument();
  await act(async () => post.answer(json({ credential: credential("prod") }, 201)));
  await waitFor(() => noGroup("Add credential"));
});

test("Create agent while the expansion is open and dirty focuses it and says to add or cancel it first", async () => {
  const { api, dialog } = await openAddCredential({ extra: created() });
  const g = await inline("Add credential");
  await userEvent.type(within(g).getByLabelText("Name"), "prod");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  expect(posts(api)).toHaveLength(0);
  expect(await within(g).findByText("Add the credential or cancel it first.")).toBeInTheDocument();
  expect(g).toHaveFocus();
  expect(g).toHaveAccessibleDescription("Add the credential or cancel it first.");
  // Cancelled, nothing holds the agent back.
  await userEvent.click(within(g).getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  await posted(api, "/api/agents");
});

test("an open expansion nobody typed into doesn't hold Create agent back", async () => {
  const { api, dialog } = await openAddCredential({ extra: created() });
  await inline("Add credential");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  await posted(api, "/api/agents");
});

test("Verify and add selects the new credential, focuses the field and says Added <name>.", async () => {
  const { credentials, ...extra } = storing();
  const { dialog } = await openAddCredential({ credentials, extra });
  await addCredential("prod");
  await waitFor(() => noGroup("Add credential"));
  expect(field("Credential")).toHaveTextContent("prod");
  await waitFor(() => expect(field("Credential")).toHaveFocus());
  expect(within(dialog).getByText("Added prod.")).toBeInTheDocument();
  // Picking another credential makes the note stale.
  await pickOption(field("Credential"), /^work/);
  expect(within(dialog).queryByText("Added prod.")).toBeNull();
});

test("the No Claude credential yet state adds one inline and selects it", async () => {
  const { credentials, ...extra } = storing();
  credentials.length = 0;
  const { dialog } = await open({ credentials, extra });
  await userEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
  await addCredential("prod");
  await waitFor(() => noGroup("Add credential"));
  expect(field("Credential")).toHaveTextContent("prod");
  expect(within(dialog).queryByText("No Claude credential yet.")).not.toBeInTheDocument();
});

test("a rejected token stays an inline error in the expansion and nothing is stored", async () => {
  const { queryClient } = await openAddCredential({
    extra: {
      "POST /api/credentials": () =>
        json(
          { error: { code: "credential_rejected", message: "Claude rejected this token." } },
          422,
        ),
    },
  });
  const g = await addCredential("prod");
  expect(await within(g).findByText("Claude rejected this token.")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Add credential" })).toBeInTheDocument();
  expect(
    (queryClient.getQueryData(["credentials"]) as { name: string }[]).map((c) => c.name),
  ).toEqual(["work"]);
});

test("a credentials fetch already pending when the credential is added resolves without dropping it", async () => {
  const list = heldList<ReturnType<typeof credential>[]>("credentials");
  const { credentials, ...extra } = storing();
  const r = await openAddCredential({ credentials, extra });
  r.api.on("GET /api/credentials", list.route);
  // A refetch started before the POST answers, and reads the list without the new credential.
  void r.queryClient.refetchQueries({ queryKey: ["credentials"] });
  await waitFor(() => expect(list.waiting).toBe(1));
  await addCredential("prod");
  await waitFor(() => noGroup("Add credential"));
  await act(async () => list.answer([credential("work")]));
  const names = () =>
    (r.queryClient.getQueryData(["credentials"]) as { name: string }[]).map((c) => c.name);
  expect(names()).toEqual(["work", "prod"]);
  expect(field("Credential")).toHaveTextContent("prod");
  // The background refetch the add started reads the server's list, which has it.
  await waitFor(() => expect(list.waiting).toBe(1));
  await act(async () => list.answer([credential("work"), credential("prod")]));
  expect(names()).toEqual(["work", "prod"]);
});

test("the sheet closed while the credential verifies: the late success updates the cache only", async () => {
  const post = held();
  const { queryClient, api } = await openAddCredential({
    extra: { "POST /api/credentials": post.route },
  });
  await addCredential("prod");
  await posted(api, "/api/credentials");
  act(() => closeSheet());
  post.answer(json({ credential: credential("prod") }, 201));
  await waitFor(() =>
    expect(
      (queryClient.getQueryData(["credentials"]) as { name: string }[]).map((c) => c.name),
    ).toContain("prod"),
  );
  expect(hasDraft("new-agent")).toBe(false);
  expect(getSheetState()).toEqual({});
});

test("sign-out while a credential verifies drops its late result", async () => {
  const post = held();
  const { queryClient, api } = await openAddCredential({
    extra: { "POST /api/credentials": post.route },
  });
  await addCredential("prod");
  await posted(api, "/api/credentials");
  act(() => {
    resetSheets();
    resetDrafts();
  });
  // The next session's list reads never answer, so a stray write can't be hidden by a refetch.
  api.on("GET /api/credentials", heldList("credentials").route);
  act(() => openSheet({ kind: "new-agent" }));
  await sheet();
  post.answer(json({ credential: credential("prod") }, 201));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(
    (queryClient.getQueryData(["credentials"]) as { name: string }[]).map((c) => c.name),
  ).toEqual(["work"]);
  expect(hasDraft("new-agent")).toBe(false);
});

test("closing the sheet with Add credential open keeps its name and method, never the token", async () => {
  const { api, dialog } = await openAddCredential();
  const g = await inline("Add credential");
  await userEvent.click(within(g).getByRole("radio", { name: "Paste an API key" }));
  await userEvent.type(within(g).getByLabelText("Name"), "prod");
  await userEvent.type(within(g).getByLabelText("Key"), "sk-ant-api03-SYNTHETIC");
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  act(() => closeSheet());
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  act(() => openSheet({ kind: "new-agent", template: "lead" }));
  const again = await inline("Add credential");
  expect(within(again).getByLabelText("Name")).toHaveValue("prod");
  expect(within(again).getByRole("radio", { name: "Paste an API key" })).toBeChecked();
  expect(within(again).getByLabelText("Key")).toHaveValue("");
});

test("Cancel in the expansion collapses it, forgets it and returns focus to the trigger", async () => {
  const { trigger } = await openAddCredential();
  const g = await inline("Add credential");
  await userEvent.type(within(g).getByLabelText("Name"), "prod");
  await userEvent.click(within(g).getByRole("button", { name: "Cancel" }));
  await waitFor(() => noGroup("Add credential"));
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(trigger).toHaveFocus());
  await userEvent.click(trigger);
  expect(within(await inline("Add credential")).getByLabelText("Name")).toHaveValue("");
});

test("Add project expands inline, adds it to the grants as an override and focuses it", async () => {
  const projects = [project("app"), project("docs")];
  const { dialog } = await openLead({
    projects,
    extra: {
      "POST /api/projects": () => {
        projects.push(project("web"));
        return json({ project: project("web") }, 201);
      },
    },
  });
  await userEvent.click(more());
  const group = within(dialog).getByRole("group", { name: /Projects/ });
  const add = within(group).getByRole("button", { name: "Add project" });
  expect(add).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(add);
  const g = await inline("Add project");
  await userEvent.type(await within(g).findByLabelText("Name"), "web");
  await userEvent.type(within(g).getByLabelText("Path"), "/src/web");
  await userEvent.click(within(g).getByRole("button", { name: "Add project" }));
  await waitFor(() => noGroup("Add project"));
  const web = await within(group).findByRole("checkbox", { name: /web/ });
  expect(web).toBeChecked();
  expect(within(group).getByRole("checkbox", { name: /app/ })).toBeChecked();
  await waitFor(() => expect(web).toHaveFocus());
});

test("Add secret expands inline prefilled with Value focused; success removes the warning and focuses Template", async () => {
  const { dialog } = await openLead({
    details: { lead: templateDetail(templateConfig({ secrets: ["GH_TOKEN"] })) },
    ...storingSecrets(),
  });
  const warning = await within(dialog).findByText(
    (_c, el) =>
      el?.tagName === "SPAN" &&
      el.textContent === "Secret GH_TOKEN isn't set. The agent won't start until you add it.",
  );
  const add = within(dialog).getByRole("button", { name: "Add secret" });
  expect(add).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(add);
  const g = await inline("Add secret");
  expect(within(g).getByLabelText("Name")).toHaveValue("GH_TOKEN");
  await waitFor(() => expect(within(g).getByLabelText("Value")).toHaveFocus());
  await userEvent.type(within(g).getByLabelText("Value"), "ghp_1");
  await userEvent.click(within(g).getByRole("button", { name: "Add secret" }));
  await waitFor(() => noGroup("Add secret"));
  expect(warning).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/isn't set/)).not.toBeInTheDocument();
  await waitFor(() => expect(field("Template")).toHaveFocus());
});

test("leaving an unchosen Template for its own New template button doesn't flag it", async () => {
  const { dialog } = await open({ templates: [templateSummary("lead")] });
  await waitFor(() => expect(field("Template")).toHaveFocus());
  await userEvent.click(within(dialog).getByRole("button", { name: "New template" }));
  await child("New template");
  expect(within(dialog).queryByText("Choose a template.")).toBeNull();
  expect(field("Template")).not.toHaveAttribute("aria-invalid");
});

test("New template (stacked) selects the new template", async () => {
  const writer = templateConfig({ name: "writer", displayName: "Writer", description: "" });
  const templates = [templateSummary("lead")];
  const { dialog } = await open({
    templates,
    details: { lead: templateDetail(templateConfig()), writer: templateDetail(writer) },
    extra: {
      "POST /api/templates": () => {
        templates.push({ ...templateSummary("writer"), displayName: "Writer" });
        return json(templateDetail(writer), 201);
      },
    },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "New template" }));
  const d = await child("New template");
  expect(d).toHaveAccessibleDescription("For New agent.");
  await userEvent.type(await within(d).findByLabelText("Display name"), "Writer");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  await waitFor(() => expect(getSheetState().child).toBeUndefined());
  expect(field("Template")).toHaveTextContent("Writer");
  await vi.waitFor(() => expect(field("Display name").value).toBe("Writer"));
  await waitFor(() => expect(field("Template")).toHaveFocus());
});

test("on a phone, Escape in an open Add secret collapses only it and the drawer stays", async () => {
  fakeMatchMedia.install(true);
  const { dialog } = await openLead({
    details: { lead: templateDetail(templateConfig({ secrets: ["GH_TOKEN"] })) },
    ...storingSecrets(),
  });
  const trigger = await within(dialog).findByRole("button", { name: "Add secret" });
  await userEvent.click(trigger);
  const g = await inline("Add secret");
  await waitFor(() => expect(within(g).getByLabelText("Value")).toHaveFocus());
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("group", { name: "Add secret" })).toBeNull());
  expect(getSheetState().parent?.kind).toBe("new-agent");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(trigger).toHaveFocus());
});

test.each([
  ["one template", [templateSummary("lead")]],
  ["no templates", []],
])(
  "stacked New template: the Template trigger holds the new name in the commit that sets it (%s)",
  async (_l, start) => {
    const writer = templateConfig({ name: "writer", displayName: "Writer", description: "" });
    const templates = [...start];
    // What the served field shows at the moment it scrolls into view (the same commit as the value write).
    const seen: { id: string; text: string }[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      seen.push({ id: this.id, text: this.textContent ?? "" });
    });
    const { dialog } = await open({
      templates,
      details: { lead: templateDetail(templateConfig()), writer: templateDetail(writer) },
      extra: {
        "POST /api/templates": () => {
          templates.push({ ...templateSummary("writer"), displayName: "Writer" });
          return json(templateDetail(writer), 201);
        },
      },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "New template" }));
    const d = await child("New template");
    await userEvent.type(await within(d).findByLabelText("Display name"), "Writer");
    await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(getSheetState().child).toBeUndefined());
    expect(seen).toContainEqual({ id: "field-template", text: "Writer" });
  },
);
