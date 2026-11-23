import type { AgentConfigResponse, AgentSummary, ConfigDoc } from "@open-factory/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONFIG_FORM_MSG, CONFIG_PAGE_MSG } from "@/features/config/messages";
import { type Handler, json, type MockApi, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { detail } from "@/test/session-fixtures";

// The editor's chunk fails, so Raw JSON is the textarea the page falls back to: same handle, plain to type into.
vi.mock("@/features/templates/code-editor", () =>
  Promise.reject(new Error("Failed to fetch dynamically imported module")),
);
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const DOC: ConfigDoc = {
  template: { model: "sonnet" },
  settings: { permissions: { allow: ["Bash(git:*)"] } },
  mcp: { mcpServers: {} },
};

const cfg = (over: Partial<AgentConfigResponse> = {}): AgentConfigResponse => ({
  overlay: {},
  version: "v1",
  template: { name: "dev", doc: DOC, valid: true },
  merged: DOC,
  issues: [],
  ...over,
});

let agent: Partial<AgentSummary>;
let config: AgentConfigResponse;
let put: Handler;
let api: MockApi;
const saved = (overlay: unknown, over: Record<string, unknown> = {}) =>
  json({
    ...cfg({ overlay: overlay as Record<string, unknown>, version: "v2" }),
    changes: [],
    restartChecked: false,
    checked: "full",
    ...over,
  });

beforeEach(() => {
  agent = { slug: "ana", displayName: "Ana", template: "dev", status: "hibernated" };
  config = cfg();
  put = (body) => saved((body as { overlay: unknown }).overlay);
  api = mockApi({
    "GET /api/agents/ana": () => json(detail(agent)),
    "GET /api/agents/ana/config": () => json(config),
    "PUT /api/agents/ana/config": (b, u) => put(b, u),
    "GET /api/templates/dev/config": () =>
      json({
        doc: DOC,
        hashes: { "template.yaml": "h", "settings.json": null, "mcp.json": null },
        issues: [],
        localSkills: ["notes"],
        agents: { live: 1, archived: 0, cantStart: 0 },
      }),
    "GET /api/host-skills": () => json({ dir: "/s", skills: [] }),
    "GET /api/secrets": () => json({ secrets: [] }),
    "GET /api/templates": () => json({ dir: "/t", templates: [] }),
  });
});

const puts = () => api.calls.filter((c) => c.method === "PUT");
const footer = () => document.querySelector("[data-slot=page-footer]") as HTMLElement;
const save = () => screen.getByRole("button", { name: "Save changes" });
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });

async function open() {
  const r = renderApp("/agents/ana/config", alice);
  await screen.findByRole("heading", { level: 2, name: "Model" });
  return r;
}

/** Raw JSON, once the editor's (failed) chunk has settled into the textarea that stays. */
async function toRaw() {
  await userEvent.click(tab("Raw JSON"));
  return waitFor(() => {
    const t = screen.getByRole("textbox", { name: "Raw JSON" }) as HTMLTextAreaElement;
    expect(t).toHaveAttribute("aria-labelledby");
    return t;
  });
}

async function addAllowRule(rule: string) {
  await userEvent.type(screen.getByRole("textbox", { name: "Add allow rule" }), `${rule}{Enter}`);
}

test("the page: header, tabs, the template's rows, and a footer in the flow while clean", async () => {
  await open();
  expect(screen.getByRole("heading", { level: 1, name: "Configuration" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "dev" })).toHaveAttribute("href", "/templates/dev");
  expect(screen.getByRole("link", { name: "← @ana" })).toHaveAttribute("href", "/agents/ana/chat");
  expect(tab("Configuration")).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Bash(git:*)")).toBeInTheDocument();
  // The template's own skills come from the template config GET.
  expect(await screen.findByText("notes")).toBeInTheDocument();
  expect(footer()).not.toHaveAttribute("data-sticky");
  expect(save()).toHaveAttribute("aria-disabled", "true");
});

test("the footer is sticky only while dirty, or while an outcome shows", async () => {
  await open();
  expect(footer()).not.toHaveAttribute("data-sticky");
  await addAllowRule("Read");
  expect(footer()).toHaveAttribute("data-sticky");
  expect(footer().className).toMatch(/\bsticky\b/);
  await userEvent.click(save());
  expect(await within(footer()).findByText(CONFIG_PAGE_MSG.saved)).toBeInTheDocument();
  expect(footer()).toHaveAttribute("data-sticky"); // the outcome shows
  expect(puts()[0]?.body).toEqual({
    overlay: { settings: { permissions: { allow: ["Read"] } } },
    baseVersion: "v1",
  });
  await addAllowRule("Write"); // the next edit ends "Saved."
  expect(within(footer()).queryByText(CONFIG_PAGE_MSG.saved)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await userEvent.click(within(footer()).getByRole("button", { name: "Undo" }));
  expect(within(footer()).queryByText(CONFIG_PAGE_MSG.discarded)).toBeNull();
  // Clean, with no outcome: back in the flow (the saved rule is now the loaded value).
  await userEvent.click(screen.getByRole("button", { name: "Remove allow rule 2" }));
  expect(footer()).toHaveAttribute("data-sticky");
});

test("invalid JSON: a switch is refused with focus on the error and a polite note; Save is held; Revert and Discard work", async () => {
  await open();
  const raw = await toRaw();
  fireEvent.change(raw, { target: { value: '{\n  "settings": {\n    "a": 1,\n  }\n}\n' } });
  await userEvent.click(tab("Configuration"));
  expect(tab("Raw JSON")).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(raw).toHaveFocus());
  // The error's line is the 4th (the closing brace after the trailing comma).
  expect(raw.value.slice(0, raw.selectionStart).split("\n").length).toBe(4);
  const note = screen.getByText(CONFIG_PAGE_MSG.fixJsonToSwitch);
  expect(note.closest("[aria-live=polite]")).not.toBeNull();
  // Combined is refused the same way.
  await userEvent.click(screen.getByRole("radio", { name: "Combined" }));
  expect(screen.getByRole("radio", { name: "This agent" })).toBeChecked();

  // Save keeps its shape but is held, and says why.
  expect(save()).toHaveAttribute("aria-disabled", "true");
  const noticeId = save().getAttribute("aria-describedby") ?? "";
  expect(document.getElementById(noticeId)).toHaveTextContent(CONFIG_PAGE_MSG.fixJsonToSave);
  await userEvent.click(save());
  expect(puts()).toHaveLength(0);

  // Revert raw edits: the last valid draft, and switching works again.
  await userEvent.click(screen.getByRole("button", { name: "Revert raw edits" }));
  expect(screen.getByRole("textbox", { name: "Raw JSON" })).toHaveValue("{}\n");
  await userEvent.click(tab("Configuration"));
  expect(tab("Configuration")).toHaveAttribute("aria-selected", "true");

  // Discard always works, even while the JSON is broken.
  const again = await toRaw();
  fireEvent.change(again, { target: { value: "{ nope" } });
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByRole("textbox", { name: "Raw JSON" })).toHaveValue("{}\n");
  expect(screen.queryByText(CONFIG_PAGE_MSG.fixJsonToSave)).toBeNull();
  await userEvent.click(tab("Configuration"));
  expect(tab("Configuration")).toHaveAttribute("aria-selected", "true");
});

test("the raw text and its key order survive a visit to the form with no edit; a form edit re-serializes it", async () => {
  await open();
  const raw = await toRaw();
  const text = '{"settings": {"zeta": 1, "alpha": {"b": 2, "a": 1}}}';
  fireEvent.change(raw, { target: { value: text } });
  await userEvent.click(tab("Configuration"));
  await toRaw();
  expect(screen.getByRole("textbox", { name: "Raw JSON" })).toHaveValue(text);

  await userEvent.click(tab("Configuration"));
  await addAllowRule("Read");
  const after = await toRaw();
  expect(JSON.parse(after.value)).toEqual({
    settings: { zeta: 1, alpha: { b: 2, a: 1 }, permissions: { allow: ["Read"] } },
  });
  expect(after.value).not.toBe(text);
});

test("an unknown settings key added in Raw survives a form save (acceptance 12)", async () => {
  await open();
  const raw = await toRaw();
  fireEvent.change(raw, { target: { value: '{"settings": {"futureKey": {"x": [1, 2]}}}' } });
  await userEvent.click(tab("Configuration"));
  await addAllowRule("Read");
  await userEvent.click(save());
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0]?.body).toEqual({
    overlay: { settings: { futureKey: { x: [1, 2] }, permissions: { allow: ["Read"] } } },
    baseVersion: "v1",
  });
});

test("Discard is instant, with Undo until the next edit", async () => {
  await open();
  await addAllowRule("Read");
  expect(screen.getByText("Read")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByText("Read")).toBeNull();
  expect(within(footer()).getByText(CONFIG_PAGE_MSG.discarded)).toBeInTheDocument();
  await userEvent.click(within(footer()).getByRole("button", { name: "Undo" }));
  expect(screen.getByText("Read")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await addAllowRule("Write");
  expect(within(footer()).queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByText("Read")).toBeNull();
});

test("409: Changed since you opened it, and Reload rebases, keeping my skill beside theirs", async () => {
  config = cfg({ overlay: { template: { skills: ["base"] } } });
  await open();
  const raw = await toRaw();
  fireEvent.change(raw, { target: { value: '{"template": {"skills": ["base", "mine"]}}' } });
  put = () =>
    json({ error: { code: "config_changed", message: "Changed since you opened it." } }, 409);
  await userEvent.click(save());
  expect(await within(footer()).findByText(CONFIG_PAGE_MSG.changedSince)).toBeInTheDocument();
  expect(within(footer()).queryByRole("button", { name: /Overwrite/ })).toBeNull();

  config = cfg({ overlay: { template: { skills: ["base", "theirs"] } }, version: "v2" });
  put = (body) => saved((body as { overlay: unknown }).overlay, { version: "v3" });
  await userEvent.click(within(footer()).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(save()).toHaveFocus());
  expect(within(footer()).queryByText(CONFIG_PAGE_MSG.changedSince)).toBeNull();
  await userEvent.click(save());
  await waitFor(() => expect(puts()).toHaveLength(2));
  const body = puts()[1]?.body as {
    overlay: { template: { skills: string[] } };
    baseVersion: string;
  };
  expect(body.baseVersion).toBe("v2");
  expect([...body.overlay.template.skills].sort()).toEqual(["base", "mine", "theirs"]);
});

test("Save while an MCP server editor is open: refused, nothing sent, focus on its Name", async () => {
  await open();
  await addAllowRule("Read");
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  await userEvent.click(save());
  expect(within(footer()).getByText(CONFIG_FORM_MSG.finishServer)).toBeInTheDocument();
  expect(puts()).toHaveLength(0);
  expect(document.getElementById("field-mcp-name")).toHaveFocus();
});

test("M1: the form's own state (an open MCP editor) survives a visit to Raw", async () => {
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "gh");
  await toRaw();
  const panel = document.getElementById("field-mcp-name")?.closest("[role=tabpanel]");
  expect(panel).toHaveAttribute("data-state", "inactive");
  await userEvent.click(tab("Configuration"));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("gh");
});

test("Combined is the template with this agent's draft, read-only", async () => {
  await open();
  await addAllowRule("Read");
  await toRaw();
  await userEvent.click(screen.getByRole("radio", { name: "Combined" }));
  const combined = await waitFor(() => {
    const t = screen.getByRole("textbox", { name: "Raw JSON" }) as HTMLTextAreaElement;
    expect(t.value).toContain("sonnet");
    return t;
  });
  expect(combined).toHaveAttribute("readonly");
  expect(JSON.parse(combined.value).settings.permissions.allow).toEqual(["Bash(git:*)", "Read"]);
});

test("server issues land on their fields, and a 400 replaces them", async () => {
  await open();
  await addAllowRule("Read");
  put = () =>
    json(
      {
        error: {
          code: "invalid_config",
          message: "The configuration has errors.",
          issues: [
            {
              severity: "error",
              file: "settings.json",
              message: "Unknown tool.",
              path: "settings.permissions.allow.0",
            },
          ],
        },
      },
      400,
    );
  await userEvent.click(save());
  expect(await within(footer()).findByText(CONFIG_PAGE_MSG.hasErrors)).toBeInTheDocument();
  expect(screen.getByText("Unknown tool.")).toBeInTheDocument();
});

test("save outcomes: a running agent restarts; a broken template is checked by schema only", async () => {
  agent = { ...agent, status: "idle" };
  await open();
  await addAllowRule("Read");
  expect(screen.getByText("Saving restarts @ana when idle to apply: 1 rule.")).toBeInTheDocument();
  put = (body) =>
    saved((body as { overlay: unknown }).overlay, {
      changes: ["added allow rule Read"],
      restartChecked: true,
    });
  await userEvent.click(save());
  expect(await within(footer()).findByText("Saved. Restarts @ana when idle.")).toBeInTheDocument();
});

test("broken template: a persistent block, a read-only form with no base, Raw editable, schema-only save", async () => {
  config = cfg({ template: { name: "dev", doc: null, valid: false }, merged: null });
  put = (body) => saved((body as { overlay: unknown }).overlay, { checked: "schema" });
  await open();
  expect(screen.getByText("Template dev has errors. @ana can't start.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open template" })).toHaveAttribute(
    "href",
    "/templates/dev",
  );
  expect(screen.queryByRole("textbox", { name: "Add allow rule" })).toBeNull();
  expect(screen.queryByText("Bash(git:*)")).toBeNull();
  const raw = await toRaw();
  fireEvent.change(raw, { target: { value: '{"template": {"model": "opus"}}' } });
  await userEvent.click(save());
  expect(
    await within(footer()).findByText("Saved. Checked fully once dev is fixed."),
  ).toBeInTheDocument();
});

test("archived: a persistent block, and the form stays editable", async () => {
  agent = { ...agent, archivedAt: "2026-11-01T00:00:00Z" };
  await open();
  expect(
    screen.getByText("@ana is archived. Changes apply when it's restored."),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Add allow rule" })).toBeInTheDocument();
});

test("restart pending: a top line", async () => {
  agent = { ...agent, restartPending: true, restartChanges: ["model: sonnet → opus"] };
  await open();
  expect(screen.getByText("Restarts when idle to apply: model.")).toBeInTheDocument();
});

test("spawned: the template's configuration plus the spawner's limits, read-only, as of the next start", async () => {
  agent = { ...agent, kind: "ephemeral", reportsTo: "lead" };
  renderApp("/agents/ana/config", alice);
  expect(await screen.findByRole("heading", { level: 2, name: "Next start" })).toBeInTheDocument();
  expect(screen.getByText(/Spawned agents use their template's configuration/)).toHaveTextContent(
    "Spawned agents use their template's configuration, plus @lead's deny rules and secret limits.",
  );
  expect(screen.getByRole("link", { name: "@lead" })).toHaveAttribute("href", "/agents/lead/chat");
  const view = await waitFor(() => {
    const t = screen.getByRole("textbox", { name: "Next start" });
    expect(t).toHaveAttribute("readonly");
    return t as HTMLTextAreaElement;
  });
  expect(JSON.parse(view.value)).toEqual(DOC);
  expect(screen.queryByRole("tab")).toBeNull();
});

test("an unknown slug: There is no agent @x.", async () => {
  api.on("GET /api/agents/x", () =>
    json({ error: { code: "agent_not_found", message: "No agent." } }, 404),
  );
  api.on("GET /api/agents/x/config", () =>
    json({ error: { code: "agent_not_found", message: "No agent." } }, 404),
  );
  renderApp("/agents/x/config", alice);
  expect(await screen.findByText("There is no agent @x.")).toBeInTheDocument();
});
