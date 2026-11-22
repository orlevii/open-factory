import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { CodeTextarea } from "@/features/templates/code-textarea";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ onMessage: undefined as ((m: unknown) => void) | undefined }));
vi.mock("@/lib/ws", () => ({
  connectWs: (opts: { onMessage?(m: unknown): void }) => {
    ws.onMessage = opts.onMessage;
    return { close() {}, status: () => "open", send: () => true };
  },
}));
const emit = (m: unknown) => act(() => ws.onMessage?.(m));
afterEach(() => vi.unstubAllGlobals());

const summary = (
  p: Partial<{ name: string; errors: number; warnings: number; agentCount: number }>,
) => ({
  name: "lead",
  displayName: "Lead",
  description: "Leads",
  runtime: "local",
  errors: 0,
  warnings: 0,
  agentCount: 0,
  ...p,
});
const file = (
  f: string,
  content: string | null,
  hash: string | null = content === null ? null : `h-${f}`,
) => ({
  file: f,
  content,
  hash,
});
const detail = (issues: unknown[] = []) => ({
  template: {
    name: "lead",
    path: "/h/of/templates/lead",
    issues,
    agents: [],
    avatar: { version: null, tooLarge: false },
    config: {
      name: "lead",
      displayName: "Lead",
      description: "",
      runtime: "local",
      permissionMode: "auto",
      projects: [],
      skills: [],
      localSkills: true,
      plugins: [],
      secrets: [],
      canSpawn: [],
      maxLiveSpawns: 5,
    },
    files: [
      file("template.yaml", "name: lead\ndisplay_name: Lead\n"),
      file("AGENTS.md", "# Lead\n"),
      file("settings.json", '{\n  "a": 1\n}\n'),
      file("mcp.json", null),
    ],
  },
});
const yamlError = {
  severity: "error",
  file: "template.yaml",
  message: "Unknown field modle.",
  line: 3,
  column: 1,
};

test("list: empty state names the folder", async () => {
  mockApi({ "GET /api/templates": () => json({ dir: "/h/of/templates", templates: [] }) });
  renderApp("/templates", alice);
  expect(
    await screen.findByText(/No templates yet\. Create one, or add a folder under/),
  ).toBeInTheDocument();
  expect(screen.getByText("/h/of/templates/")).toBeInTheDocument();
});

test("rows: validation state in words and agent counts", async () => {
  mockApi({
    "GET /api/templates": () =>
      json({
        dir: "/d",
        templates: [
          summary({ name: "lead", errors: 2 }),
          summary({ name: "dev", warnings: 1, agentCount: 2 }),
        ],
      }),
  });
  renderApp("/templates", alice);
  expect(await screen.findByText("2 errors")).toBeInTheDocument();
  expect(screen.getByText("1 warning")).toBeInTheDocument();
  expect(screen.getByText("No agents")).toBeInTheDocument();
  expect(screen.getByText("2 agents")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /lead/ })).toHaveAttribute("href", "/templates/lead");
  // One line only on a wide list (its own width, not the window's: the sidebar takes 240px); below
  // that the metadata is its own line and wraps.
  const list = screen.getByRole("link", { name: /lead/ }).closest("ul") as HTMLElement;
  expect(list).toHaveClass("@container");
  // The page grid's one track can shrink, so a long images path can't widen the list with it.
  expect(list.parentElement).toHaveClass("grid-cols-[minmax(0,1fr)]");
  const meta = screen.getByText("No agents").parentElement as HTMLElement;
  expect(meta).toHaveClass("min-w-0", "flex-wrap", "basis-full", "@min-[60rem]:contents");
  expect(meta.className).not.toMatch(/(^| )md:/);
});

test("list: a failed load says so", async () => {
  mockApi({ "GET /api/templates": () => json({ error: { code: "x", message: "boom" } }, 500) });
  renderApp("/templates", alice);
  expect(await screen.findByText("Couldn't load templates.")).toBeInTheDocument();
});

test("editor: blur validates and replaces both issue lists; save with errors allowed; conflict offers Reload and Overwrite", async () => {
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [yamlError] }),
    "PUT /api/templates/lead/files/template.yaml": () =>
      json(
        {
          error: {
            code: "changed_on_disk",
            message: "Changed on disk since you opened it. Reload to see the changes.",
            currentHash: "h-new",
          },
        },
        409,
      ),
  });
  renderApp("/templates/lead", alice);
  const editor = await screen.findByRole("textbox", { name: "template.yaml" });
  await userEvent.type(editor, "modle: x\n");
  expect(api.calls.some((c) => c.url.endsWith("/validate"))).toBe(false); // never while typing
  // Tab inserts spaces inside the editor; Escape then Tab is the keyboard way out (blur).
  await userEvent.keyboard("{Escape}{Tab}");
  expect(await screen.findAllByText("Unknown field modle.")).toHaveLength(2); // panel + under the editor
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("This file changed on disk since you opened it."),
  ).toBeInTheDocument();
  api.on("PUT /api/templates/lead/files/template.yaml", (body) => {
    expect(body).toMatchObject({ baseHash: "h-new" });
    return json({ hash: "h-saved", issues: [yamlError] });
  });
  await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  expect(
    await screen.findByText("Saved. Fix the errors before creating agents from this template."),
  ).toBeInTheDocument();
});

test("editor: unsaved edits show a dot with sr-only text; Discard restores", async () => {
  mockApi({ "GET /api/templates/lead": () => json(detail()) });
  renderApp("/templates/lead", alice);
  const editor = await screen.findByRole("textbox", { name: "template.yaml" });
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
  await userEvent.type(editor, "x");
  expect(screen.getByRole("tab", { name: /template\.yaml.*\(unsaved\)/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(editor).toHaveValue("name: lead\ndisplay_name: Lead\n");
  expect(screen.queryByText("(unsaved)")).not.toBeInTheDocument();
});

test("editor: a 404 on save says the template is gone", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "PUT /api/templates/lead/files/template.yaml": () =>
      json({ error: { code: "template_not_found", message: "gone" } }, 404),
  });
  renderApp("/templates/lead", alice);
  await userEvent.type(await screen.findByRole("textbox", { name: "template.yaml" }), "x");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("This template no longer exists on disk.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to templates" })).toBeInTheDocument();
});

test("an unknown template shows the not-found state with a way back", async () => {
  mockApi({
    "GET /api/templates/nope": () =>
      json({ error: { code: "template_not_found", message: "no" } }, 404),
  });
  renderApp("/templates/nope", alice);
  expect(await screen.findByRole("link", { name: "Back to templates" })).toHaveAttribute(
    "href",
    "/templates",
  );
});

test("issue click jumps to the tab and line", async () => {
  mockApi({
    "GET /api/templates/lead": () =>
      json(
        detail([
          { severity: "error", file: "settings.json", message: "JSON: bad", line: 2, column: 3 },
        ]),
      ),
  });
  renderApp("/templates/lead", alice);
  await userEvent.click(
    await screen.findByRole("button", { name: /settings\.json.*2:3.*JSON: bad/ }),
  );
  const editor = screen.getByRole("textbox", { name: "settings.json" }) as HTMLTextAreaElement;
  expect(editor).toHaveFocus();
  expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
});

test("issues in skills or files are plain text", async () => {
  mockApi({
    "GET /api/templates/lead": () =>
      json(detail([{ severity: "warning", file: "skills", message: "Skill x has no SKILL.md." }])),
  });
  renderApp("/templates/lead", alice);
  expect(await screen.findByText("Skill x has no SKILL.md.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Skill x/ })).not.toBeInTheDocument();
});

function Harness({ onSave }: { onSave(): void }) {
  const [v, setV] = useState("");
  return (
    <>
      <CodeTextarea id="c" aria-label="code" value={v} onChange={setV} onSave={onSave} />
      <button type="button">after</button>
    </>
  );
}

test("CodeTextarea: Tab inserts two spaces; Escape then Tab leaves; Cmd+S saves", async () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  const t = screen.getByRole("textbox", { name: "code" });
  await userEvent.click(t);
  await userEvent.keyboard("a{Tab}b");
  expect(t).toHaveValue("a  b");
  await userEvent.keyboard("{Meta>}s{/Meta}");
  expect(onSave).toHaveBeenCalled();
  await userEvent.keyboard("{Escape}{Tab}");
  expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
});

test("Delete confirms and lands on the list", async () => {
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "DELETE /api/templates/lead": () => json(null, 204),
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
  });
  renderApp("/templates/lead", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete template lead?" });
  expect(dialog).toHaveTextContent(
    "Agents created from it keep their own copies, but they can't be re-synced.",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete lead" }));
  expect(await screen.findByText("Deleted lead.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
});

test("Create agent: disabled button with errors, link without", async () => {
  mockApi({ "GET /api/templates/lead": () => json(detail([yamlError])) });
  const { unmount } = renderApp("/templates/lead", alice);
  expect(await screen.findByRole("button", { name: "Create agent" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  unmount();
  mockApi({ "GET /api/templates/lead": () => json(detail()) });
  renderApp("/templates/lead", alice);
  expect(await screen.findByRole("link", { name: "Create agent" })).toHaveAttribute(
    "href",
    "/agents/new?template=lead",
  );
});

test("new template: a taken name shows the field error", async () => {
  mockApi({
    "POST /api/templates": () =>
      json(
        { error: { code: "template_exists", message: "A template named lead already exists." } },
        409,
      ),
  });
  renderApp("/templates/new", alice);
  await userEvent.type(await screen.findByLabelText("Name"), "lead");
  await userEvent.type(screen.getByLabelText("Display name"), "Lead");
  await userEvent.click(screen.getByRole("button", { name: "Create template" }));
  expect(await screen.findByText("A template named lead already exists.")).toBeInTheDocument();
});

test("new template: a name the routes use is reserved, before anything is sent", async () => {
  const api = mockApi({});
  renderApp("/templates/new", alice);
  const name = await screen.findByLabelText("Name");
  await userEvent.type(name, "images");
  await userEvent.tab();
  expect(await screen.findByText("That name is reserved.")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Display name"), "Images");
  await userEvent.click(screen.getByRole("button", { name: "Create template" }));
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
});

test("list: a folder named images or new can't be opened by URL; its row says to rename it", async () => {
  mockApi({
    "GET /api/templates": () =>
      json({
        dir: "/d",
        templates: [
          summary({ name: "images" }),
          summary({ name: "new" }),
          summary({ name: "lead" }),
        ],
      }),
  });
  renderApp("/templates", alice);
  const notes = await screen.findAllByText("Rename this folder: its name is reserved.");
  expect(notes).toHaveLength(2);
  for (const n of notes) {
    const row = n.closest("li") as HTMLElement;
    expect(within(row).queryByRole("link")).toBeNull();
  }
  expect(screen.getByRole("link", { name: /^lead/ })).toHaveAttribute("href", "/templates/lead");
});

test("template page: an oversize avatar.svg is named as ignored", async () => {
  const d = detail();
  const api = mockApi({
    "GET /api/templates/lead": () =>
      json({ template: { ...d.template, avatar: { version: null, tooLarge: true } } }),
  });
  const { unmount } = renderApp("/templates/lead", alice);
  expect(await screen.findByText("avatar.svg ignored: over 256 KB")).toBeInTheDocument();
  unmount();
  api.on("GET /api/templates/lead", () => json(detail()));
  renderApp("/templates/lead", alice);
  await screen.findByRole("textbox", { name: "template.yaml" });
  expect(screen.queryByText(/avatar\.svg ignored/)).toBeNull();
});

test("new template: blur validates the name; submit validates everything", async () => {
  const api = mockApi({});
  renderApp("/templates/new", alice);
  const name = await screen.findByLabelText("Name");
  await userEvent.type(name, "Bad Name");
  expect(screen.queryByText(/Use lowercase letters/)).not.toBeInTheDocument(); // not while typing
  await userEvent.tab();
  expect(await screen.findByText(/Use lowercase letters/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create template" }));
  expect(await screen.findByText("Enter a display name.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(name).toHaveFocus();
});

// --- review fixes ---------------------------------------------------------------------

/** A validate handler whose responses are released by hand, in any order. */
function deferredValidate() {
  const pending: { file: string; release(issues: unknown[]): void }[] = [];
  const handler = (body: unknown) =>
    new Promise<Response>((resolve) => {
      pending.push({
        file: (body as { file: string }).file,
        release: (issues) => resolve(json({ issues })),
      });
    });
  return { pending, handler };
}

test("Save works while a blur validate is still in flight", async () => {
  const v = deferredValidate();
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": v.handler,
    "PUT /api/templates/lead/files/template.yaml": () => json({ hash: "h2", issues: [] }),
  });
  renderApp("/templates/lead", alice);
  await userEvent.type(await screen.findByRole("textbox", { name: "template.yaml" }), "x");
  // The mouse click blurs the textarea first, which starts a validate that never answers.
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "PUT")).toBe(true);
});

test("a superseded validate does not leave 'Checking…' behind", async () => {
  const v = deferredValidate();
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": v.handler,
  });
  renderApp("/templates/lead", alice);
  await userEvent.type(await screen.findByRole("textbox", { name: "template.yaml" }), "x");
  await userEvent.keyboard("{Escape}{Tab}"); // validate template.yaml (A), pending
  expect(await screen.findByText("Checking…")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /settings\.json/ }));
  await userEvent.type(screen.getByRole("textbox", { name: "settings.json" }), "y");
  await userEvent.keyboard("{Escape}{Tab}"); // validate settings.json (B) supersedes A
  await vi.waitFor(() => expect(v.pending).toHaveLength(2));
  await act(async () => v.pending[1]?.release([]));
  await act(async () => v.pending[0]?.release([])); // A answers late and is stale
  await userEvent.click(screen.getByRole("tab", { name: /template\.yaml/ }));
  expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
});

test("issue rows say Error or Warning in words", async () => {
  mockApi({
    "GET /api/templates/lead": () =>
      json(
        detail([
          { severity: "warning", file: "skills", message: "Skill x has no SKILL.md." },
          { severity: "error", file: "settings.json", message: "JSON: bad", line: 2, column: 3 },
        ]),
      ),
  });
  renderApp("/templates/lead", alice);
  expect(
    await screen.findByRole("button", { name: /^Error.*settings\.json.*JSON: bad/ }),
  ).toBeInTheDocument();
  expect(screen.getByText("Warning")).toBeInTheDocument();
});

async function conflictPage() {
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [] }),
    "PUT /api/templates/lead/files/template.yaml": () =>
      json({ error: { code: "changed_on_disk", message: "x", currentHash: "h-new" } }, 409),
  });
  renderApp("/templates/lead", alice);
  const editor = await screen.findByRole("textbox", { name: "template.yaml" });
  await userEvent.type(editor, "zz");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("This file changed on disk since you opened it.");
  return { api, editor };
}

test("Reload says it discards edits and returns focus to the editor", async () => {
  const { api, editor } = await conflictPage();
  expect(screen.getByRole("button", { name: "Reload" })).toHaveAccessibleDescription(
    /discards your edits/i,
  );
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  await vi.waitFor(() => expect(editor).toHaveValue("name: lead\ndisplay_name: Lead\n"));
  expect(editor).toHaveFocus();
  expect(api.calls.filter((c) => c.method === "GET").length).toBeGreaterThan(1);
});

test("Overwrite and Discard return focus to the editor", async () => {
  const { api, editor } = await conflictPage();
  api.on("PUT /api/templates/lead/files/template.yaml", () => json({ hash: "h3", issues: [] }));
  await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  await screen.findByText("Saved.");
  expect(editor).toHaveFocus();
  await userEvent.type(editor, "q");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(editor).toHaveFocus();
});

test("'Saved.' clears once the file is edited again", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "PUT /api/templates/lead/files/template.yaml": () => json({ hash: "h2", issues: [] }),
  });
  renderApp("/templates/lead", alice);
  const editor = await screen.findByRole("textbox", { name: "template.yaml" });
  await userEvent.type(editor, "x");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  await userEvent.type(editor, "y");
  expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
});

test("Discard on a just-created optional file returns to 'Not created'", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [] }),
  });
  renderApp("/templates/lead", alice);
  await userEvent.click(await screen.findByRole("tab", { name: /mcp\.json/ }));
  await userEvent.click(screen.getByRole("button", { name: "Create file" }));
  expect(screen.getByRole("textbox", { name: "mcp.json" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByText("Not created")).toBeInTheDocument();
});

test("the keyboard hint shows on focus, also on touch", async () => {
  render(<Harness onSave={() => {}} />);
  const hint = screen.getByText("Esc then Tab to leave the editor");
  expect(hint.className).not.toMatch(/pointer:coarse/);
});

test("'Deleted x.' shows once: it is cleared from history state after it is read", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "DELETE /api/templates/lead": () => json(null, 204),
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
  });
  const { router } = renderApp("/templates/lead", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Delete…" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete lead" }),
  );
  expect(await screen.findByText("Deleted lead.")).toBeInTheDocument();
  await vi.waitFor(() =>
    expect(
      (router.state.location.state as { deletedTemplate?: string }).deletedTemplate,
    ).toBeUndefined(),
  );
  expect(screen.getByText("Deleted lead.")).toBeInTheDocument(); // still shown while mounted
});

test("saving template.yaml refreshes the header without touching what is being typed", async () => {
  const saved = detail();
  const api = mockApi({ "GET /api/templates/lead": () => json(detail()) });
  renderApp("/templates/lead", alice);
  const editor = await screen.findByRole("textbox", { name: "template.yaml" });
  expect(screen.getByText("Local")).toBeInTheDocument();
  api.on("PUT /api/templates/lead/files/template.yaml", () => {
    // The disk now says docker and a new display name; the refetch returns that.
    saved.template.config.runtime = "docker";
    saved.template.config.displayName = "Renamed Lead";
    api.on("GET /api/templates/lead", () => json(saved));
    return json({ hash: "h-saved", issues: [] });
  });
  await userEvent.type(editor, "runtime: docker\n");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  expect(await screen.findByText("Docker")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Renamed Lead" })).toBeInTheDocument();
  // The editor keeps its own state: the refetch does not reseed it.
  expect(editor).toHaveValue("name: lead\ndisplay_name: Lead\nruntime: docker\n");
});

test("the changed-on-disk block takes focus on its Reload button", async () => {
  await conflictPage();
  expect(screen.getByRole("button", { name: "Reload" })).toHaveFocus();
});

// S10 §12.8: the Image column, the template page status and the Images section.

const imagesList = (images: unknown[]) =>
  json({
    imagesDir: "/h/of/images",
    baseImage: "ghcr.io/orlevii/open-factory/base:latest",
    images,
  });
const img = (p: Record<string, unknown>) => ({ name: "playwright", usedBy: [], ...p });

test("list: the Image column shows each status as an icon and a word, plus the image name", async () => {
  const withImage = (name: string, kind: string, image: string, status: string) => ({
    ...summary({ name }),
    imageStatus: { kind, name: image, status },
  });
  mockApi({
    "GET /api/templates": () =>
      json({
        dir: "/d",
        templates: [
          withImage("t1", "user", "pw", "building"),
          withImage("t2", "user", "fl", "failed"),
          withImage("t3", "user", "od", "out_of_date"),
          withImage("t4", "user", "bu", "built"),
          withImage("t5", "user", "nb", "not_built"),
          withImage("t6", "user", "nd", "no_dockerfile"),
          withImage("t7", "user", "uk", "unknown"),
          withImage("t8", "registry", "ghcr.io/x/y:1", "present"),
          withImage("t9", "registry", "ghcr.io/x/z:1", "pulled_on_start"),
        ],
      }),
    "GET /api/images": () => imagesList([]),
  });
  renderApp("/templates", alice);
  const icon = async (word: string) => {
    const el = (await screen.findAllByText(word))[0] as HTMLElement;
    const svg = el.closest("[data-image-status]")?.querySelector("svg");
    expect(svg).not.toBeNull();
    return svg as SVGElement;
  };
  expect(await icon("Building…")).toHaveClass("text-signal");
  expect(await icon("Build failed")).toHaveClass("text-destructive");
  expect(await icon("Out of date")).toHaveClass("text-warning");
  expect(await icon("Built")).toHaveClass("text-success");
  expect(await icon("Not built")).toHaveClass("text-muted-foreground");
  expect(await icon("No Dockerfile")).toHaveClass("text-muted-foreground");
  expect(await icon("Unknown")).toHaveClass("text-muted-foreground");
  expect(await icon("Present locally")).toBeInTheDocument();
  expect(await icon("Pulled when missing")).toHaveClass("text-muted-foreground");
  expect(screen.getByText("ghcr.io/x/z:1")).toHaveClass("font-mono");
  expect(screen.getByText("pw")).toHaveClass("font-mono");
});

const brokenBuild = {
  state: "failed",
  finishedAt: new Date().toISOString(),
  durationMs: 1000,
  error: "boom",
};

test("Images section: rows show status, Used by, Build/Rebuild and Build log, never an inline log; the note", async () => {
  const api = mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/images": () =>
      imagesList([
        img({
          name: "playwright",
          status: "built",
          builtAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          usedBy: ["lead", "dev"],
        }),
        img({ name: "fresh", status: "not_built" }),
        img({ name: "broken", status: "failed", lastBuild: brokenBuild }),
      ]),
    "POST /api/images/fresh/build": () => json({ state: "building" }, 202),
    "GET /api/images/fresh/log": () => json({ state: null, lines: [] }),
  });
  renderApp("/templates/images", alice);
  const section = await screen.findByRole("region", { name: "Images" });
  const row = (name: string) =>
    within(section).getByText(name, { selector: "[data-image-name]" }).closest("li") as HTMLElement;
  await within(section).findByText("Built 2 hours ago");
  expect(within(row("playwright")).getByText("Used by lead, dev")).toBeInTheDocument();
  expect(within(row("playwright")).getByRole("button", { name: "Rebuild" })).toBeInTheDocument();
  expect(within(row("fresh")).getByRole("button", { name: "Build" })).toBeInTheDocument();
  for (const n of ["playwright", "fresh", "broken"])
    expect(within(row(n)).getByRole("button", { name: "Build log" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "View log" })).toBeNull();
  expect(
    within(section).getByText("Agents use a rebuilt image from their next start."),
  ).toBeInTheDocument();

  await userEvent.click(within(row("fresh")).getByRole("button", { name: "Build" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/images/fresh/build")).toBe(
      true,
    ),
  );
  // A row's Build doesn't grow a log under the row, or open the panel.
  expect(screen.queryByRole("log")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Build log opens a non-modal side panel that streams the build; another row's Build log retargets it; Build in its footer", async () => {
  const api = mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/images": () =>
      imagesList([
        img({ name: "broken", status: "failed", lastBuild: brokenBuild }),
        img({ name: "fresh", status: "not_built" }),
      ]),
    "GET /api/images/broken/log": () => json({ state: "failed", lines: ["step 1", "boom"] }),
    "GET /api/images/fresh/log": () => json({ state: null, lines: [] }),
    "POST /api/images/fresh/build": () => json({ state: "building" }, 202),
  });
  renderApp("/templates/images", alice);
  const section = await screen.findByRole("region", { name: "Images" });
  const row = (name: string) =>
    within(section).getByText(name, { selector: "[data-image-name]" }).closest("li") as HTMLElement;
  await within(section).findByText("fresh", { selector: "[data-image-name]" });

  const brokenTrigger = within(row("broken")).getByRole("button", { name: "Build log" });
  await userEvent.click(brokenTrigger);
  const sheet = await screen.findByRole("dialog", { name: "broken build log" });
  // A peek, not a modal: no scrim, the shortcut layer stays live, the rows stay usable.
  expect(sheet).toHaveAttribute("data-modal", "false");
  expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
  const log = within(sheet).getByRole("log");
  expect(await within(sheet).findByText(/step 1/)).toBeInTheDocument();
  expect(section.contains(log)).toBe(false);
  // The page keeps the panel's width clear while it is open (where there is room), so the rows' actions
  // stay under the pointer; the CSS applies it only from 54rem of view (browser-verified).
  expect(section).toHaveAttribute("data-log-open");

  // Frames stream into the open panel.
  emit({ type: "image_build", name: "broken", state: "building" });
  emit({ type: "image_build", name: "broken", state: "building", lines: ["Step 1/2 : FROM base"] });
  await waitFor(() =>
    expect(within(sheet).getByRole("log")).toHaveTextContent("Step 1/2 : FROM base"),
  );

  // Another row's Build log retargets the same panel node.
  await userEvent.click(within(row("fresh")).getByRole("button", { name: "Build log" }));
  expect(await screen.findByRole("dialog", { name: "fresh build log" })).toBe(sheet);
  // The body is keyed by image: a fresh log, not the last image's lines.
  await waitFor(() =>
    expect(within(sheet).getByRole("log")).toHaveAccessibleName("Build log for fresh"),
  );
  expect(within(sheet).getByRole("log")).not.toHaveTextContent("Step 1/2");

  // Build in the footer starts this image's build.
  await userEvent.click(within(sheet).getByRole("button", { name: "Build" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/images/fresh/build")).toBe(
      true,
    ),
  );

  // Closing returns focus to the row whose log was shown.
  await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(row("fresh")).getByRole("button", { name: "Build log" })).toHaveFocus();
  expect(section).not.toHaveAttribute("data-log-open");
});

test("Images section: Rebuild stays rendered but aria-disabled while building; none without a Dockerfile", async () => {
  const api = mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/images": () =>
      imagesList([
        img({ name: "busy", status: "building", builtAt: new Date().toISOString() }),
        img({ name: "empty", status: "no_dockerfile" }),
      ]),
    "GET /api/images/busy/log": () => json({ state: "building", lines: [] }),
  });
  renderApp("/templates/images", alice);
  const section = await screen.findByRole("region", { name: "Images" });
  const row = (name: string) =>
    within(section).getByText(name, { selector: "[data-image-name]" }).closest("li") as HTMLElement;
  await within(section).findByText("busy", { selector: "[data-image-name]" });
  const rebuild = within(row("busy")).getByRole("button", { name: "Rebuild" });
  expect(rebuild).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(rebuild);
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(within(row("empty")).queryByRole("button", { name: /Build/ })).toBeNull();
});

test("Images section: empty state names imagesDir and baseImage from the server", async () => {
  mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/images": () => imagesList([]),
  });
  renderApp("/templates/images", alice);
  const section = await screen.findByRole("region", { name: "Images" });
  expect(
    await within(section).findByText((_, el) =>
      el?.tagName === "P"
        ? el.textContent ===
          "No images yet. Add a Dockerfile at /h/of/images/<name>/Dockerfile, starting FROM ghcr.io/orlevii/open-factory/base:latest."
        : false,
    ),
  ).toBeInTheDocument();
});

test("Images section: an unknown status shows the Docker isn't reachable line; a failed load says so", async () => {
  const api = mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/images": () => imagesList([img({ status: "unknown" })]),
  });
  const { unmount } = renderApp("/templates/images", alice);
  expect(
    await screen.findByText(
      "Docker isn't reachable. Check that the daemon is running and the server can reach its socket.",
    ),
  ).toBeInTheDocument();
  unmount();
  api.on("GET /api/images", () => json({ error: { code: "x", message: "boom" } }, 500));
  renderApp("/templates/images", alice);
  expect(await screen.findByText("Couldn't load images.")).toBeInTheDocument();
});

test("an old /templates#images link lands on the Images view", async () => {
  mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/images": () => imagesList([]),
  });
  const { router } = renderApp("/templates#images", alice);
  await screen.findByRole("region", { name: "Images" });
  expect(router.state.location.pathname).toBe("/templates/images");
  expect(router.state.location.hash).toBe("");
});

test("Templates and Images are two views: each shows only its own content, the switch marks the current one", async () => {
  const api = mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [summary({})] }),
    "GET /api/images": () => imagesList([img({ name: "playwright", status: "built" })]),
  });
  const { router } = renderApp("/templates", alice);
  const nav = await screen.findByRole("navigation", { name: "Templates views" });
  expect(within(nav).getByRole("link", { name: "Templates" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(within(nav).getByRole("link", { name: "Images" })).not.toHaveAttribute("aria-current");
  expect(within(nav).getByRole("link", { name: "Images" })).toHaveAttribute(
    "href",
    "/templates/images",
  );
  expect(await screen.findByText("Lead")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Images" })).toBeNull();
  expect(api.calls.some((c) => c.url === "/api/images")).toBe(false);
  expect(screen.queryAllByRole("radio")).toEqual([]);

  await userEvent.click(within(nav).getByRole("link", { name: "Images" }));
  await screen.findByRole("region", { name: "Images" });
  expect(router.state.location.pathname).toBe("/templates/images");
  const nav2 = screen.getByRole("navigation", { name: "Templates views" });
  expect(within(nav2).getByRole("link", { name: "Images" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(within(nav2).getByRole("link", { name: "Templates" })).not.toHaveAttribute("aria-current");
  expect(screen.queryByText("Lead")).toBeNull();
  expect(document.title).toBe("Images · Open Factory");
});

const withUserImage = (status: string) => {
  const d = detail();
  return {
    template: {
      ...d.template,
      imageStatus: { kind: "user", name: "playwright", status },
    },
  };
};

test("template page: the image status next to image:, and Build for a not_built user image", async () => {
  const api = mockApi({
    "GET /api/templates/lead": () => json(withUserImage("not_built")),
    "POST /api/images/playwright/build": () => json({ state: "building" }, 202),
  });
  renderApp("/templates/lead", alice);
  expect(await screen.findByText("Not built")).toBeInTheDocument();
  expect(screen.getByText("image: playwright")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Build" }));
  expect(
    api.calls.some((c) => c.method === "POST" && c.url === "/api/images/playwright/build"),
  ).toBe(true);
});

test("template page: Build stays rendered but aria-disabled while building; none for unknown", async () => {
  const api = mockApi({ "GET /api/templates/lead": () => json(withUserImage("building")) });
  const { unmount } = renderApp("/templates/lead", alice);
  const build = await screen.findByRole("button", { name: "Build" });
  expect(build).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(build);
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  unmount();
  api.on("GET /api/templates/lead", () => json(withUserImage("unknown")));
  renderApp("/templates/lead", alice);
  expect(await screen.findByText("Unknown")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
});

test("template page: no Build button once the image is built", async () => {
  mockApi({ "GET /api/templates/lead": () => json(withUserImage("built")) });
  renderApp("/templates/lead", alice);
  expect(await screen.findByText("Built")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
});

test("editor: the warm_window_minutes hint shows the live factory default", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "GET /api/settings/factory": () =>
      json({
        maxRunningAgents: 8,
        defaultWarmWindowMinutes: 45,
        memberUpdateDebounceSeconds: 60,
        allowLocalRuntime: false,
        updatedAt: null,
        updatedBy: null,
      }),
  });
  renderApp("/templates/lead", alice);
  const hint = await screen.findByText("Omit to use the factory default (45 min).");
  // Tied to the template.yaml textarea, not only placed next to it.
  const textarea = screen.getByRole("textbox", { name: "template.yaml" });
  const describedBy = textarea.getAttribute("aria-describedby")?.split(" ") ?? [];
  expect(describedBy).toContain((hint.closest("p") as HTMLElement).id);
});

test("Save reads 'Saving…' while the PUT is pending", async () => {
  let release: () => void = () => {};
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [] }),
    "PUT /api/templates/lead/files/template.yaml": () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(json({ hash: "h2", issues: [] }));
      }),
  });
  renderApp("/templates/lead", alice);
  await userEvent.type(await screen.findByRole("textbox", { name: "template.yaml" }), "x");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("button", { name: "Saving…" })).toBeInTheDocument();
  await act(async () => release());
  expect(await screen.findByText("Saved.")).toBeInTheDocument();
});

test("list header (class contract, jsdom has no layout): the h1 gives way to the switch below a 25rem header; New template goes icon-only below sm, keeping its name and a tooltip", async () => {
  mockApi({ "GET /api/templates": () => json({ dir: "/d", templates: [] }) });
  renderApp("/templates", alice);
  const h1 = await screen.findByRole("heading", { level: 1, name: "Templates" });
  // The header is the @container: visible from 25rem of header width, sr-only (still the page's h1) below.
  expect(h1).toHaveClass("@max-[25rem]:sr-only");
  expect(h1).not.toHaveClass("sr-only");
  expect(h1.closest("header")).toHaveClass("@container");
  // Neither the switch nor the action shrinks or wraps (the h1 gives way instead).
  const nav = screen.getByRole("navigation", { name: "Templates views" });
  expect(nav).toHaveClass("shrink-0");
  const link = screen.getByRole("link", { name: "New template" });
  expect(link).toHaveAttribute("aria-label", "New template");
  expect(link).toHaveAttribute("href", "/templates/new");
  const label = within(link).getByText("New template");
  expect(label).toHaveClass("max-sm:sr-only");
  expect(link.parentElement).toHaveClass("shrink-0");
  await userEvent.hover(link);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("New template");
});
