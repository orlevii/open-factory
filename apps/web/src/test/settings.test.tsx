import type {
  AgentUsageRow,
  CredentialSummary,
  CredentialUsageRow,
  ProjectSummary,
  SecretSummary,
  Totals,
} from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

const agentRow = (slug: string) => agentSummary({ slug, displayName: slug });

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const cred = (o: Partial<CredentialSummary> = {}): CredentialSummary => ({
  name: "work",
  kind: "oauth_token",
  lastVerifiedAt: hoursAgo(2),
  lastError: null,
  usedBy: [],
  archivedUsedBy: [],
  rateLimit: null,
  ...o,
});
const secret = (o: Partial<SecretSummary> = {}): SecretSummary => ({
  name: "GH_TOKEN",
  updatedAt: hoursAgo(3),
  usedBy: [],
  ...o,
});
const project = (o: Partial<ProjectSummary> = {}): ProjectSummary => ({
  name: "app",
  hostPath: "/Users/or/code/app",
  grantedTo: [],
  archivedGrantedTo: [],
  templates: [],
  ...o,
});

const totals = (o: Partial<Totals> = {}): Totals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
  ...o,
});
function daily(n: number, cost = 0.5, turns = 1) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 20 - (n - 1 - i)));
    return { date: d.toISOString().slice(0, 10), ...totals({ costUsd: cost, turns }) };
  });
}
const usageRow = (o: Partial<AgentUsageRow> & { slug: string }): AgentUsageRow => ({
  displayName: o.slug,
  kind: "persistent",
  archived: false,
  terminated: false,
  own: totals(),
  total: o.own ?? totals(),
  ...o,
});
const credUsage = (o: Partial<CredentialUsageRow> = {}): CredentialUsageRow => ({
  name: "work",
  kind: "oauth_token",
  totals: totals(),
  agents: [],
  rateLimit: null,
  ...o,
});
type UsageWorld = {
  daily?: ReturnType<typeof daily>;
  agents?: AgentUsageRow[];
  credentials?: CredentialUsageRow[];
};

type World = {
  usage?: UsageWorld;
  credentials?: CredentialSummary[];
  secrets?: SecretSummary[];
  projects?: ProjectSummary[];
  extra?: Record<string, Handler>;
};
/** Lists are live arrays: mutation handlers push or splice, and the refetch sees it. */
function world(w: World = {}) {
  const state = {
    credentials: w.credentials ?? [],
    secrets: w.secrets ?? [],
    projects: w.projects ?? [],
  };
  const api = mockApi({
    "GET /api/credentials": () => json({ credentials: state.credentials }),
    "GET /api/secrets": () => json({ secrets: state.secrets }),
    "GET /api/projects": () => json({ projects: state.projects }),
    "GET /api/usage/daily?": () =>
      json({ timezone: "Europe/Berlin", days: w.usage?.daily ?? daily(30, 0, 0) }),
    "GET /api/usage/agents?": () => json({ agents: w.usage?.agents ?? [] }),
    "GET /api/usage/credentials?": () =>
      json({ credentials: w.usage?.credentials ?? [], unattributed: totals() }),
    ...w.extra,
  });
  return { api, state };
}
const section = (name: string) => screen.findByRole("region", { name });
const row = (region: HTMLElement, name: string) =>
  within(region)
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("data-name") === name) as HTMLElement;
const describedText = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

test("sections are Usage, Credentials, Secrets, Projects, Users, Factory, each with its anchor", async () => {
  world();
  renderApp("/settings", alice);
  await section("Credentials");
  const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(["Usage", "Credentials", "Secrets", "Projects", "Users", "Factory"]);
  for (const id of ["usage", "credentials", "secrets", "projects", "users", "factory"]) {
    expect(document.getElementById(id)?.tagName).toBe("SECTION");
  }
  expect(document.getElementById("credentials")).toHaveTextContent(
    "Claude logins agents use. Each agent picks one.",
  );
  expect(document.getElementById("secrets")).toHaveTextContent(
    "Environment variables agents receive when their template lists them. Values can't be viewed after saving.",
  );
  expect(document.getElementById("projects")).toHaveTextContent(
    "Folders on this machine that agents can be granted. Granted agents see them at ./projects/<name>.",
  );
  expect(screen.queryByText("Nothing to configure yet.")).not.toBeInTheDocument();
});

test("add credential: kind radios, a password field, Verifying…, a rejected token under the field, then the row", async () => {
  let release: (r: Response) => void = () => {};
  const { api, state } = world({
    extra: {
      "POST /api/credentials": () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  await userEvent.click(within(region).getByRole("button", { name: "Add credential" }));
  const name = within(region).getByLabelText("Name");
  expect(name).toHaveFocus();
  expect(within(region).getByRole("radio", { name: /OAuth token/ })).toBeChecked();
  expect(within(region).getByRole("radio", { name: "API key" })).not.toBeChecked();
  const token = within(region).getByLabelText("Token");
  expect(token).toHaveAttribute("type", "password");
  expect(token).toHaveAttribute("autocomplete", "new-password");
  await userEvent.type(name, "work");
  await userEvent.type(token, "sk-bad");
  await userEvent.click(within(region).getByRole("button", { name: "Verify and add" }));
  expect(await within(region).findByRole("button", { name: /Verifying…/ })).toBeInTheDocument();
  release(
    json(
      {
        error: {
          code: "credential_rejected",
          message: "Claude rejected this token. Create a new one with `claude setup-token`.",
        },
      },
      422,
    ),
  );
  await waitFor(() => expect(token).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(token)).toBe(
    "Claude rejected this token. Create a new one with claude setup-token.",
  );
  expect(token).toHaveFocus();
  // Second try succeeds.
  api.on("POST /api/credentials", (body) => {
    const c = cred({ name: (body as { name: string }).name });
    state.credentials.push(c);
    return json({ credential: c }, 201);
  });
  await userEvent.clear(token);
  await userEvent.type(token, "sk-good");
  await userEvent.click(within(region).getByRole("button", { name: "Verify and add" }));
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  expect(row(region, "work")).toHaveTextContent("OAuth token");
  expect(row(region, "work")).toHaveTextContent("Verified 2 hours ago");
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "work",
    kind: "oauth_token",
    value: "sk-bad",
  });
});

test("add credential: an unverifiable check is a warning, not a bad token", async () => {
  world({
    extra: {
      "POST /api/credentials": () =>
        json(
          {
            error: {
              code: "credential_unverifiable",
              message: "Couldn't reach Claude to verify. Try again.",
            },
          },
          422,
        ),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  await userEvent.click(within(region).getByRole("button", { name: "Add credential" }));
  await userEvent.type(within(region).getByLabelText("Name"), "work");
  await userEvent.click(within(region).getByRole("radio", { name: "API key" }));
  const key = within(region).getByLabelText("Key");
  await userEvent.type(key, "sk-ant");
  await userEvent.click(within(region).getByRole("button", { name: "Verify and add" }));
  const note = await within(region).findByText("Couldn't reach Claude to verify. Try again.");
  expect(note.closest("[role=alert]")).not.toBeNull();
  expect(key).not.toHaveAttribute("aria-invalid");
  expect(describedText(key)).toContain("Couldn't reach Claude to verify. Try again.");
  expect(key).toHaveValue("sk-ant");
});

test("credential row: Verify visible, Replace token and Delete… in the menu; used ones can't be deleted", async () => {
  const { api } = world({
    credentials: [
      cred({ name: "work", usedBy: ["lead"] }),
      cred({ name: "old", archivedUsedBy: ["c"], lastError: "Claude rejected this token." }),
      cred({ name: "spare" }),
    ],
    extra: {
      "POST /api/credentials/spare/verify": () => json({ credential: cred({ name: "spare" }) }),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  expect(row(region, "work")).toHaveTextContent("Used by @lead");
  expect(row(region, "old")).toHaveTextContent("Last check failed: Claude rejected this token.");
  expect(row(region, "old")).toHaveTextContent("Not used · archived: @c");
  expect(within(row(region, "work")).getByRole("link", { name: "@lead" })).toHaveAttribute(
    "href",
    "/agents/lead",
  );

  await userEvent.click(
    within(row(region, "work")).getByRole("button", { name: "Actions for work" }),
  );
  expect(screen.getByRole("menuitem", { name: "Replace token" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Delete (used by @lead)" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await userEvent.keyboard("{Escape}");

  await userEvent.click(
    within(row(region, "old")).getByRole("button", { name: "Actions for old" }),
  );
  expect(
    screen.getByRole("menuitem", { name: "Delete (archived @c still uses it)" }),
  ).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");

  await userEvent.click(within(row(region, "spare")).getByRole("button", { name: "Verify" }));
  expect(await within(region).findByText("Verified.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/credentials/spare/verify")).toBe(true);
});

test("deleting an unused credential confirms, then calls DELETE", async () => {
  const { api, state } = world({
    credentials: [cred({ name: "work" })],
    extra: {
      "DELETE /api/credentials/work": () => {
        state.credentials = [];
        return json(null, 204);
      },
    },
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  await userEvent.click(
    within(row(region, "work")).getByRole("button", { name: "Actions for work" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete credential work?" });
  expect(dialog).toHaveTextContent(
    "Its token is erased and can't be shown again. To use it later, create a new one with claude setup-token.",
  );
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete work" }));
  expect(await within(region).findByText("Deleted work.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "DELETE" && c.url === "/api/credentials/work")).toBe(
    true,
  );
});

test("a credential taken while the dialog was open shows a crimson row line linking the agents", async () => {
  world({
    credentials: [cred({ name: "work" })],
    extra: {
      "DELETE /api/credentials/work": () =>
        json(
          {
            error: {
              code: "credential_in_use",
              message: "Used by @lead. Change their credential first.",
              usedBy: ["lead"],
              archivedUsedBy: [],
            },
          },
          409,
        ),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  await userEvent.click(
    within(row(region, "work")).getByRole("button", { name: "Actions for work" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete work" }),
  );
  await within(row(region, "work")).findByText(/Change their credential first\./);
  const alert = within(row(region, "work"))
    .getAllByRole("alert")
    .find((a) => a.textContent?.includes("Change their credential first.")) as HTMLElement;
  expect(alert).toHaveTextContent("Used by @lead. Change their credential first.");
  expect(within(alert).getByRole("link", { name: "@lead" })).toHaveAttribute(
    "href",
    "/agents/lead/edit",
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
});

test("secrets are write-only rows; Update saves a new value and says who restarts", async () => {
  const { api } = world({
    secrets: [secret({ name: "GH_TOKEN", usedBy: ["lead"] })],
    extra: {
      "PUT /api/secrets/GH_TOKEN": () =>
        json({ secret: secret({ name: "GH_TOKEN", usedBy: ["lead"] }) }),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Secrets");
  await waitFor(() => expect(row(region, "GH_TOKEN")).toBeDefined());
  const r = row(region, "GH_TOKEN");
  expect(r).toHaveTextContent("Set");
  expect(r).toHaveTextContent("updated 3 hours ago");
  expect(r).toHaveTextContent("Used by @lead");
  await userEvent.click(within(r).getByRole("button", { name: "Update" }));
  const value = within(region).getByLabelText("New value");
  expect(value).toHaveAttribute("type", "password");
  expect(value).toHaveFocus();
  await userEvent.type(value, "ghp_new");
  await userEvent.click(within(region).getByRole("button", { name: "Save value" }));
  const line = await within(region).findByText(
    "Saved. @lead restarts when idle to use it. Its crons from this session stop.",
  );
  expect(line.closest("[tabindex='-1']")).toHaveFocus();
  expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({ value: "ghp_new" });
  expect(within(region).queryByDisplayValue("ghp_new")).not.toBeInTheDocument();
});

test("Delete… on a secret confirms with the agents that lose it", async () => {
  const { api } = world({
    secrets: [secret({ name: "GH_TOKEN", usedBy: ["lead", "dev-1"] })],
    extra: { "DELETE /api/secrets/GH_TOKEN": () => json(null, 204) },
  });
  renderApp("/settings", alice);
  const region = await section("Secrets");
  await waitFor(() => expect(row(region, "GH_TOKEN")).toBeDefined());
  await userEvent.click(within(row(region, "GH_TOKEN")).getByRole("button", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete secret GH_TOKEN?" });
  expect(dialog).toHaveTextContent(
    "Its value is erased. @lead and @dev-1 restart when idle without it and won't start until you add it again.",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete GH_TOKEN" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.method === "DELETE" && c.url === "/api/secrets/GH_TOKEN")).toBe(
      true,
    ),
  );
});

test("?addSecret=GH_TOKEN opens the add form with the name filled and the value focused", async () => {
  world();
  renderApp("/settings?addSecret=GH_TOKEN#secrets", alice);
  const region = await section("Secrets");
  await waitFor(() => expect(within(region).getByLabelText("Value")).toHaveFocus());
  expect(within(region).getByLabelText("Name")).toHaveValue("GH_TOKEN");
});

test("the secret name is uppercased while typing, keeping the caret; reserved names error on blur", async () => {
  world();
  renderApp("/settings", alice);
  const region = await section("Secrets");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  const name = within(region).getByLabelText("Name") as HTMLInputElement;
  expect(name).toHaveFocus();
  await userEvent.type(name, "ghtoken");
  expect(name).toHaveValue("GHTOKEN");
  name.setSelectionRange(2, 2);
  await userEvent.type(name, "_x", { initialSelectionStart: 2, initialSelectionEnd: 2 });
  expect(name).toHaveValue("GH_XTOKEN");
  expect(name.selectionStart).toBe(4);
  await userEvent.clear(name);
  await userEvent.type(name, "path");
  expect(name).not.toHaveAttribute("aria-invalid");
  await userEvent.tab();
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(describedText(name)).toBe("That name is reserved for the agent's environment.");
});

test("projects: a middle-truncated path, grant wording, and Remove disabled with its reason", async () => {
  world({
    projects: [
      project({ name: "app", grantedTo: ["a"], archivedGrantedTo: ["c"] }),
      project({ name: "docs", hostPath: "/srv/docs" }),
    ],
  });
  renderApp("/settings", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  const r = row(region, "app");
  expect(within(r).getByText("/Users/or/code/app")).toHaveClass("sr-only");
  expect(r).toHaveTextContent("Granted to @a · archived: @c");
  expect(row(region, "docs")).toHaveTextContent("Not granted");
  await userEvent.click(within(r).getByRole("button", { name: "Actions for app" }));
  expect(screen.getByRole("menuitem", { name: "Change path" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Remove (granted to @a)" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("projects: a live spawned grantee is named through its spawner in Remove's reason", async () => {
  world({
    projects: [project({ name: "app", grantedTo: ["tech-lead-ab12"] })],
    extra: {
      "GET /api/agents?ended=exclude": () =>
        json({
          agents: [
            { ...agentRow("lead"), kind: "persistent", reportsTo: null },
            { ...agentRow("tech-lead-ab12"), kind: "ephemeral", reportsTo: "lead" },
          ],
          running: { count: 0, max: 8 },
        }),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  await userEvent.click(
    within(row(region, "app")).getByRole("button", { name: "Actions for app" }),
  );
  expect(
    await screen.findByRole("menuitem", {
      name: "Remove (granted to @tech-lead-ab12, spawned by @lead)",
    }),
  ).toHaveAttribute("aria-disabled", "true");
});

test("removing an unused project offers Undo, notes its templates, and Undo re-adds it", async () => {
  const { api, state } = world({
    projects: [project({ name: "app", templates: ["tech-lead"] })],
    extra: {
      "DELETE /api/projects/app": () => {
        state.projects = [];
        return json(null, 204);
      },
      "POST /api/projects": () => {
        const p = project({ name: "app", templates: ["tech-lead"] });
        state.projects = [p];
        return json({ project: p }, 201);
      },
    },
  });
  renderApp("/settings", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  await userEvent.click(
    within(row(region, "app")).getByRole("button", { name: "Actions for app" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  const undo = await within(region).findByRole("button", { name: "Undo" });
  await waitFor(() => expect(undo).toHaveFocus());
  const line = undo.parentElement as HTMLElement;
  expect(line).toHaveTextContent(
    "Removed app. Template tech-lead now shows an error until you remove the project from it or add it back.",
  );
  await userEvent.click(undo);
  expect(await within(region).findByText("Restored app.")).toBeInTheDocument();
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "app",
    hostPath: "/Users/or/code/app",
  });
});

test("Change path saves with the restart warning; a missing folder is a field error", async () => {
  world({
    projects: [project({ name: "app", grantedTo: ["a"] })],
    extra: {
      "PATCH /api/projects/app": (body) => {
        const hostPath = (body as { hostPath: string }).hostPath;
        return hostPath === "/x"
          ? json(
              {
                error: {
                  code: "validation_error",
                  message: "No folder at /x.",
                  fields: { hostPath: "No folder at /x." },
                },
              },
              400,
            )
          : json({ project: project({ name: "app", hostPath, grantedTo: ["a"] }) });
      },
    },
  });
  renderApp("/settings", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  await userEvent.click(
    within(row(region, "app")).getByRole("button", { name: "Actions for app" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Change path" }));
  const path = within(region).getByLabelText("Path");
  await waitFor(() => expect(path).toHaveFocus());
  await userEvent.clear(path);
  await userEvent.type(path, "/x");
  await userEvent.click(within(region).getByRole("button", { name: "Save path" }));
  await waitFor(() => expect(path).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(path)).toBe("No folder at /x.");
  await userEvent.clear(path);
  await userEvent.type(path, "/srv/app");
  await userEvent.click(within(region).getByRole("button", { name: "Save path" }));
  expect(
    await within(region).findByText(
      "Saved. Granted agents restart when idle to use the new path. Their crons from this session stop.",
    ),
  ).toBeInTheDocument();
});

test("add project: a missing folder lands under Path, then the row appears", async () => {
  const { api, state } = world({
    extra: {
      "POST /api/projects": () =>
        json(
          {
            error: {
              code: "validation_error",
              message: "No folder at /x.",
              fields: { hostPath: "No folder at /x." },
            },
          },
          400,
        ),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Projects");
  await userEvent.click(within(region).getByRole("button", { name: "Add project" }));
  await userEvent.type(within(region).getByLabelText("Name"), "app");
  const path = within(region).getByLabelText("Path");
  expect(describedText(path)).toBe(
    "Absolute path to a folder on this machine, usually a git repository.",
  );
  await userEvent.type(path, "/x");
  await userEvent.click(within(region).getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(path).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(path)).toBe("No folder at /x.");
  expect(path).toHaveFocus();
  api.on("POST /api/projects", (body) => {
    const p = project({ ...(body as { name: string; hostPath: string }) });
    state.projects.push(p);
    return json({ project: p }, 201);
  });
  await userEvent.clear(path);
  await userEvent.type(path, "/Users/or/code/app");
  await userEvent.click(within(region).getByRole("button", { name: "Add project" }));
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  expect(await within(region).findByText("Added app.")).toBeInTheDocument();
});

test("inline forms focus their first field; Cancel and Escape return focus to the opener", async () => {
  world();
  renderApp("/settings", alice);
  const region = await section("Projects");
  const add = within(region).getByRole("button", { name: "Add project" });
  await userEvent.click(add);
  expect(within(region).getByLabelText("Name")).toHaveFocus();
  await userEvent.click(within(region).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(within(region).getByRole("button", { name: "Add project" })).toHaveFocus(),
  );
  await userEvent.click(within(region).getByRole("button", { name: "Add project" }));
  await userEvent.type(within(region).getByLabelText("Path"), "/tmp");
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(within(region).getByRole("button", { name: "Add project" })).toHaveFocus(),
  );
  expect(within(region).queryByLabelText("Path")).not.toBeInTheDocument();
});

test("#projects focuses the Projects heading once the sections load", async () => {
  world();
  renderApp("/settings#projects", alice);
  const heading = await screen.findByRole("heading", { level: 2, name: "Projects" });
  await waitFor(() => expect(heading).toHaveFocus());
});

test("Add secret waits for the secrets list: a failed load shows no add button or form", async () => {
  mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/secrets": () => json({ error: { code: "internal", message: "boom" } }, 500),
    "GET /api/projects": () => json({ projects: [] }),
  });
  renderApp("/settings?addSecret=GH_TOKEN#secrets", alice);
  const region = await section("Secrets");
  expect(within(region).queryByRole("button", { name: "Add secret" })).not.toBeInTheDocument();
  expect(within(region).queryByLabelText("Name")).not.toBeInTheDocument();
});

test("a failing section shows only its own error line, with Retry; the others render", async () => {
  let fail = true;
  world({
    secrets: [secret()],
    extra: {
      "GET /api/credentials": () =>
        fail
          ? json({ error: { code: "internal", message: "boom" } }, 500)
          : json({ credentials: [cred()] }),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  const text = await within(region).findByText("Couldn't load credentials.");
  const line = text.parentElement as HTMLElement;
  const icon = line.querySelector("svg");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(icon).toHaveClass("text-destructive");
  expect(screen.queryByText("Couldn't load settings.")).not.toBeInTheDocument();
  expect(screen.queryByText(/Couldn't load (secrets|projects|usage)\./)).not.toBeInTheDocument();
  expect(row(await section("Secrets"), "GH_TOKEN")).toBeInTheDocument();
  expect(
    await within(await section("Projects")).findByText("No projects yet."),
  ).toBeInTheDocument();
  fail = false;
  await userEvent.click(within(line).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(row(region, "work")).toBeInTheDocument());
  expect(within(region).queryByText("Couldn't load credentials.")).not.toBeInTheDocument();
});

test("secrets and projects show their own error lines", async () => {
  world({
    extra: {
      "GET /api/secrets": () => json({ error: { code: "internal", message: "boom" } }, 500),
      "GET /api/projects": () => json({ error: { code: "internal", message: "boom" } }, 500),
    },
  });
  renderApp("/settings", alice);
  expect(
    await within(await section("Secrets")).findByText("Couldn't load secrets."),
  ).toBeInTheDocument();
  expect(
    await within(await section("Projects")).findByText("Couldn't load projects."),
  ).toBeInTheDocument();
  expect(within(await section("Credentials")).getByText("No credentials yet.")).toBeInTheDocument();
});

test("On this page links all six anchors; #usage focuses the Usage heading", async () => {
  world();
  renderApp("/settings#usage", alice);
  const nav = await screen.findByRole("navigation", { name: "On this page" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((l) => l.textContent)).toEqual([
    "Usage",
    "Credentials",
    "Secrets",
    "Projects",
    "Users",
    "Factory",
  ]);
  expect(links.map((l) => l.getAttribute("href")?.replace(/^.*#/, "#"))).toEqual([
    "#usage",
    "#credentials",
    "#secrets",
    "#projects",
    "#users",
    "#factory",
  ]);
  const heading = await screen.findByRole("heading", { level: 2, name: "Usage" });
  await waitFor(() => expect(heading).toHaveFocus());
});

const leadFamily = (): AgentUsageRow[] => [
  usageRow({
    slug: "writer",
    own: totals({ costUsd: 0.5, turns: 4 }),
    total: totals({ costUsd: 0.5, turns: 4 }),
  }),
  usageRow({
    slug: "lead",
    own: totals({ costUsd: 1.2, turns: 12 }),
    spawned: totals({ costUsd: 3.4, turns: 29 }),
    total: totals({ costUsd: 4.6, turns: 41 }),
  }),
  ...["lead-a1", "lead-b2", "lead-c3"].map((slug, i) =>
    usageRow({
      slug,
      kind: "ephemeral",
      spawnerSlug: "lead",
      terminated: i === 0,
      own: totals({ costUsd: 1 + i * 0.2, turns: 9 + i }),
      total: totals({ costUsd: 1 + i * 0.2, turns: 9 + i }),
    }),
  ),
  ...Array.from({ length: 8 }, (_, i) => usageRow({ slug: `idle-${i}` })),
];

test("Usage: range, Daily chart, estimate line, and the Agents table sorted by total", async () => {
  const api = world({ usage: { daily: daily(30), agents: leadFamily() } }).api;
  renderApp("/settings", alice);
  const region = await section("Usage");
  expect(within(region).getByRole("radio", { name: "30 days" })).toBeChecked();
  expect(
    await within(region).findByRole("heading", { level: 3, name: "Daily" }),
  ).toBeInTheDocument();
  expect(within(region).getByText("30 days to today, in Europe/Berlin.")).toBeInTheDocument();
  expect(
    within(region).getByText(
      "Estimated at API prices. A subscription is billed by plan, not per token.",
    ),
  ).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/usage/agents?days=30")).toBe(true);

  const table = within(region).getByRole("table", { name: "Agents" });
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual(["Agent", "Turns", "Own (est.)", "Spawned (est.)", "Total (est.)"]);
  const bodyRows = within(table).getAllByRole("row").slice(1);
  // lead (4.60) before writer (0.50); the children are collapsed behind the disclosure.
  expect(bodyRows[0]).toHaveTextContent("@lead");
  expect(bodyRows[0]).toHaveTextContent("$1.20");
  expect(bodyRows[0]).toHaveTextContent("$3.40");
  expect(bodyRows[0]).toHaveTextContent("$4.60");
  const lead = within(table).getByRole("link", { name: "@lead" });
  expect(lead).toHaveAttribute("href", "/agents/lead/usage");
  expect(within(table).queryByText("@lead-a1")).not.toBeInTheDocument();

  const disclosure = within(table).getByRole("button", { name: "Show 3 spawned agents of @lead" });
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const child = within(table).getByRole("link", { name: "@lead-c3" });
  expect(child).toHaveAttribute("href", "/agents/lead-c3/usage");
  const childRow = child.closest("tr") as HTMLElement;
  const cells = within(childRow).getAllByRole("cell");
  // Agent, turns, own, spawned (blank), total.
  expect(cells[2]).toHaveTextContent("$1.40");
  expect(cells[3]).toHaveTextContent(/^$/);
  expect(cells[4]).toHaveTextContent("$1.40");
  expect(within(table).getByText("@writer").closest("tr")).toHaveTextContent("$0.50");
});

test("Usage: agents with no usage fold into one row with Show", async () => {
  world({ usage: { daily: daily(30), agents: leadFamily() } });
  renderApp("/settings", alice);
  const region = await section("Usage");
  const table = await within(region).findByRole("table", { name: "Agents" });
  expect(within(table).queryByText("@idle-0")).not.toBeInTheDocument();
  const fold = within(table).getByText("8 agents with no usage").closest("tr") as HTMLElement;
  const show = within(fold).getByRole("button", { name: "Show" });
  expect(show).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(show);
  expect(within(table).getByRole("link", { name: "@idle-7" })).toHaveAttribute(
    "href",
    "/agents/idle-7/usage",
  );
});

test("Usage: the Credentials table with cost, top agents and the rate-limit line", async () => {
  world({
    usage: {
      daily: daily(30),
      agents: leadFamily(),
      credentials: [
        credUsage({
          totals: totals({ costUsd: 4.12, turns: 30 }),
          agents: [
            { slug: "lead", costUsd: 3 },
            { slug: "writer", costUsd: 1.12 },
          ],
          rateLimit: {
            status: "allowed_warning",
            type: "five_hour",
            utilization: 0.82,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
            observedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        }),
      ],
    },
  });
  renderApp("/settings", alice);
  const region = await section("Usage");
  const table = await within(region).findByRole("table", { name: "Credentials" });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Name", "Kind", "Cost (est.)", "Top agents", "Rate limit"]);
  const r = within(table).getAllByRole("row")[1] as HTMLElement;
  expect(r).toHaveTextContent("work");
  expect(r).toHaveTextContent("OAuth token");
  expect(r).toHaveTextContent("$4.12");
  expect(within(r).getByRole("link", { name: "@lead" })).toHaveAttribute(
    "href",
    "/agents/lead/usage",
  );
  expect(r).toHaveTextContent("82% of the 5-hour limit used");
});

test("Usage: all-zero days show the empty line instead of the chart; credentials stay", async () => {
  world({
    usage: {
      daily: daily(30, 0, 0),
      agents: [usageRow({ slug: "lead" })],
      credentials: [credUsage()],
    },
  });
  renderApp("/settings", alice);
  const region = await section("Usage");
  expect(await within(region).findByText("No usage in the last 30 days.")).toBeInTheDocument();
  expect(within(region).queryByText("30 days to today, in Europe/Berlin.")).not.toBeInTheDocument();
  const table = within(region).getByRole("table", { name: "Credentials" });
  expect(table).toHaveTextContent("work");
  expect(table).toHaveTextContent("No rate-limit data yet");
});

test("Usage: ?days=7 asks for 7 days and a range switch keeps the page", async () => {
  const { api } = world({ usage: { daily: daily(7), agents: leadFamily() } });
  const { router } = renderApp("/settings?days=7", alice);
  const region = await section("Usage");
  expect(within(region).getByRole("radio", { name: "7 days" })).toBeChecked();
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/usage/daily?days=7")).toBe(true),
  );
  await userEvent.click(within(region).getByRole("radio", { name: "90 days" }));
  await waitFor(() => expect(router.state.location.search).toEqual({ days: 90 }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/usage/credentials?days=90")).toBe(true),
  );
});

test("a failing usage query shows Couldn't load usage. in its section only", async () => {
  world({
    extra: {
      "GET /api/usage/agents?": () => json({ error: { code: "internal", message: "boom" } }, 500),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Usage");
  expect(await within(region).findByText("Couldn't load usage.")).toBeInTheDocument();
  expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(within(await section("Credentials")).getByText("No credentials yet.")).toBeInTheDocument();
});

test("credential rows show the rate-limit line", async () => {
  const until = new Date(Date.now() + 2 * 3_600_000);
  world({
    credentials: [
      cred({ name: "work", rateLimit: null }),
      cred({ name: "paused", rateLimit: null, pausedUntil: until.toISOString(), pauseExact: true }),
      cred({
        name: "fine",
        rateLimit: {
          status: "allowed",
          type: "five_hour",
          utilization: 0.1,
          resetsAt: null,
          observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      }),
    ],
  });
  renderApp("/settings", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeInTheDocument());
  expect(row(region, "work")).toHaveTextContent("No rate-limit data yet");
  expect(row(region, "paused")).toHaveTextContent(/Rate-limited until .*\d\d:\d\d/);
  expect(row(region, "fine")).toHaveTextContent("Within limits · seen 5 minutes ago");
});

test("a later ?addSecret updates the open add form and refocuses the value field", async () => {
  world();
  const { router } = renderApp("/settings?addSecret=GH_TOKEN#secrets", alice);
  const region = await section("Secrets");
  await waitFor(() => expect(within(region).getByLabelText("Value")).toHaveFocus());
  await userEvent.click(within(region).getByLabelText("Name"));
  await router.navigate({ to: "/settings", search: { addSecret: "NPM_TOKEN" }, hash: "secrets" });
  await waitFor(() => expect(within(region).getByLabelText("Name")).toHaveValue("NPM_TOKEN"));
  await waitFor(() => expect(within(region).getByLabelText("Value")).toHaveFocus());
});

test("add secret: 409 secret_name_reserved lands under Name and focuses it", async () => {
  world({
    extra: {
      "PUT /api/secrets/MY_VAR": () =>
        json(
          {
            error: {
              code: "secret_name_reserved",
              message: "That name is reserved for the agent's environment.",
            },
          },
          409,
        ),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Secrets");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  await userEvent.type(within(region).getByLabelText("Name"), "MY_VAR");
  await userEvent.type(within(region).getByLabelText("Value"), "v");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  const name = within(region).getByLabelText("Name");
  await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(name)).toBe("That name is reserved for the agent's environment.");
  expect(name).toHaveFocus();
  expect(within(region).queryByRole("alert", { name: /reserved/ })).not.toBeInTheDocument();
});

test("add secret: server fields land under their fields, whatever the code", async () => {
  world({
    extra: {
      "PUT /api/secrets/MY_VAR": () =>
        json(
          { error: { code: "secret_invalid", message: "Bad.", fields: { name: "Name is bad." } } },
          409,
        ),
    },
  });
  renderApp("/settings", alice);
  const region = await section("Secrets");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  await userEvent.type(within(region).getByLabelText("Name"), "MY_VAR");
  await userEvent.type(within(region).getByLabelText("Value"), "v");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  const name = within(region).getByLabelText("Name");
  await waitFor(() => expect(describedText(name)).toBe("Name is bad."));
  expect(name).toHaveFocus();
});
