import {
  type CredentialSummary,
  MSG,
  type ProjectSummary,
  type SecretSummary,
} from "@open-factory/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TOASTER_LABEL } from "@/components/ui/toaster";
import { getSheetState, resetSheets } from "@/features/sheets/sheet-store";
import { endAnimation } from "@/test/end-animation";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { longPress } from "@/test/long-press";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

const agentRow = (slug: string) => agentSummary({ slug, displayName: slug });

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => {
  resetSheets();
  vi.unstubAllGlobals();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const cred = (o: Partial<CredentialSummary> = {}): CredentialSummary => ({
  name: "work",
  kind: "oauth_token",
  lastVerifiedAt: hoursAgo(2),
  lastError: null,
  expiresAt: null,
  rejected: false,
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
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/or" }),
    "GET /api/credentials": () => json({ credentials: state.credentials }),
    "GET /api/secrets": () => json({ secrets: state.secrets }),
    "GET /api/projects": () => json({ projects: state.projects }),
    ...w.extra,
  });
  return { api, state };
}
const settingsCalls = (api: { calls: { method: string; url: string }[] }) =>
  api.calls
    .filter((c) =>
      /^\/api\/(credentials|secrets|projects|users|invites|settings\/factory)$/.test(c.url),
    )
    .map((c) => `${c.method} ${c.url}`);
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

test("add credential: method radios, a password field, Verifying…, a rejected token under the field, then the row", async () => {
  let release: (r: Response) => void = () => {};
  const { api, state } = world({
    extra: {
      "POST /api/credentials": () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    },
  });
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  await userEvent.click(within(region).getByRole("button", { name: "Add credential" }));
  expect(within(region).getByLabelText("Name")).toHaveFocus();
  await userEvent.click(within(region).getByRole("radio", { name: "Paste a token" }));
  expect(within(region).getByRole("radio", { name: "Paste a token" })).toBeChecked();
  expect(within(region).getByRole("radio", { name: "Paste an API key" })).not.toBeChecked();
  const name = within(region).getByLabelText("Name");
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
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  await userEvent.click(within(region).getByRole("button", { name: "Add credential" }));
  await userEvent.type(within(region).getByLabelText("Name"), "work");
  await userEvent.click(within(region).getByRole("radio", { name: "Paste an API key" }));
  const key = within(region).getByLabelText("Key");
  await userEvent.type(key, "sk-ant");
  await userEvent.click(within(region).getByRole("button", { name: "Verify and add" }));
  const note = await within(region).findByText("Couldn't reach Claude to verify. Try again.");
  expect(note).toBeInTheDocument();
  expect(key).not.toHaveAttribute("aria-invalid");
  expect(describedText(key)).toContain("Couldn't reach Claude to verify. Try again.");
  expect(key).toHaveValue("sk-ant");
});

test("Replace token: an unverifiable check warns under the token and announces a failure line", async () => {
  world({
    credentials: [cred({ name: "work" })],
    extra: {
      "PUT /api/credentials/work/value": () =>
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
  renderApp("/settings/credentials", alice);
  const u = userEvent.setup();
  const creds = await section("Credentials");
  await waitFor(() => expect(row(creds, "work")).toBeDefined());
  await u.click(within(row(creds, "work")).getByRole("button", { name: "Actions for work" }));
  await u.click(await screen.findByRole("menuitem", { name: "Replace token" }));
  const token = within(creds).getByLabelText("New token");
  await u.type(token, "sk-new");
  await u.click(within(creds).getByRole("button", { name: "Verify and save" }));
  const line = await within(creds).findByText("Couldn't replace the token.");
  expect(line.closest("[role=alert]")).not.toBeNull();
  expect(describedText(token)).toContain("Couldn't reach Claude to verify. Try again.");
  expect(token).not.toHaveAttribute("aria-invalid");
  expect(token).toHaveValue("sk-new");
});

test("Replace token and Update value validate on blur of a changed field", async () => {
  world({
    credentials: [cred({ name: "work" })],
    secrets: [secret({ name: "GH_TOKEN" })],
  });
  renderApp("/settings/credentials", alice);
  const u = userEvent.setup();
  const creds = await section("Credentials");
  await waitFor(() => expect(row(creds, "work")).toBeDefined());
  await u.click(within(row(creds, "work")).getByRole("button", { name: "Actions for work" }));
  await u.click(await screen.findByRole("menuitem", { name: "Replace token" }));
  const token = within(creds).getByLabelText("New token");
  await u.type(token, "a");
  await u.clear(token);
  await u.tab();
  expect(describedText(token)).toBe("Enter the token.");
});

test("Update value validates on blur of a changed field", async () => {
  world({ secrets: [secret({ name: "GH_TOKEN" })] });
  renderApp("/settings/secrets", alice);
  const u = userEvent.setup();
  const region = await section("Secrets");
  await waitFor(() => expect(row(region, "GH_TOKEN")).toBeDefined());
  await u.click(within(row(region, "GH_TOKEN")).getByRole("button", { name: "Update" }));
  const value = within(region).getByLabelText("New value");
  await u.type(value, "a");
  await u.clear(value);
  await u.tab();
  expect(describedText(value)).toBe("Enter a value.");
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
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  expect(row(region, "work")).toHaveTextContent("Used by @lead");
  expect(row(region, "old")).toHaveTextContent("Last check failed: Claude rejected this token.");
  expect(row(region, "old")).toHaveTextContent("Not used · archived: @c");
  // §6.3 names Verify as a secondary (outline) action; the icon-only menu trigger stays ghost.
  expect(within(row(region, "work")).getByRole("button", { name: "Verify" })).toHaveAttribute(
    "data-variant",
    "outline",
  );
  // Decision 20: a section-header action sits inside its section, so it is ghost.
  expect(within(region).getByRole("button", { name: "Add credential" })).toHaveAttribute(
    "data-variant",
    "ghost",
  );
  expect(within(row(region, "work")).getByRole("link", { name: "@lead" })).toHaveAttribute(
    "href",
    "/agents/lead/chat",
  );

  await userEvent.click(
    within(row(region, "work")).getByRole("button", { name: "Actions for work" }),
  );
  expect(screen.getByRole("menuitem", { name: "Replace token" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Delete (used by @lead)" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("menuitem", { name: "Delete (used by @lead)" })).toHaveAttribute(
    "data-variant",
    "destructive",
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
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  await userEvent.click(
    within(row(region, "work")).getByRole("button", { name: "Actions for work" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete credential work?" });
  expect(dialog).toHaveTextContent(
    "Its token is erased and can't be shown again. To use it later, add it again with Sign in with Claude.",
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
  renderApp("/settings/credentials", alice);
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
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  // The agent's handle opens Edit agent over Settings, where the fix is made.
  const handle = within(alert).getByRole("button", { name: "@lead" });
  expect(handle).toHaveAttribute("type", "button");
  await userEvent.click(handle);
  expect(getSheetState().parent).toMatchObject({ kind: "edit-agent", slug: "lead" });
});

test("secrets are write-only rows; Update saves a new value and says who restarts", async () => {
  const { api } = world({
    secrets: [secret({ name: "GH_TOKEN", usedBy: ["lead"] })],
    extra: {
      "PUT /api/secrets/GH_TOKEN": () =>
        json({ secret: secret({ name: "GH_TOKEN", usedBy: ["lead"] }) }),
    },
  });
  renderApp("/settings/secrets", alice);
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
  renderApp("/settings/secrets", alice);
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
  renderApp("/settings/secrets?addSecret=GH_TOKEN", alice);
  const region = await section("Secrets");
  await waitFor(() => expect(within(region).getByLabelText("Value")).toHaveFocus());
  expect(within(region).getByLabelText("Name")).toHaveValue("GH_TOKEN");
});

test("?addSecret brings the add form into view after the navigation's scroll reset", async () => {
  // jsdom has no layout: record the order of the router's reset (window.scrollTo) and the form's
  // scrollIntoView; the form must be the last thing scrolled, or the reset hides it again.
  const scrolls: string[] = [];
  const reset = vi.spyOn(window, "scrollTo").mockImplementation(() => scrolls.push("reset"));
  const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    scrolls.push(this.getAttribute("aria-label") ?? this.tagName);
  });
  try {
    world();
    renderApp("/settings/secrets?addSecret=GH_TOKEN", alice);
    const region = await section("Secrets");
    await waitFor(() => expect(within(region).getByLabelText("Value")).toHaveFocus());
    await waitFor(() => expect(scrolls).toContain("reset"));
    await waitFor(() => expect(scrolls.at(-1)).toBe("Add secret"));
  } finally {
    reset.mockRestore();
    into.mockRestore();
  }
});

test("opening the add form with its button scrolls nothing itself", async () => {
  const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  try {
    world();
    renderApp("/settings/secrets", alice);
    const region = await section("Secrets");
    await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
    expect(within(region).getByLabelText("Name")).toHaveFocus();
    expect(into).not.toHaveBeenCalled();
  } finally {
    into.mockRestore();
  }
});

test("the secret name is uppercased while typing, keeping the caret; reserved names error on blur", async () => {
  world();
  renderApp("/settings/secrets", alice);
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
  expect(describedText(name)).toBe("That name is reserved.");
});

test("projects: a middle-truncated path, grant wording, and Remove disabled with its reason", async () => {
  world({
    projects: [
      project({ name: "app", grantedTo: ["a"], archivedGrantedTo: ["c"] }),
      project({ name: "docs", hostPath: "/srv/docs" }),
    ],
  });
  renderApp("/settings/projects", alice);
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
  expect(screen.getByRole("menuitem", { name: "Remove (granted to @a)" })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
});

test.each([false, true])(
  "credentials: a Delete blocked by many agents names three and counts the rest (drawer %s)",
  async (phone) => {
    const original = window.matchMedia;
    if (phone) fakeMatchMedia.install(true, { coarse: true });
    try {
      const many = ["ada", "bob", "ceo", ...Array.from({ length: 211 }, (_, i) => `agent-${i}`)];
      world({
        credentials: [
          cred({ name: "work", usedBy: many }),
          cred({ name: "old", archivedUsedBy: many.slice(0, 5) }),
          cred({ name: "few", usedBy: ["ada", "bob", "ceo"] }),
        ],
      });
      renderApp("/settings/credentials", alice);
      const region = await section("Credentials");
      await waitFor(() => expect(row(region, "work")).toBeDefined());
      const item = phone ? "button" : "menuitem";
      const open = async (name: string) => {
        const t = within(row(region, name)).getByRole("button", { name: `Actions for ${name}` });
        if (phone) {
          fireEvent.pointerDown(t, { button: 0, pointerType: "touch" });
          fireEvent.click(t);
          return screen.findByRole("dialog", { name });
        }
        await userEvent.click(t);
        return screen.findByRole("menu");
      };
      const close = async (surface: HTMLElement) => {
        if (phone) {
          fireEvent.click(within(surface).getByRole("button", { name: "Cancel" }));
          endAnimation(surface);
          await waitFor(() =>
            expect(document.querySelector("[data-slot=drawer-content]")).toBeNull(),
          );
        } else await userEvent.keyboard("{Escape}");
      };
      let surface = await open("work");
      expect(
        within(surface).getByRole(item, { name: "Delete (used by @ada, @bob, @ceo +211 more)" }),
      ).toHaveAttribute("aria-disabled", "true");
      await close(surface);
      surface = await open("old");
      expect(
        within(surface).getByRole(item, {
          name: "Delete (archived @ada, @bob, @ceo +2 more still use it)",
        }),
      ).toBeInTheDocument();
      await close(surface);
      surface = await open("few");
      expect(
        within(surface).getByRole(item, { name: "Delete (used by @ada, @bob, @ceo)" }),
      ).toBeInTheDocument();
      // The row's own Usage line still names everyone.
      expect(row(region, "work")).toHaveTextContent("@agent-210");
    } finally {
      window.matchMedia = original;
    }
  },
);

test("projects: the loader asks for host info, and the page renders when it 404s", async () => {
  const { api } = world({
    projects: [project({ name: "app" })],
    extra: {
      "GET /api/host": () => json({ error: { code: "not_found", message: "Not found." } }, 404),
    },
  });
  renderApp("/settings/projects", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  expect(api.calls.some((c) => c.url === "/api/host")).toBe(true);
});

test("projects: a Remove blocked by many grantees names three and counts the rest", async () => {
  world({
    projects: [project({ name: "app", grantedTo: ["a", "b", "c", "d", "e"] })],
  });
  renderApp("/settings/projects", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  await userEvent.click(
    within(row(region, "app")).getByRole("button", { name: "Actions for app" }),
  );
  expect(
    screen.getByRole("menuitem", { name: "Remove (granted to @a, @b, @c +2 more)" }),
  ).toHaveAttribute("aria-disabled", "true");
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
  renderApp("/settings/projects", alice);
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
  renderApp("/settings/projects", alice);
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
  renderApp("/settings/projects", alice);
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

test("Change path has the help button, accepts ~/x, and Esc in the popover keeps the form open", async () => {
  const { api } = world({
    projects: [project({ name: "app" })],
    extra: {
      "PATCH /api/projects/app": (body) =>
        json({
          project: project({ name: "app", hostPath: (body as { hostPath: string }).hostPath }),
        }),
    },
  });
  renderApp("/settings/projects", alice);
  const region = await section("Projects");
  await waitFor(() => expect(row(region, "app")).toBeDefined());
  await userEvent.click(
    within(row(region, "app")).getByRole("button", { name: "Actions for app" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Change path" }));
  const help = await within(region).findByRole("button", { name: "How do I find this path?" });
  await userEvent.click(help);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const path = within(region).getByLabelText("Path");
  expect(path).toBeInTheDocument();
  await userEvent.clear(path);
  await userEvent.type(path, "~/x");
  await userEvent.click(within(region).getByRole("button", { name: "Save path" }));
  await waitFor(() =>
    expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ hostPath: "~/x" }),
  );
});

test.each([
  ["Shift+Tab", () => userEvent.keyboard("{Shift>}{Tab}{/Shift}")],
  [
    "a click",
    () => userEvent.click(screen.getByRole("button", { name: "How do I find this path?" })),
  ],
])(
  "Change path (AC6): moving from a half-typed Path to the help by %s flags nothing",
  async (_, toHelp) => {
    world({ projects: [project({ name: "app" })] });
    renderApp("/settings/projects", alice);
    const region = await section("Projects");
    await waitFor(() => expect(row(region, "app")).toBeDefined());
    await userEvent.click(
      within(row(region, "app")).getByRole("button", { name: "Actions for app" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Change path" }));
    const path = within(region).getByLabelText("Path");
    await waitFor(() => expect(path).toHaveFocus());
    await userEvent.clear(path);
    await userEvent.type(path, "code");
    await toHelp();
    expect(path).not.toHaveAttribute("aria-invalid");
    expect(describedText(path)).not.toContain(MSG.hostPathStart);
    // Control: tabbing from Path to Save path (not a skip target) does flag it.
    await userEvent.click(path);
    await userEvent.tab();
    expect(within(region).getByRole("button", { name: "Save path" })).toHaveFocus();
    await waitFor(() => expect(path).toHaveAttribute("aria-invalid", "true"));
    expect(describedText(path)).toBe(MSG.hostPathStart);
  },
);

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
  renderApp("/settings/projects", alice);
  const region = await section("Projects");
  await userEvent.click(within(region).getByRole("button", { name: "Add project" }));
  await userEvent.type(within(region).getByLabelText("Name"), "app");
  const path = within(region).getByLabelText("Path");
  expect(describedText(path)).toBe("A folder on the factory's machine, like ~/code/web.");
  expect(
    within(region).getByRole("button", { name: "How do I find this path?" }),
  ).toBeInTheDocument();
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
  renderApp("/settings/projects", alice);
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

test("Add secret waits for the secrets list: a failed load shows no add button or form", async () => {
  mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/secrets": () => json({ error: { code: "internal", message: "boom" } }, 500),
    "GET /api/projects": () => json({ projects: [] }),
  });
  renderApp("/settings/secrets?addSecret=GH_TOKEN", alice);
  const region = await section("Secrets");
  expect(within(region).queryByRole("button", { name: "Add secret" })).not.toBeInTheDocument();
  expect(within(region).queryByLabelText("Name")).not.toBeInTheDocument();
});

test("a failing section shows its own error line, with Retry", async () => {
  let fail = true;
  world({
    extra: {
      "GET /api/credentials": () =>
        fail
          ? json({ error: { code: "internal", message: "boom" } }, 500)
          : json({ credentials: [cred()] }),
    },
  });
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  const text = await within(region).findByText("Couldn't load credentials.");
  const line = text.parentElement as HTMLElement;
  const icon = line.querySelector("svg");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(icon).toHaveClass("text-destructive");
  // The route loader's failure is the section's error, never the route's.
  expect(screen.queryByText("Couldn't load settings.")).not.toBeInTheDocument();
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
  renderApp("/settings/secrets", alice);
  expect(
    await within(await section("Secrets")).findByText("Couldn't load secrets."),
  ).toBeInTheDocument();
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", {
      name: "Projects",
    }),
  );
  expect(
    await within(await section("Projects")).findByText("Couldn't load projects."),
  ).toBeInTheDocument();
});

test("rate-limit lines refetch every minute while the Credentials page is open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { api } = world();
    renderApp("/settings/credentials", alice);
    await section("Credentials");
    const count = (url: string) => api.calls.filter((c) => c.url === url).length;
    const creds = count("/api/credentials");
    vi.advanceTimersByTime(60_000);
    await waitFor(() => expect(count("/api/credentials")).toBe(creds + 1));
  } finally {
    vi.useRealTimers();
  }
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
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeInTheDocument());
  expect(row(region, "work")).toHaveTextContent("No rate-limit data yet");
  expect(row(region, "paused")).toHaveTextContent(/Rate-limited until .*\d\d:\d\d/);
  expect(row(region, "fine")).toHaveTextContent("Within limits · seen 5 minutes ago");
});

test("a later ?addSecret updates the open add form and refocuses the value field", async () => {
  world();
  const { router } = renderApp("/settings/secrets?addSecret=GH_TOKEN", alice);
  const region = await section("Secrets");
  await waitFor(() => expect(within(region).getByLabelText("Value")).toHaveFocus());
  await userEvent.click(within(region).getByLabelText("Name"));
  await router.navigate({ to: "/settings/secrets", search: { addSecret: "NPM_TOKEN" } });
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
              message: "That name is reserved.",
            },
          },
          409,
        ),
    },
  });
  renderApp("/settings/secrets", alice);
  const region = await section("Secrets");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  await userEvent.type(within(region).getByLabelText("Name"), "MY_VAR");
  await userEvent.type(within(region).getByLabelText("Value"), "v");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  const name = within(region).getByLabelText("Name");
  await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(name)).toBe("That name is reserved.");
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
  renderApp("/settings/secrets", alice);
  const region = await section("Secrets");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  await userEvent.type(within(region).getByLabelText("Name"), "MY_VAR");
  await userEvent.type(within(region).getByLabelText("Value"), "v");
  await userEvent.click(within(region).getByRole("button", { name: "Add secret" }));
  const name = within(region).getByLabelText("Name");
  await waitFor(() => expect(describedText(name)).toBe("Name is bad."));
  expect(name).toHaveFocus();
});

test.each([
  ["/settings/credentials", ["GET /api/credentials"]],
  ["/settings/secrets", ["GET /api/secrets"]],
  ["/settings/projects", ["GET /api/projects"]],
  ["/settings/users", ["GET /api/users", "GET /api/invites"]],
  ["/settings/factory", ["GET /api/settings/factory"]],
])("%s loads only its own queries", async (path, expected) => {
  const { api } = world({
    extra: {
      "GET /api/users": () => json({ users: [] }),
      "GET /api/invites": () => json({ invites: [] }),
      "GET /api/settings/factory": () =>
        json({
          maxRunningAgents: 8,
          defaultWarmWindowMinutes: 70,
          memberUpdateDebounceSeconds: 30,
          allowLocalRuntime: false,
          updatedAt: null,
          updatedBy: null,
        }),
    },
  });
  renderApp(path, alice);
  await screen.findByRole("navigation", { name: "Settings" });
  await waitFor(() => expect(settingsCalls(api)).toEqual(expect.arrayContaining(expected)));
  await screen.findByRole("region", { name: (n) => !n.startsWith(TOASTER_LABEL) });
  // Not deduplicated: the loader fetches, and the section skips its own mount fetch.
  expect(settingsCalls(api).sort()).toEqual([...expected].sort());
});

test("a hover preload warms a list once; entering the page then reuses it", async () => {
  const { api } = world({ credentials: [cred()] });
  const { router } = renderApp("/settings/secrets", alice);
  await section("Secrets");
  api.calls.length = 0;
  await router.preloadRoute({ to: "/settings/credentials" });
  expect(settingsCalls(api)).toEqual(["GET /api/credentials"]);
  await router.preloadRoute({ to: "/settings/credentials" });
  expect(settingsCalls(api)).toEqual(["GET /api/credentials"]);
});

test("sub-nav lists the five pages; the current one is aria-current with the selected fill and medium weight", async () => {
  world();
  renderApp("/settings/projects", alice);
  const nav = await screen.findByRole("navigation", { name: "Settings" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((l) => l.textContent)).toEqual([
    "Credentials",
    "Secrets",
    "Projects",
    "Users",
    "Factory",
  ]);
  const current = links.filter((l) => l.getAttribute("aria-current") === "page");
  expect(current.map((l) => l.textContent)).toEqual(["Projects"]);
  expect(current[0]).toHaveClass("font-medium");
  // The current page takes the selected fill (one step past hover) and keeps it under the pointer.
  expect(current[0]).toHaveClass("bg-selected");
  expect(current[0]?.className).not.toMatch(/hover:bg-accent/);
  // Its text is not muted: a muted class in the base would beat the active one by CSS order.
  expect(current[0]).not.toHaveClass("text-muted-foreground");
  const users = links.find((l) => l.textContent === "Users");
  expect(users).not.toHaveClass("font-medium");
  expect(users).not.toHaveClass("bg-selected");
  expect(users?.className).toMatch(/hover:bg-accent/);
  expect(users).toHaveClass("text-muted-foreground");
  await userEvent.click(within(nav).getByRole("link", { name: "Secrets" }));
  expect(await section("Secrets")).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: "Secrets" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("below a 40rem content width the sub-nav is a Section select", async () => {
  world();
  renderApp("/settings/secrets", alice);
  const nav = await screen.findByRole("navigation", { name: "Settings" });
  // jsdom has no layout: the container query is checked through its classes (browser pass for the real width).
  expect(nav.className).toMatch(/hidden/);
  expect(nav.className).toMatch(/@min-\[53\.75rem\]:block/);
  const select = screen.getByRole("combobox", { name: "Section" });
  expect(select.closest("div")?.className).toMatch(/@min-\[53\.75rem\]:hidden/);
  expect(select).toHaveTextContent("Secrets");
  await userEvent.click(select);
  await userEvent.click(await screen.findByRole("option", { name: "Projects" }));
  expect(await section("Projects")).toBeInTheDocument();
});

test("/settings/secrets?addSecret=GH_TOKEN opens the add form with the name", async () => {
  world();
  renderApp("/settings/secrets?addSecret=GH_TOKEN", alice);
  const region = await section("Secrets");
  expect(within(region).getByLabelText("Name")).toHaveValue("GH_TOKEN");
});

test.each([
  ["credentials", "Credentials", "work", ["Replace token", "Delete…"]],
  ["projects", "Projects", "app", ["Change path", "Remove"]],
] as const)(
  "phone: a %s row's menu is a drawer titled with its name",
  async (path, name, item, items) => {
    const original = window.matchMedia;
    fakeMatchMedia.install(true, { coarse: true });
    try {
      world({ credentials: [cred({ name: "work" })], projects: [project({ name: "app" })] });
      renderApp(`/settings/${path}`, alice);
      const region = await section(name);
      await waitFor(() => expect(row(region, item)).toBeDefined());
      const trigger = within(row(region, item)).getByRole("button", {
        name: `Actions for ${item}`,
      });
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
      fireEvent.click(trigger);
      const drawer = await screen.findByRole("dialog", { name: item });
      for (const label of items)
        expect(within(drawer).getByRole("button", { name: label })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  },
);

test.each([
  ["credentials", "Credentials", "work"],
  ["projects", "Projects", "app"],
] as const)(
  "touch: a 500ms press on a %s row opens its menu at the point",
  async (path, name, item) => {
    world({ credentials: [cred({ name: "work" })], projects: [project({ name: "app" })] });
    renderApp(`/settings/${path}`, alice);
    const region = await section(name);
    await waitFor(() => expect(row(region, item)).toBeDefined());
    const li = row(region, item);
    expect(li).toHaveAttribute("data-longpress-region");
    longPress(within(li).getByText(item), { x: 15, y: 35 });
    expect(await screen.findByRole("menu", { name: item })).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>("[data-menu-stand-in].size-0")?.style.top).toBe(
      "35px",
    );
    // The ⋯ still opens it from its own edge afterwards.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await userEvent.click(within(li).getByRole("button", { name: `Actions for ${item}` }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(document.querySelector("[data-menu-stand-in].size-0")).toBeNull();
  },
);

test.each([
  ["credentials", "Credentials", "work", false],
  ["projects", "Projects", "app", false],
  ["credentials", "Credentials", "work", true],
  ["projects", "Projects", "app", true],
] as const)(
  "touch: closing a long-pressed %s row's menu returns focus to its ⋯, not <body> (%s %s, drawer %s)",
  async (path, name, item, phone) => {
    const original = window.matchMedia;
    if (phone) fakeMatchMedia.install(true, { coarse: true });
    try {
      world({ credentials: [cred({ name: "work" })], projects: [project({ name: "app" })] });
      renderApp(`/settings/${path}`, alice);
      const region = await section(name);
      await waitFor(() => expect(row(region, item)).toBeDefined());
      const li = row(region, item);
      longPress(within(li).getByText(item), { x: 15, y: 35 });
      if (phone) {
        const drawer = await screen.findByRole("dialog", { name: item });
        fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
        endAnimation(drawer);
        await waitFor(() =>
          expect(document.querySelector("[data-slot=drawer-content]")).toBeNull(),
        );
      } else {
        fireEvent.keyDown(await screen.findByRole("menu", { name: item }), { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      }
      await waitFor(() =>
        expect(within(li).getByRole("button", { name: `Actions for ${item}` })).toHaveFocus(),
      );
    } finally {
      window.matchMedia = original;
    }
  },
);

test("a press that starts in a row's inline field never opens the menu", async () => {
  world({ credentials: [cred({ name: "work" })] });
  renderApp("/settings/credentials", alice);
  const region = await section("Credentials");
  await waitFor(() => expect(row(region, "work")).toBeDefined());
  const u = userEvent.setup();
  await u.click(within(row(region, "work")).getByRole("button", { name: "Actions for work" }));
  await u.click(await screen.findByRole("menuitem", { name: /Replace/ }));
  const field = await waitFor(() => {
    const input = row(region, "work").querySelector("input");
    expect(input).not.toBeNull();
    return input as HTMLInputElement;
  });
  longPress(field);
  expect(screen.queryByRole("menu")).toBeNull();
});
