import type { TemplateIssue } from "@open-factory/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { doc, ScopeHarness } from "@/test/config-harness";
import { ConfigForm } from "./config-form";
import { ListField } from "./list-field";
import { CONFIG_FIELD_MSG } from "./messages";
import { NumberField } from "./number-field";
import { rebase } from "./rebase";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

const issue = (
  path: string | undefined,
  message: string,
  severity: "error" | "warning" = "error",
): TemplateIssue => ({
  severity,
  file: "settings.json",
  message,
  ...(path ? { path } : {}),
});

function Form({
  start,
  onValue,
  issues = [],
  conflicts,
  onShowRaw,
}: {
  start: unknown;
  onValue?: (v: unknown) => void;
  issues?: TemplateIssue[];
  conflicts?: string[];
  onShowRaw?: () => void;
}) {
  const [value, setValue] = useState<unknown>(start);
  return (
    <ConfigForm
      mode="agent"
      value={value}
      base={doc({ model: "sonnet", effort: "high" })}
      templateName="dev"
      issues={issues}
      conflicts={conflicts}
      onShowRaw={onShowRaw}
      onChange={(u) =>
        setValue((p: unknown) => {
          const n = u(p);
          onValue?.(n);
          return n;
        })
      }
    />
  );
}

test("the form renders the Model section with model and effort", () => {
  render(<Form start={{}} />);
  expect(screen.getByRole("heading", { level: 2, name: "Model" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(
    "Inherit from template",
  );
  expect(screen.getByText("From template: high")).toBeInTheDocument();
});

test("an unknown settings key survives a form edit", async () => {
  const onValue = vi.fn();
  render(
    <Form
      start={{ settings: { theme: "dark", permissions: { allow: ["a"] } }, extra: 1 }}
      onValue={onValue}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Effort" }));
  await userEvent.click(await screen.findByRole("option", { name: "max" }));
  expect(onValue).toHaveBeenLastCalledWith({
    settings: { theme: "dark", permissions: { allow: ["a"] } },
    extra: 1,
    template: { effort: "max" },
  });
});

test("wrong types anywhere never throw: each field reads 'Edit this in Raw JSON.'", () => {
  render(<Form start={{ template: { model: 5, effort: "turbo" }, settings: "x" }} />);
  expect(screen.getAllByText(CONFIG_FIELD_MSG.editInRaw)).toHaveLength(2);
});

test("a non-object draft (valid JSON, wrong schema) renders tolerantly", () => {
  render(<Form start={[1, 2]} />);
  expect(screen.getAllByText(CONFIG_FIELD_MSG.editInRaw)).toHaveLength(2);
});

test("issues no field owns are listed at the top with 'Show in Raw JSON'; owned ones land on their field", async () => {
  const onShowRaw = vi.fn();
  render(
    <Form
      start={{ template: { model: "opus" } }}
      onShowRaw={onShowRaw}
      issues={[
        issue("settings.hooks.PreToolUse.0", "Unknown hook."),
        issue(undefined, "At most 256 KB in total."),
        issue("template.model", "Not a model here."),
      ]}
    />,
  );
  const block = screen.getByRole("region", { name: "Issues the form can't show" });
  expect(within(block).getAllByRole("listitem")).toHaveLength(2);
  expect(within(block).queryByText("Not a model here.")).toBeNull();
  expect(document.getElementById("field-model-error")).toHaveTextContent("Not a model here.");
  await userEvent.click(
    within(block).getAllByRole("button", { name: "Show in Raw JSON" })[0] as HTMLElement,
  );
  expect(onShowRaw).toHaveBeenCalledWith({
    path: "settings.hooks.PreToolUse.0",
    file: "settings.json",
    line: undefined,
  });
});

test("no issues, no block", () => {
  render(<Form start={{}} />);
  expect(screen.queryByRole("region", { name: "Issues the form can't show" })).toBeNull();
});

test("ListField: skills: 'release' doesn't throw and reads 'Edit this in Raw JSON.'", () => {
  render(
    <ScopeHarness start={{ template: { skills: "release" } }} base={doc({ skills: ["a"] })}>
      <ListField field="skills" label="Skills" noun="skill" mono />
    </ScopeHarness>,
  );
  expect(screen.getByText(CONFIG_FIELD_MSG.editInRaw)).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("ListField: the template's rows are read-only, this agent's are the overlay's, and an add keeps unknown keys", async () => {
  const onValue = vi.fn();
  render(
    <ScopeHarness
      start={{ settings: { theme: "dark", permissions: { allow: ["Read"] } } }}
      base={doc({}, { permissions: { allow: ["Bash(git:*)"] } })}
      onValue={onValue}
    >
      <ListField field="allow" label="Allow rules" noun="allow rule" mono />
    </ScopeHarness>,
  );
  expect(screen.getByRole("list", { name: "From template dev · 1" })).toHaveTextContent(
    "Bash(git:*)",
  );
  expect(screen.getByRole("list", { name: "This agent · 1" })).toHaveTextContent("Read");
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add allow rule" }),
    "Bash(ls:*){Enter}",
  );
  expect(onValue).toHaveBeenLastCalledWith({
    settings: { theme: "dark", permissions: { allow: ["Read", "Bash(ls:*)"] } },
  });
  await userEvent.click(screen.getByRole("button", { name: "Remove allow rule 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove allow rule 1" }));
  // The emptied list and its emptied containers are pruned; the unknown key stays.
  expect(onValue).toHaveBeenLastCalledWith({ settings: { theme: "dark" } });
});

test("ListField: an item issue shows under its row", () => {
  render(
    <ScopeHarness
      start={{ settings: { permissions: { deny: ["a", "b"] } } }}
      base={doc()}
      issues={[issue("settings.permissions.deny.1", "Bad rule.")]}
    >
      <ListField field="deny" label="Deny rules" noun="deny rule" mono />
    </ScopeHarness>,
  );
  const rows = within(screen.getByRole("list", { name: "This agent · 2" })).getAllByRole(
    "listitem",
  );
  expect(rows[1]).toHaveTextContent("Bad rule.");
});

test("NumberField: the placeholder is the inherited value; digits only; empty inherits", async () => {
  const onValue = vi.fn();
  render(
    <ScopeHarness start={{}} base={doc({ warm_window_minutes: 70 })} onValue={onValue}>
      <NumberField field="warmWindow" label="Warm window" unit="minutes" />
    </ScopeHarness>,
  );
  const input = screen.getByRole("textbox", { name: "Warm window" });
  expect(input).toHaveAttribute("placeholder", "70");
  expect(screen.getByText("From template: 70 minutes")).toBeInTheDocument();
  await userEvent.type(input, "9x0");
  expect(onValue).toHaveBeenLastCalledWith({ template: { warm_window_minutes: 90 } });
  expect(screen.getByText("This agent")).toBeInTheDocument();
  await userEvent.clear(input);
  expect(onValue).toHaveBeenLastCalledWith({});
});

test("NumberField: out of range is flagged when the field is left", async () => {
  render(
    <ScopeHarness start={{}} base={doc()}>
      <NumberField field="maxLiveSpawns" label="Max live spawns" />
    </ScopeHarness>,
  );
  const input = screen.getByRole("textbox", { name: "Max live spawns" });
  await userEvent.type(input, "51");
  await userEvent.tab();
  expect(document.getElementById("field-maxLiveSpawns-error")).toHaveTextContent(
    CONFIG_FIELD_MSG.maxLiveSpawnsRange,
  );
  expect(input).toHaveAttribute("aria-invalid", "true");
});

test("read-only: controls are disabled and lists have no add row", () => {
  render(
    <ScopeHarness start={{ settings: { permissions: { allow: ["a"] } } }} base={null} readOnly>
      <ListField field="allow" label="Allow rules" noun="allow rule" />
      <NumberField field="warmWindow" label="Warm window" />
    </ScopeHarness>,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Warm window" })).toHaveAttribute("readonly");
});

test("every rebase conflict lands on a field or in the issues block", () => {
  const { conflicts } = rebase<unknown>(
    {
      template: { model: "opus" },
      settings: { theme: "a" },
      mcp: { mcpServers: { gh: { url: "1" } } },
    },
    {
      template: { model: "haiku" },
      settings: { theme: "b" },
      mcp: { mcpServers: { gh: { url: "2" } } },
    },
    {
      template: { model: "sonnet" },
      settings: { theme: "c" },
      mcp: { mcpServers: { gh: { url: "3" } } },
    },
  );
  expect(conflicts).toEqual(["template.model", "settings.theme", "mcp.mcpServers.gh"]);
  render(<Form start={{ template: { model: "haiku" } }} conflicts={conflicts} />);
  // template.model: on the field.
  expect(document.getElementById("field-model-error")).toHaveTextContent(
    CONFIG_FIELD_MSG.alsoChanged,
  );
  const block = screen.getByRole("region", { name: "Issues the form can't show" });
  // settings.theme: no field owns it, so the block lists it.
  expect(within(block).getByText("settings.theme")).toBeInTheDocument();
  // mcp.mcpServers.gh: the MCP field (C3) owns it, so it isn't repeated in the block.
  expect(within(block).queryByText("mcp.mcpServers.gh")).toBeNull();
  expect(within(block).getAllByRole("listitem")).toHaveLength(1);
});
