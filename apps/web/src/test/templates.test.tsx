import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { CodeTextarea } from "@/features/templates/code-textarea";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
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
      warmWindowMinutes: 70,
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
