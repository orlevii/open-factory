import type { ConfigDoc, TemplateIssue } from "@open-factory/shared";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { completeChild, getSheetState, resetSheets } from "@/features/sheets/sheet-store";
import { installInputModality } from "@/lib/input-modality";
import { doc, QueryWrap } from "@/test/config-harness";
import { json, mockApi } from "@/test/mock-api";
import { ConfigForm } from "./config-form";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";

// Secret-shaped fixtures: a row must never show any of these.
const ANT = "sk-ant-api03-Zx9QkLmNoPqRsTuVwXyZ0123456789";
const GHP = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const USER_URL = `https://user:${GHP}@mcp.acme.dev/v1/stream?key=${ANT}`;

const NO_USE = { templates: 0, agents: 0 };

let off = () => {};
beforeEach(() => {
  off = installInputModality();
  resetSheets();
  mockApi({
    "GET /api/secrets": () =>
      json({ secrets: [{ name: "GH_TOKEN", updatedAt: "2026-11-01T00:00:00Z", usedBy: [] }] }),
    "GET /api/library/skills": () =>
      json({
        hostDir: "/skills",
        groups: [
          {
            group: "host",
            kind: "host",
            skills: [
              { name: "release", description: "Cut a release.", state: "ok", usedBy: NO_USE },
              { name: "review", description: "Review a PR.", state: "ok", usedBy: NO_USE },
              {
                name: "shadowed",
                description: "Hidden by a source.",
                state: "hidden",
                stateDetail: "the name is used by acme/x",
                usedBy: NO_USE,
              },
            ],
          },
          {
            group: "source:s1",
            kind: "source",
            source: {
              id: "s1",
              kind: "github",
              path: null,
              repo: "acme/x",
              subpath: "",
              branch: "main",
              pin: "a".repeat(40),
              state: "ready",
              skillCount: 1,
              update: false,
              checkFailed: false,
              checkedAt: null,
            },
            skills: [{ name: "from-github", description: "", state: "ok", usedBy: NO_USE }],
          },
        ],
      }),
    "GET /api/templates": () => json({ dir: "/t", templates: [] }),
  });
});
afterEach(() => off());

function Form({
  start,
  base = doc(),
  mode = "agent",
  onValue,
  issues = [],
  localSkills,
  onEditorOpenChange,
}: {
  start: unknown;
  base?: ConfigDoc | null;
  mode?: "agent" | "template";
  onValue?: (v: unknown) => void;
  issues?: TemplateIssue[];
  localSkills?: string[];
  onEditorOpenChange?: (open: boolean) => void;
}) {
  const [value, setValue] = useState<unknown>(start);
  return (
    <QueryWrap>
      <ConfigForm
        mode={mode}
        value={value}
        base={mode === "agent" ? base : undefined}
        templateName="dev"
        issues={issues}
        localSkills={localSkills}
        onEditorOpenChange={onEditorOpenChange}
        onChange={(u) =>
          setValue((p: unknown) => {
            const n = u(p);
            onValue?.(n);
            return n;
          })
        }
      />
    </QueryWrap>
  );
}

const withServers = (servers: Record<string, unknown>, template: Record<string, unknown> = {}) => ({
  template,
  settings: {},
  mcp: { mcpServers: servers },
});
const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
const mcpGroup = () => screen.getByRole("group", { name: "MCP servers" });

test("an MCP row never renders args, the full URL, headers or env values", () => {
  render(
    <Form
      start={{
        mcp: {
          mcpServers: {
            gh: {
              command: "npx",
              args: ["-y", "@acme/gh-mcp", `--token=${ANT}`],
              env: { GH_TOKEN: GHP },
            },
          },
        },
      }}
      base={withServers({
        remote: { type: "http", url: USER_URL, headers: { Authorization: `Bearer ${GHP}` } },
      })}
    />,
  );
  const group = mcpGroup();
  expect(within(group).getByText("npx · 3 args")).toBeInTheDocument();
  expect(within(group).getByText("mcp.acme.dev")).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "Edit gh" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "Remove gh" })).toBeInTheDocument();
  // Not in the text, and not in any attribute (labels, descriptions) either.
  const html = document.body.innerHTML;
  for (const leak of [
    ANT,
    GHP,
    "sk-ant",
    "ghp_",
    "user:",
    "/v1",
    "stream",
    "@acme/gh-mcp",
    "--token",
    "Bearer",
  ])
    expect(html, leak).not.toContain(leak);
});

test("a command that isn't a bare program name never shows in its row", () => {
  render(<Form start={{ mcp: { mcpServers: { x: { command: `run --key ${ANT}` } } } }} />);
  expect(within(mcpGroup()).getByText("Command", { selector: "p" })).toBeInTheDocument();
  expect(document.body.innerHTML).not.toContain("sk-ant");
});

test("Add server: the editor appears with focus on Name, and switching kind keeps the other kind's fields", async () => {
  const onValue = vi.fn();
  render(<Form start={{}} onValue={onValue} />);
  await userEvent.click(screen.getByRole("button", { name: CONFIG_COPY.addServer }));
  const name = screen.getByRole("textbox", { name: "Name" });
  expect(name).toHaveFocus();
  await userEvent.type(name, "gh");
  await userEvent.type(screen.getByRole("textbox", { name: "Command" }), "npx");
  await userEvent.type(screen.getByRole("textbox", { name: "Arguments" }), "-y{Enter}pkg");
  await userEvent.click(screen.getByRole("radio", { name: "URL" }));
  expect(screen.queryByRole("textbox", { name: "Command" })).toBeNull();
  await userEvent.type(screen.getByRole("textbox", { name: "URL" }), "https://mcp.acme.dev/x");
  await userEvent.click(screen.getByRole("radio", { name: "Command" }));
  expect(screen.getByRole("textbox", { name: "Command" })).toHaveValue("npx");
  expect(screen.getByRole("textbox", { name: "Arguments" })).toHaveValue("-y\npkg");
  await userEvent.click(screen.getByRole("radio", { name: "URL" }));
  expect(screen.getByRole("textbox", { name: "URL" })).toHaveValue("https://mcp.acme.dev/x");
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  // Only the chosen kind is saved.
  expect(last(onValue)).toEqual({
    mcp: { mcpServers: { gh: { type: "http", url: "https://mcp.acme.dev/x" } } },
  });
  expect(screen.getByRole("button", { name: "Edit gh" })).toHaveFocus();
});

test("the editor refuses a missing command, the reserved name and a bad env name", async () => {
  const onValue = vi.fn();
  render(<Form start={{}} onValue={onValue} />);
  await userEvent.click(screen.getByRole("button", { name: CONFIG_COPY.addServer }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "factory");
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(document.getElementById("field-mcp-name-error")).toHaveTextContent(
    CONFIG_FIELD_MSG.factoryServer,
  );
  expect(document.getElementById("field-mcp-command-error")).toHaveTextContent(
    CONFIG_FIELD_MSG.enterCommand,
  );
  expect(onValue).not.toHaveBeenCalled();
  const name = screen.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "gh");
  await userEvent.type(screen.getByRole("textbox", { name: "Command" }), "npx");
  await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name, env variable 1" }), "A-B");
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("textbox", { name: "Name, env variable 1" })).toHaveFocus();
  expect(screen.getByText(CONFIG_FIELD_MSG.envName)).toBeInTheDocument();
  expect(onValue).not.toHaveBeenCalled();
});

test(`Insert secret puts \${GH_TOKEN} at the caret, adds the secret with its note, and keeps it when the reference goes`, async () => {
  const onValue = vi.fn();
  render(
    <Form start={{ mcp: { mcpServers: { gh: { url: "https://x.dev" } } } }} onValue={onValue} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit gh" }));
  await userEvent.click(screen.getByRole("button", { name: "Add header" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name, header 1" }), "Authorization");
  const value = screen.getByRole("textbox", { name: "Value, header 1" }) as HTMLInputElement;
  await userEvent.type(value, "Bearer !");
  value.setSelectionRange(7, 7); // after "Bearer "
  await userEvent.click(screen.getByRole("button", { name: "Insert secret, header 1" }));
  await userEvent.click(await screen.findByRole("button", { name: "GH_TOKEN" }));
  expect(value).toHaveValue(`Bearer \${GH_TOKEN}!`);
  expect(value).toHaveFocus();
  expect(value.selectionStart).toBe(`Bearer \${GH_TOKEN}`.length);
  expect(last(onValue)).toMatchObject({ template: { secrets: ["GH_TOKEN"] } });
  expect(screen.getByText("Adds GH_TOKEN to this agent's secrets.")).toBeInTheDocument();
  // Removing the reference keeps the secret.
  await userEvent.clear(value);
  await userEvent.type(value, "none");
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(last(onValue)).toEqual({
    template: { secrets: ["GH_TOKEN"] },
    mcp: {
      mcpServers: {
        gh: { type: "http", url: "https://x.dev", headers: { Authorization: "none" } },
      },
    },
  });
});

test("Insert secret with no saved caret appends; a secret the template already lists adds nothing", async () => {
  const onValue = vi.fn();
  render(
    <Form
      start={{ mcp: { mcpServers: { gh: { command: "npx", env: { T: "x" } } } } }}
      base={doc({ secrets: ["GH_TOKEN"] })}
      onValue={onValue}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit gh" }));
  await userEvent.click(screen.getByRole("button", { name: "Insert secret, env variable 1" }));
  await userEvent.click(await screen.findByRole("button", { name: "GH_TOKEN" }));
  expect(screen.getByRole("textbox", { name: "Value, env variable 1" })).toHaveValue(
    `x\${GH_TOKEN}`,
  );
  expect(onValue).not.toHaveBeenCalled();
  expect(screen.queryByText(/Adds GH_TOKEN/)).toBeNull();
});

test("Add secret opens the Add secret sheet and inserts the new name on return", async () => {
  const onValue = vi.fn();
  render(<Form start={{ mcp: { mcpServers: { gh: { command: "npx" } } } }} onValue={onValue} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit gh" }));
  await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Name, env variable 1" }), "TOKEN");
  await userEvent.click(screen.getByRole("button", { name: "Insert secret, env variable 1" }));
  const pop = await screen.findByRole("dialog", { name: CONFIG_COPY.insertSecret });
  await userEvent.click(within(pop).getByRole("button", { name: CONFIG_COPY.addSecret }));
  const sheet = getSheetState().parent;
  expect(sheet).toMatchObject({ kind: "add-secret" });
  act(() => completeChild(sheet?.id ?? -1, "NEW_TOKEN"));
  expect(screen.getByRole("textbox", { name: "Value, env variable 1" })).toHaveValue(
    `\${NEW_TOKEN}`,
  );
  expect(last(onValue)).toMatchObject({ template: { secrets: ["NEW_TOKEN"] } });
  expect(screen.getByText("Adds NEW_TOKEN to this agent's secrets.")).toBeInTheDocument();
});

test("Override copies the template's server into this agent's, whole, and opens it", async () => {
  const onValue = vi.fn();
  const remote = { type: "http", url: USER_URL, headers: { Authorization: `Bearer \${GH}` } };
  render(<Form start={{}} base={withServers({ remote })} onValue={onValue} />);
  await userEvent.click(screen.getByRole("button", { name: "Override remote" }));
  expect(last(onValue)).toEqual({ mcp: { mcpServers: { remote } } });
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("remote");
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  expect(within(mcpGroup()).getByText(CONFIG_COPY.overridden)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Override remote" })).toBeNull();
});

test("removing a server moves focus to the next row's remove button", async () => {
  const onValue = vi.fn();
  render(
    <Form
      start={{ mcp: { mcpServers: { a: { command: "x" }, b: { command: "y" } } } }}
      onValue={onValue}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove a" }));
  expect(last(onValue)).toEqual({ mcp: { mcpServers: { b: { command: "y" } } } });
  expect(screen.getByRole("button", { name: "Remove b" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Remove b" }));
  expect(last(onValue)).toEqual({});
  expect(screen.getByRole("button", { name: CONFIG_COPY.addServer })).toHaveFocus();
});

test("an issue on a server or an env name lands under its row", () => {
  render(
    <Form
      start={{
        mcp: { mcpServers: { gh: { command: "npx", env: { T: `\${NOPE}` } } } },
        settings: { env: { LOG: "debug" } },
      }}
      issues={[
        {
          severity: "warning",
          file: "mcp.json",
          message: "NOPE isn't a secret or env var here.",
          path: "mcp.mcpServers.gh.env.T",
        },
        { severity: "error", file: "settings.json", message: "Bad env.", path: "settings.env.LOG" },
      ]}
    />,
  );
  expect(within(mcpGroup()).getByText("NOPE isn't a secret or env var here.")).toBeInTheDocument();
  expect(screen.getByText("Bad env.")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Issues the form can't show" })).toBeNull();
});

test("template deny rules can't be removed in agent mode", () => {
  render(
    <Form
      start={{ settings: { permissions: { deny: ["Bash(curl:*)"] } } }}
      base={doc({}, { permissions: { deny: ["Bash(rm:*)"] } })}
    />,
  );
  const deny = screen.getByRole("group", { name: "Deny rules" });
  const tpl = within(deny).getByRole("list", { name: "From template dev · 1" });
  expect(within(tpl).getByText("Bash(rm:*)")).toBeInTheDocument();
  expect(within(tpl).queryAllByRole("button")).toHaveLength(0);
  expect(within(deny).getAllByRole("button", { name: /^Remove deny rule/ })).toHaveLength(1);
  expect(screen.getAllByText(CONFIG_COPY.rulesHelp)).toHaveLength(2);
  expect(screen.getByText(CONFIG_COPY.notesHelp)).toBeInTheDocument();
});

test("a factory env name is refused, as a variable and as a secret", async () => {
  const onValue = vi.fn();
  render(<Form start={{}} onValue={onValue} />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add variable name" }),
    "OPEN_FACTORY_TOKEN{Enter}",
  );
  expect(document.getElementById("field-env-error")).toHaveTextContent(CONFIG_FIELD_MSG.factoryEnv);
  await userEvent.clear(screen.getByRole("textbox", { name: "Add variable name" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Add variable name" }), "bad-name");
  await userEvent.click(
    within(screen.getByRole("group", { name: "Plain variables" })).getByRole("button", {
      name: "Add",
    }),
  );
  expect(document.getElementById("field-env-error")).toHaveTextContent(CONFIG_FIELD_MSG.envName);
  expect(onValue).not.toHaveBeenCalled();
});

test("a factory name made in Raw JSON shows an error on its row", () => {
  render(
    <Form
      start={{
        settings: { env: { ANTHROPIC_API_KEY: "x" } },
        template: { secrets: ["CLAUDE_CONFIG_DIR"] },
      }}
    />,
  );
  expect(screen.getAllByText(CONFIG_FIELD_MSG.factoryEnv)).toHaveLength(2);
});

test("plain variables: add, edit the value in its own input, remove", async () => {
  const onValue = vi.fn();
  render(
    <Form
      start={{ settings: { theme: "x" } }}
      base={doc({}, { env: { LOG_LEVEL: "info" } })}
      onValue={onValue}
    />,
  );
  // The template's values are never shown; only its names.
  expect(screen.getByRole("list", { name: "From template dev · 1" })).toHaveTextContent(
    "LOG_LEVEL",
  );
  expect(document.body.innerHTML).not.toContain("info");
  await userEvent.type(screen.getByRole("textbox", { name: "Add variable name" }), "LOG_LEVEL");
  await userEvent.type(screen.getByRole("textbox", { name: "Add variable value" }), "debug{Enter}");
  expect(last(onValue)).toEqual({ settings: { theme: "x", env: { LOG_LEVEL: "debug" } } });
  expect(screen.getByText(CONFIG_COPY.overridden)).toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "Value of LOG_LEVEL" }), "!");
  expect(last(onValue)).toEqual({ settings: { theme: "x", env: { LOG_LEVEL: "debug!" } } });
  await userEvent.click(screen.getByRole("button", { name: "Remove variable LOG_LEVEL" }));
  expect(last(onValue)).toEqual({ settings: { theme: "x" } });
});

test("from secrets: rows read 'Available as $NAME'; a picked secret is added", async () => {
  const onValue = vi.fn();
  render(<Form start={{ template: { secrets: ["NPM_TOKEN"] } }} onValue={onValue} />);
  expect(screen.getByText("$NPM_TOKEN").closest("p")).toHaveTextContent("Available as $NPM_TOKEN");
  await userEvent.click(screen.getByRole("combobox", { name: "Add secret to environment" }));
  await userEvent.click(await screen.findByRole("option", { name: "GH_TOKEN" }));
  expect(last(onValue)).toEqual({ template: { secrets: ["NPM_TOKEN", "GH_TOKEN"] } });
});

test("skills: host skills from a picker; template-local skills read-only", async () => {
  const onValue = vi.fn();
  render(
    <Form
      start={{}}
      base={doc({ skills: ["review"] })}
      localSkills={["deploy"]}
      onValue={onValue}
    />,
  );
  expect(screen.getByRole("list", { name: CONFIG_COPY.templateSkill })).toHaveTextContent(
    "deployTemplate skill",
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Add skill" }));
  // "review" is already the template's: not offered again.
  expect(screen.queryByRole("option", { name: /review/ })).toBeNull();
  const release = await screen.findByRole("option", { name: /release/ });
  // Until the picker covers every group, only usable host skills are offered.
  expect(screen.queryByRole("option", { name: /shadowed/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /from-github/ })).toBeNull();
  await userEvent.click(release);
  expect(last(onValue)).toEqual({ template: { skills: ["release"] } });
});

test("plugins are checked as name@marketplace; the help names settings.json per mode", async () => {
  const onValue = vi.fn();
  const { unmount } = render(<Form start={{}} onValue={onValue} />);
  expect(screen.getByText(CONFIG_COPY.pluginsHelpAgent)).toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "Add plugin" }), "formatter{Enter}");
  expect(document.getElementById("field-plugins-error")).toHaveTextContent(
    CONFIG_FIELD_MSG.pluginRef,
  );
  expect(onValue).not.toHaveBeenCalled();
  unmount();
  render(<Form start={doc()} mode="template" />);
  expect(screen.getByText(CONFIG_COPY.pluginsHelpTemplate)).toBeInTheDocument();
});

test("template mode: one group per list and no Override", () => {
  render(<Form mode="template" start={withServers({ gh: { command: "npx" } })} />);
  expect(screen.queryByText(/From template/)).toBeNull();
  expect(screen.getByRole("button", { name: "Edit gh" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Override/ })).toBeNull();
});

const mcpIssue = (path: string, message: string, severity: "error" | "warning" = "error") => ({
  severity,
  file: "mcp.json" as const,
  message,
  path,
});

test("an issue on a dotted server name lands under that server's row", () => {
  render(
    <Form
      start={{ mcp: { mcpServers: { ctx: { command: "a" }, "ctx.io": { url: "https://x.dev" } } } }}
      issues={[mcpIssue("mcp.mcpServers.ctx.io.headers.A", "Bad header.")]}
    />,
  );
  const rows = within(screen.getByRole("group", { name: "MCP servers" })).getAllByRole("listitem");
  expect(rows[1]).toHaveTextContent("Bad header.");
  expect(rows[0]).not.toHaveTextContent("Bad header.");
  expect(document.getElementById("field-mcp-error")).not.toHaveTextContent("Bad header.");
});

test("an issue on a template server lands on its row; one on an unknown server falls to the field's note", () => {
  render(
    <Form
      start={{}}
      base={withServers({ remote: { type: "http", url: "https://x.dev" } })}
      issues={[
        mcpIssue("mcp.mcpServers.remote.headers.A", "Template row issue.", "warning"),
        mcpIssue("mcp.mcpServers.ghost.env.T", "Unknown server issue."),
      ]}
    />,
  );
  const tpl = screen.getByRole("list", { name: "From template dev · 1" });
  expect(within(tpl).getByText("Template row issue.")).toBeInTheDocument();
  const fieldNote = document.getElementById("field-mcp-error");
  expect(fieldNote).toHaveTextContent("Unknown server issue.");
  expect(fieldNote).toHaveAttribute("data-tone", "error");
  expect(screen.queryByRole("region", { name: "Issues the form can't show" })).toBeNull();
});

test("an env issue on a name with no row, and a list issue past the list, fall to the field's note with their severity", () => {
  render(
    <Form
      start={{ settings: { permissions: { allow: ["a"] } } }}
      issues={[
        {
          severity: "warning",
          file: "settings.json",
          message: "Gone env.",
          path: "settings.env.OLD",
        },
        {
          severity: "error",
          file: "settings.json",
          message: "Gone rule.",
          path: "settings.permissions.allow.4",
        },
      ]}
    />,
  );
  expect(document.getElementById("field-env-error")).toHaveTextContent("Gone env.");
  expect(document.getElementById("field-env-error")).toHaveAttribute("data-tone", "warning");
  expect(document.getElementById("field-allow-error")).toHaveTextContent("Gone rule.");
});

test("the form reports an open MCP editor: on open, Done, Cancel, removing it, and unmount", async () => {
  const changes = vi.fn();
  const { unmount } = render(
    <Form
      start={{ mcp: { mcpServers: { gh: { command: "npx" } } } }}
      onEditorOpenChange={changes}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: CONFIG_COPY.addServer }));
  expect(changes.mock.calls).toEqual([[true]]);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(changes.mock.calls).toEqual([[true], [false]]);
  await userEvent.click(screen.getByRole("button", { name: "Edit gh" }));
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(changes.mock.calls).toEqual([[true], [false], [true], [false]]);
  await userEvent.click(screen.getByRole("button", { name: "Edit gh" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove gh" }));
  expect(changes.mock.calls.at(-1)).toEqual([false]);
  await userEvent.click(screen.getByRole("button", { name: CONFIG_COPY.addServer }));
  changes.mockClear();
  unmount();
  expect(changes.mock.calls).toEqual([[false]]);
});

test("Override of an entry the form can't edit copies it and leaves the Raw JSON row", async () => {
  const onValue = vi.fn();
  const odd = { command: "npx", env: { T: 1 } };
  render(<Form start={{}} base={withServers({ odd })} onValue={onValue} />);
  await userEvent.click(screen.getByRole("button", { name: "Override odd" }));
  expect(last(onValue)).toEqual({ mcp: { mcpServers: { odd } } });
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit odd" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove odd" })).toBeInTheDocument();
});
