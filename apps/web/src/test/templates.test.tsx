import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearDraft } from "@/features/sheets/drafts";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import { CodeTextarea } from "@/features/templates/code-textarea";
import { fakeMatchMedia } from "@/test/fake-match-media";
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
beforeEach(() => {
  fakeMatchMedia.install(false);
  clearDraft("new-template");
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

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
      secrets: [],
      canSpawn: [],
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

// jsdom has no Range geometry; a focused CodeMirror measures its cursor and selection with it.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/** The file's CodeMirror content, once the lazy chunk has replaced the textarea fallback. */
const editorFor = (name: string) =>
  waitFor(() => {
    const el = screen.getByRole("textbox", { name });
    expect(el).toHaveClass("cm-content");
    return el;
  });
const viewOf = (el: HTMLElement) => EditorView.findFromDOM(el) as EditorView;
const docOf = (el: HTMLElement) => viewOf(el).state.doc.toString();
/** Focuses the editor and types at the end of the doc as a user edit would (jsdom has no real
 *  contenteditable input, nor the Range geometry userEvent.type would make CodeMirror measure). */
const typeInto = (el: HTMLElement, text: string) => {
  const v = viewOf(el);
  act(() => el.focus());
  act(() =>
    v.dispatch({ changes: { from: v.state.doc.length, insert: text }, userEvent: "input.type" }),
  );
};

/** Esc then Tab out of the focused editor. CodeMirror reads both by keyCode, which userEvent leaves
 *  at 0, so they're fired directly; Tab must go unhandled, and as jsdom has no default action for
 *  it, the focus move itself is the test's. */
const leaveEditor = () => {
  const el = document.activeElement as HTMLElement;
  expect(el).toHaveClass("cm-content");
  fireEvent.keyDown(el, { key: "Escape", code: "Escape", keyCode: 27 });
  expect(fireEvent.keyDown(el, { key: "Tab", code: "Tab", keyCode: 9 })).toBe(true); // not prevented
  act(() => el.blur());
};

/** A valid template opens on Configuration (I2 §12.5): these tests are about the file tabs, so open template.yaml. */
async function openTemplate(path = "/templates/lead") {
  const utils = renderApp(path, alice);
  await userEvent.click(await screen.findByRole("tab", { name: /template\.yaml/ }));
  return utils;
}

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
  await openTemplate();
  const editor = await editorFor("template.yaml");
  typeInto(editor, "modle: x\n");
  expect(api.calls.some((c) => c.url.endsWith("/validate"))).toBe(false); // never while typing
  // Tab inserts spaces inside the editor; Escape then Tab is the keyboard way out (blur).
  leaveEditor();
  expect(await screen.findAllByText("Unknown field modle.")).toHaveLength(2); // panel + under the editor
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
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
  await openTemplate();
  const editor = await editorFor("template.yaml");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  typeInto(editor, "x");
  expect(screen.getByRole("tab", { name: /template\.yaml.*\(unsaved\)/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(docOf(editor)).toBe("name: lead\ndisplay_name: Lead\n");
  expect(screen.queryByText("(unsaved)")).not.toBeInTheDocument();
});

test("editor: a 404 on save says the template is gone", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "PUT /api/templates/lead/files/template.yaml": () =>
      json({ error: { code: "template_not_found", message: "gone" } }, 404),
  });
  await openTemplate();
  typeInto(await editorFor("template.yaml"), "x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
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

test("issues in skills or files are plain text", async () => {
  mockApi({
    "GET /api/templates/lead": () =>
      json(detail([{ severity: "warning", file: "skills", message: "Skill x has no SKILL.md." }])),
  });
  await openTemplate();
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

test("Create agent: disabled with errors, else it opens New agent with the template", async () => {
  mockApi({ "GET /api/templates/lead": () => json(detail([yamlError])) });
  const { unmount } = await openTemplate();
  expect(await screen.findByRole("button", { name: "Create agent" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  unmount();
  mockApi({ "GET /api/templates/lead": () => json(detail()) });
  const { router } = await openTemplate();
  const create = await screen.findByRole("button", { name: "Create agent" });
  expect(create).not.toHaveAttribute("aria-disabled");
  await userEvent.click(create);
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent", template: "lead" });
  expect(router.state.location.pathname).toBe("/templates/lead");
});

/** The dialog once its lazy body has rendered. */
async function sheetOf() {
  const d = await screen.findByRole("dialog", { name: "New template" });
  await within(d).findByLabelText("Display name");
  return d;
}
const emptyList = { "GET /api/templates": () => json({ dir: "/d", templates: [] }) };

test("list: a folder named new can't be opened by URL; its row says to rename it", async () => {
  mockApi({
    "GET /api/templates": () =>
      json({
        dir: "/d",
        templates: [summary({ name: "new" }), summary({ name: "lead" })],
      }),
  });
  renderApp("/templates", alice);
  const notes = await screen.findAllByText("Rename this folder: its name is reserved.");
  expect(notes).toHaveLength(1);
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
  const { unmount } = await openTemplate();
  expect(await screen.findByText("avatar.svg ignored: over 256 KB")).toBeInTheDocument();
  unmount();
  api.on("GET /api/templates/lead", () => json(detail()));
  await openTemplate();
  await editorFor("template.yaml");
  expect(screen.queryByText(/avatar\.svg ignored/)).toBeNull();
});

test("new template: /templates/new lands on the list with the sheet open", async () => {
  mockApi(emptyList);
  const { router } = renderApp("/templates/new", alice);
  await sheetOf();
  // The page behind a modal sheet is inert, so it is not in the accessibility tree.
  expect(
    await screen.findByRole("heading", { level: 1, name: "Templates", hidden: true }),
  ).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/templates");
});

test("new template: success closes the sheet and opens the editor", async () => {
  mockApi({
    ...emptyList,
    "POST /api/templates": () => json(detail(), 201),
    "GET /api/templates/lead": () => json(detail()),
  });
  renderApp("/templates", alice);
  await userEvent.click(await screen.findByRole("button", { name: "New template" }));
  const d = await sheetOf();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  expect(within(d).getByText("templates/lead")).toBeInTheDocument();
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  // A valid template opens on its Configuration tab (I2 §12.5).
  expect(await screen.findByRole("tab", { name: "Configuration" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("dialog", { name: "New template" })).toBeNull();
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
  await openTemplate();
  typeInto(await editorFor("template.yaml"), "x");
  // The mouse click blurs the textarea first, which starts a validate that never answers.
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Saved.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "PUT")).toBe(true);
});

test("a superseded validate does not leave 'Checking…' behind", async () => {
  const v = deferredValidate();
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": v.handler,
  });
  await openTemplate();
  typeInto(await editorFor("template.yaml"), "x");
  leaveEditor(); // validate template.yaml (A), pending
  expect(await screen.findByText("Checking…")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /settings\.json/ }));
  typeInto(await editorFor("settings.json"), "y");
  leaveEditor(); // validate settings.json (B) supersedes A
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
  await openTemplate();
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
  await openTemplate();
  const editor = await editorFor("template.yaml");
  typeInto(editor, "zz");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("This file changed on disk since you opened it.");
  return { api, editor };
}

test("Overwrite and Discard return focus to the editor", async () => {
  const { api, editor } = await conflictPage();
  api.on("PUT /api/templates/lead/files/template.yaml", () => json({ hash: "h3", issues: [] }));
  await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  await screen.findByText("Saved.");
  expect(editor).toHaveFocus();
  typeInto(editor, "q");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(editor).toHaveFocus();
});

test("'Saved.' clears once the file is edited again", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "PUT /api/templates/lead/files/template.yaml": () => json({ hash: "h2", issues: [] }),
  });
  await openTemplate();
  const editor = await editorFor("template.yaml");
  typeInto(editor, "x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved.");
  typeInto(editor, "y");
  expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
});

test("Discard on a just-created optional file returns to 'Not created'", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [] }),
  });
  await openTemplate();
  await userEvent.click(await screen.findByRole("tab", { name: /mcp\.json/ }));
  await userEvent.click(screen.getByRole("button", { name: "Create file" }));
  expect(screen.getByRole("textbox", { name: "mcp.json" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByText("Not created")).toBeInTheDocument();
});

test("Delete confirms and lands on the list; 'Deleted x.' shows once: it is cleared from history state after it is read", async () => {
  const api = mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "DELETE /api/templates/lead": () => json(null, 204),
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
  });
  const { router } = await openTemplate();
  await userEvent.click(await screen.findByRole("button", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete template lead?" });
  expect(dialog).toHaveTextContent("This deletes the folder");
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete lead" }));
  expect(await screen.findByText("Deleted lead.")).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
  expect(router.state.location.pathname).toBe("/templates");
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
  await openTemplate();
  const editor = await editorFor("template.yaml");
  expect(screen.getByText("Local")).toBeInTheDocument();
  api.on("PUT /api/templates/lead/files/template.yaml", () => {
    // The disk now says docker and a new display name; the refetch returns that.
    saved.template.config.runtime = "docker";
    saved.template.config.displayName = "Renamed Lead";
    api.on("GET /api/templates/lead", () => json(saved));
    return json({ hash: "h-saved", issues: [] });
  });
  typeInto(editor, "runtime: docker\n");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved.");
  expect(await screen.findByText("Docker")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Renamed Lead" })).toBeInTheDocument();
  // The editor keeps its own state: the refetch does not reseed it.
  expect(docOf(editor)).toBe("name: lead\ndisplay_name: Lead\nruntime: docker\n");
});

test("editor: the warm_window_minutes hint shows the live factory default", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "GET /api/settings/factory": () =>
      json({
        warmWindowMinutes: 45,
        memberUpdateDebounceSeconds: 60,
        allowLocalRuntime: false,
        defaultImage: "ghcr.io/x/base:latest",
        updatedAt: null,
        updatedBy: null,
      }),
  });
  await openTemplate();
  const hint = await screen.findByText("Omit to use the factory default (45 min).");
  // Tied to the template.yaml editor, not only placed next to it.
  const editor = await editorFor("template.yaml");
  const describedBy = editor.getAttribute("aria-describedby")?.split(" ") ?? [];
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
  await openTemplate();
  typeInto(await editorFor("template.yaml"), "x");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("button", { name: "Saving…" })).toBeInTheDocument();
  await act(async () => release());
  expect(await screen.findByText("Saved.")).toBeInTheDocument();
});

test("list header: the Templates h1, then New template, named and with a tooltip", async () => {
  mockApi({ "GET /api/templates": () => json({ dir: "/d", templates: [] }) });
  renderApp("/templates", alice);
  await screen.findByRole("heading", { level: 1, name: "Templates" });
  const link = screen.getByRole("button", { name: "New template" });
  expect(link).toHaveAttribute("aria-label", "New template");
  await userEvent.hover(link);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("New template");
});

// U4 §12: template files edit in CodeMirror.

test("CodeMirror: switching to mcp.json and back keeps template.yaml's undo history", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [] }), // the tab click blurs the editor
  });
  await openTemplate();
  const editor = await editorFor("template.yaml");
  typeInto(editor, "model: x\n");
  typeInto(editor, "runtime: local\n");
  const depth = undoDepth(viewOf(editor).state);
  expect(depth).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("tab", { name: /mcp\.json/ }));
  expect(screen.getByText("Not created")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /template\.yaml/ }));
  const again = await editorFor("template.yaml");
  expect(again).not.toBe(editor); // the tab remounted
  expect(docOf(again)).toBe("name: lead\ndisplay_name: Lead\nmodel: x\nruntime: local\n");
  expect(undoDepth(viewOf(again).state)).toBe(depth);
});

test("CodeMirror: an issue's jump focuses its line in the editor", async () => {
  mockApi({
    "GET /api/templates/lead": () =>
      json(
        detail([
          { severity: "error", file: "settings.json", message: "JSON: bad", line: 2, column: 3 },
        ]),
      ),
  });
  await openTemplate();
  await editorFor("template.yaml");
  await userEvent.click(
    await screen.findByRole("button", { name: /settings\.json.*2:3.*JSON: bad/ }),
  );
  const editor = await editorFor("settings.json");
  const state = viewOf(editor).state;
  expect(state.selection.main.head).toBe(state.doc.line(2).from);
  expect(editor).toHaveFocus();
});

test("CodeMirror: Reload takes focus, says it discards edits, replaces the doc without marking the file dirty or leaving undo, and returns focus to the editor", async () => {
  const { api, editor } = await conflictPage();
  // The changed-on-disk block takes focus on its Reload button.
  const reload = screen.getByRole("button", { name: "Reload" });
  expect(reload).toHaveFocus();
  expect(reload).toHaveAccessibleDescription(/discards your edits/i);
  expect(screen.getByRole("tab", { name: /template\.yaml.*\(unsaved\)/ })).toBeInTheDocument();
  await userEvent.click(reload);
  await vi.waitFor(() => expect(docOf(editor)).toBe("name: lead\ndisplay_name: Lead\n"));
  expect(editor).toHaveFocus();
  expect(api.calls.filter((c) => c.method === "GET").length).toBeGreaterThan(1);
  expect(screen.queryByText("(unsaved)")).not.toBeInTheDocument();
  expect(undoDepth(viewOf(editor).state)).toBe(0);
});

test("CodeMirror: AGENTS.md's Write uses the editor; Preview still renders markdown", async () => {
  mockApi({ "GET /api/templates/lead": () => json(detail()) });
  await openTemplate();
  await editorFor("template.yaml");
  await userEvent.click(screen.getByRole("tab", { name: /AGENTS\.md/ }));
  const editor = await editorFor("AGENTS.md");
  expect(docOf(editor)).toBe("# Lead\n");
  await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
  const preview = screen.getByRole("tabpanel", { name: "Preview" });
  expect(within(preview).getByRole("heading", { name: "Lead" })).toBeInTheDocument();
});
