import type { CredentialSummary, ProjectSummary, SecretSummary } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

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

type World = {
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

test("sections are Credentials, Secrets, Projects, each with its anchor and description", async () => {
  world();
  renderApp("/settings", alice);
  await section("Credentials");
  const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(["Credentials", "Secrets", "Projects"]);
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
    "Saved. @lead restarts when idle to use it. Reminders it scheduled in this session are lost.",
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
      "Saved. Granted agents restart when idle to use the new path. Reminders they scheduled in this session are lost.",
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
