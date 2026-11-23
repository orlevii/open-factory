import type { ConfigDoc, TemplateConfigResponse } from "@open-factory/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONFIG_FORM_MSG, CONFIG_PAGE_MSG } from "@/features/config/messages";
import { type Handler, json, type MockApi, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

// The editor's chunk fails, so each file tab is the textarea the editor falls back to.
vi.mock("@/features/templates/code-editor", () =>
  Promise.reject(new Error("Failed to fetch dynamically imported module")),
);
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const yamlError = { severity: "error", file: "template.yaml", message: "YAML: bad", line: 1 };
const SETTINGS = '{\n  "permissions": {\n    "allow": ["Bash(git:*)"]\n  }\n}\n';
const detail = (issues: unknown[] = [], settings = SETTINGS, hash = "h-s1") => ({
  template: {
    name: "dev",
    path: "/h/of/templates/dev",
    issues,
    agents: ["ana", "bo", "cy"],
    avatar: { version: null, tooLarge: false },
    files: [
      { file: "template.yaml", content: "name: dev\n", hash: "h-y1" },
      { file: "AGENTS.md", content: "# Dev\n", hash: "h-a1" },
      { file: "settings.json", content: settings, hash },
      { file: "mcp.json", content: null, hash: null },
    ],
  },
});
// `futureKey`: a settings.json key the form doesn't know, which a form save must keep (AC 12).
const DOC: ConfigDoc = {
  template: {},
  settings: { futureKey: { x: [1, 2] }, permissions: { allow: ["Bash(git:*)"] } },
  mcp: { mcpServers: {} },
};
const tcfg = (over: Partial<TemplateConfigResponse> = {}): TemplateConfigResponse => ({
  doc: DOC,
  hashes: { "template.yaml": "h-y1", "settings.json": "h-s1", "mcp.json": null },
  issues: [],
  localSkills: [],
  agents: { live: 3, archived: 0, cantStart: 0 },
  ...over,
});

let tpl: ReturnType<typeof detail>;
let config: TemplateConfigResponse;
let putConfig: Handler;
let api: MockApi;

beforeEach(() => {
  tpl = detail();
  config = tcfg();
  putConfig = () =>
    json({
      hashes: { "template.yaml": "h-y1", "settings.json": "h-s2", "mcp.json": null },
      issues: [],
    });
  api = mockApi({
    "GET /api/templates/dev": () => json(tpl),
    "GET /api/templates/dev/config": () => json(config),
    "PUT /api/templates/dev/config": (b, u) => putConfig(b, u),
    "PUT /api/templates/dev/files/settings.json": () => json({ hash: "h-s2", issues: [] }),
    "POST /api/templates/dev/validate": () => json({ issues: [] }),
    "GET /api/host-skills": () => json({ dir: "/s", skills: [] }),
    "GET /api/secrets": () => json({ secrets: [] }),
    "GET /api/templates": () => json({ dir: "/t", templates: [] }),
  });
});

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const calls = (method: string, url: string) =>
  api.calls.filter((c) => c.method === method && c.url === url);
/** The footer of the tab on screen (Configuration stays mounted, hidden, behind a file tab). */
const footer = () =>
  document.querySelector("[role=tabpanel]:not([hidden]) [data-slot=page-footer]") as HTMLElement;

async function open() {
  const r = renderApp("/templates/dev", alice);
  await screen.findByRole("heading", { level: 2, name: "Model" });
  return r;
}
async function toFile(name: string) {
  await userEvent.click(tab(new RegExp(name.replace(".", "\\."))));
  return waitFor(() => {
    const t = screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
    expect(t).toHaveAttribute("aria-labelledby");
    return t;
  });
}
const addAllowRule = (rule: string) =>
  userEvent.type(screen.getByRole("textbox", { name: "Add allow rule" }), `${rule}{Enter}`);

test("a valid template opens on Configuration, first, in Geist, set apart from the mono file tabs", async () => {
  await open();
  const tabs = screen.getAllByRole("tab");
  expect(tabs[0]).toHaveAccessibleName("Configuration");
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  expect(tabs[0]?.className).not.toMatch(/font-mono/);
  expect(tabs[1]?.className).toMatch(/font-mono/);
  expect(tabs[0]?.nextElementSibling).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.getByText(
      "Used by 3 agents. Saving restarts the ones whose configuration changes, when idle.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Bash(git:*)")).toBeInTheDocument();
});

test("a broken template opens on template.yaml, and its Configuration form is read-only", async () => {
  tpl = detail([yamlError]);
  config = tcfg({ doc: null, agents: { live: 3, archived: 0, cantStart: 3 } });
  renderApp("/templates/dev", alice);
  await waitFor(() => expect(tab(/template\.yaml/)).toHaveAttribute("aria-selected", "true"));
  await userEvent.click(tab(/^Configuration/));
  expect(await screen.findByText("3 agents can't start until this is fixed.")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Add allow rule" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("a dirty form makes the config file tabs read-only, and marks the Configuration tab", async () => {
  await open();
  await addAllowRule("Read");
  expect(tab(/^Configuration/)).toHaveAccessibleName(/^Configuration\s*\(unsaved\)$/);
  const settings = await toFile("settings.json");
  expect(settings).toHaveAttribute("readonly");
  expect(screen.getByText("Unsaved changes in Configuration.")).toBeInTheDocument();
  // AGENTS.md isn't configuration: it stays editable.
  await userEvent.click(tab(/AGENTS\.md/));
  expect(screen.queryByText("Unsaved changes in Configuration.")).toBeNull();
});

test("a dirty config file makes the form read-only, with a jump to it", async () => {
  await open();
  const settings = await toFile("settings.json");
  expect(footer()).not.toHaveAttribute("data-sticky");
  fireEvent.change(settings, { target: { value: `${SETTINGS} ` } });
  // The file tabs use the page footer too: sticky while dirty.
  expect(footer()).toHaveAttribute("data-sticky");
  await userEvent.click(tab(/^Configuration/));
  // Once: the footer's notice, which describes the held Save; the form only offers the jump.
  const line = await within(footer()).findByText(
    "settings.json has unsaved edits. Save or discard them first.",
  );
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save.getAttribute("aria-describedby")).toBe(line.id);
  expect(
    screen.getAllByText("settings.json has unsaved edits. Save or discard them first."),
  ).toHaveLength(1);
  expect(screen.queryByRole("textbox", { name: "Add allow rule" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open settings.json" }));
  expect(tab(/settings\.json/)).toHaveAttribute("aria-selected", "true");
});

test("after a file-tab save with the form clean, the form reloads silently", async () => {
  await open();
  const before = calls("GET", "/api/templates/dev/config").length;
  const settings = await toFile("settings.json");
  const next = '{\n  "permissions": {\n    "allow": ["Bash(git:*)", "Read"]\n  }\n}\n';
  fireEvent.change(settings, { target: { value: next } });
  config = tcfg({
    doc: {
      ...DOC,
      settings: { futureKey: { x: [1, 2] }, permissions: { allow: ["Bash(git:*)", "Read"] } },
    },
    hashes: { "template.yaml": "h-y1", "settings.json": "h-s2", "mcp.json": null },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(calls("GET", "/api/templates/dev/config").length).toBeGreaterThan(before),
  );
  await userEvent.click(tab(/^Configuration/));
  expect(await screen.findByText("Read")).toBeInTheDocument();
  // Silent: the form's footer shows no outcome and stays in the flow.
  expect(within(footer()).queryByRole("alert")).toBeEmptyDOMElement();
  expect(within(footer()).getAllByRole("status")[0]).toBeEmptyDOMElement();
  expect(footer()).not.toHaveAttribute("data-sticky");
});

test("a Configuration save sends the doc with the base hashes, then the file tabs read the files again", async () => {
  await open();
  await addAllowRule("Read");
  tpl = detail([], '{\n  "permissions": {\n    "allow": ["Bash(git:*)", "Read"]\n  }\n}\n', "h-s2");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await within(footer()).findByText(CONFIG_PAGE_MSG.saved)).toBeInTheDocument();
  expect(calls("PUT", "/api/templates/dev/config")[0]?.body).toEqual({
    doc: {
      ...DOC,
      settings: { futureKey: { x: [1, 2] }, permissions: { allow: ["Bash(git:*)", "Read"] } },
    },
    baseHashes: { "template.yaml": "h-y1", "settings.json": "h-s1", "mcp.json": null },
  });
  const settings = await toFile("settings.json");
  expect(settings.value).toContain('"Read"');
  expect(settings).not.toHaveAttribute("readonly");
});

test("changed on disk: the conflict line with Reload, which rebases onto the files as they are", async () => {
  await open();
  await addAllowRule("Read");
  putConfig = () => json({ error: { code: "changed_on_disk", message: "Changed on disk." } }, 409);
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await within(footer()).findByText(CONFIG_PAGE_MSG.changedSince)).toBeInTheDocument();
  config = tcfg({
    doc: { ...DOC, template: { model: "opus" } },
    hashes: { "template.yaml": "h-y2", "settings.json": "h-s1", "mcp.json": null },
  });
  putConfig = () =>
    json({
      hashes: { "template.yaml": "h-y2", "settings.json": "h-s2", "mcp.json": null },
      issues: [],
    });
  await userEvent.click(within(footer()).getByRole("button", { name: "Reload" }));
  await waitFor(() =>
    expect(within(footer()).queryByText(CONFIG_PAGE_MSG.changedSince)).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(calls("PUT", "/api/templates/dev/config")).toHaveLength(2));
  expect(calls("PUT", "/api/templates/dev/config")[1]?.body).toEqual({
    doc: {
      template: { model: "opus" },
      settings: { futureKey: { x: [1, 2] }, permissions: { allow: ["Bash(git:*)", "Read"] } },
      mcp: { mcpServers: {} },
    },
    baseHashes: { "template.yaml": "h-y2", "settings.json": "h-s1", "mcp.json": null },
  });
});

test("Discard with Undo, and Save refused while an MCP server editor is open", async () => {
  await open();
  await addAllowRule("Read");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByText("Read")).toBeNull();
  await userEvent.click(within(footer()).getByRole("button", { name: "Undo" }));
  expect(screen.getByText("Read")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(within(footer()).getByText(CONFIG_FORM_MSG.finishServer)).toBeInTheDocument();
  expect(calls("PUT", "/api/templates/dev/config")).toHaveLength(0);
  expect(document.getElementById("field-mcp-name")).toHaveFocus();
});

test("Discard closes an open MCP editor; an open editor survives a visit to mcp.json", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "gh");
  await userEvent.click(tab(/mcp\.json/));
  await userEvent.click(tab(/^Configuration/));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("gh");
  await addAllowRule("Read");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  await userEvent.click(within(footer()).getByRole("button", { name: "Undo" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(within(footer()).queryByText(CONFIG_FORM_MSG.finishServer)).toBeNull();
  await waitFor(() => expect(calls("PUT", "/api/templates/dev/config")).toHaveLength(1));
});

test("Discard works with only an MCP editor open, and closes it", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  const discard = screen.getByRole("button", { name: "Discard" });
  expect(discard).not.toHaveAttribute("aria-disabled");
  await userEvent.click(discard);
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(screen.getByRole("button", { name: "Discard" })).toHaveAttribute("aria-disabled", "true");
  // Nothing was edited: no "Discarded." notice and nothing to undo.
  expect(within(footer()).queryByText(CONFIG_PAGE_MSG.discarded)).toBeNull();
  expect(within(footer()).queryByRole("button", { name: "Undo" })).toBeNull();
});

test("below 40rem of its own width the tab strip is a Select listing every tab with its marks", async () => {
  tpl = detail([{ severity: "error", file: "settings.json", message: "JSON: bad", line: 1 }]);
  renderApp("/templates/dev", alice);
  // An error in settings.json opens template.yaml; the form (its doc mocked valid) is a click away.
  await userEvent.click(await screen.findByRole("tab", { name: /^Configuration/ }));
  await screen.findByRole("heading", { level: 2, name: "Model" });
  const strip = screen.getByRole("tablist");
  // A container query on the strip's wrapper, not the viewport: 200% text gets the Select too.
  expect(strip.closest("[data-slot=tabs]")?.className).toMatch(/@container/);
  expect(strip.className).toMatch(/@max-\[40rem\]:hidden/);
  expect(strip.className).not.toMatch(/(^|\s)max-\[40rem\]/);
  await addAllowRule("Read");
  const picker = screen.getByRole("combobox", { name: "File" });
  expect(picker.closest("div")?.className).toMatch(/@min-\[40rem\]:hidden/);
  await userEvent.click(picker);
  const names = screen.getAllByRole("option").map((o) => o.textContent);
  expect(names).toEqual([
    "Configuration (unsaved)",
    "template.yaml",
    "AGENTS.md",
    "settings.json (has errors)",
    "mcp.json",
  ]);
  await userEvent.click(screen.getByRole("option", { name: "AGENTS.md" }));
  expect(tab(/AGENTS\.md/)).toHaveAttribute("aria-selected", "true");
});
