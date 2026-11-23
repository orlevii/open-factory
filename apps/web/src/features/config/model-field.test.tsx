import { MODEL_ALIASES, MODEL_IDS, MODEL_MSG } from "@open-factory/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { doc, ScopeHarness } from "@/test/config-harness";
import { CONFIG_FIELD_MSG } from "./messages";
import { ModelField } from "./model-field";
import { ConfigFormScope } from "./scope";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

const trigger = () => screen.getByRole("combobox", { name: "Model" });
async function pick(name: string) {
  await userEvent.click(trigger());
  await userEvent.click(await screen.findByRole("option", { name }));
}

test("agent mode: inherit first, the inherited value in the help line, then the groups and Custom", async () => {
  render(
    <ScopeHarness start={{}} base={doc({ model: "claude-sonnet-5-5[1m]" })}>
      <ModelField />
    </ScopeHarness>,
  );
  expect(trigger()).toHaveTextContent("Inherit from template");
  expect(screen.getByText("From template: claude-sonnet-5-5[1m]")).toBeInTheDocument();
  await userEvent.click(trigger());
  const box = await screen.findByRole("listbox");
  expect(
    within(box)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Inherit from template", ...MODEL_ALIASES, ...MODEL_IDS, "Custom…"]);
  expect(within(box).getByText("Aliases")).toBeInTheDocument();
  expect(within(box).getByText("Model ids")).toBeInTheDocument();
});

test("template mode: the first item is Claude Code default, with no inherited help", () => {
  render(
    <ScopeHarness mode="template" start={doc()}>
      <ModelField />
    </ScopeHarness>,
  );
  expect(trigger()).toHaveTextContent("Claude Code default");
  expect(screen.queryByText(/From template/)).toBeNull();
});

test("picking a model overrides it: 'This agent' and 'Use template's' clear the override", async () => {
  const onValue = vi.fn();
  render(
    <ScopeHarness start={{}} base={doc({ model: "sonnet" })} onValue={onValue}>
      <ModelField />
    </ScopeHarness>,
  );
  expect(screen.queryByText("This agent")).toBeNull();
  await pick("opus");
  expect(onValue).toHaveBeenLastCalledWith({ template: { model: "opus" } });
  expect(screen.getByText("This agent")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Use template's model" }));
  expect(onValue).toHaveBeenLastCalledWith({});
  expect(trigger()).toHaveTextContent("Inherit from template");
  expect(trigger()).toHaveFocus();
});

test("Custom reveals a focused mono input checked by the model schema", async () => {
  const onValue = vi.fn();
  render(
    <ScopeHarness start={{}} base={doc()} onValue={onValue}>
      <ModelField />
    </ScopeHarness>,
  );
  await pick("Custom…");
  const input = screen.getByRole("textbox", { name: "Custom model" });
  expect(input).toHaveFocus();
  expect(input.className).toMatch(/font-mono/);
  expect(screen.getByText(MODEL_MSG.chars)).toBeInTheDocument();
  await userEvent.type(input, "my model");
  expect(onValue).toHaveBeenLastCalledWith({ template: { model: "my model" } });
  await userEvent.tab();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(document.getElementById("field-model-custom-error")).toHaveAttribute("data-shown");
});

test("a stored model that isn't listed shows as Custom with its value", () => {
  render(
    <ScopeHarness start={{ template: { model: "claude-opus-5-5[1m]" } }} base={doc()}>
      <ModelField />
    </ScopeHarness>,
  );
  expect(trigger()).toHaveTextContent("Custom…");
  expect(screen.getByRole("textbox", { name: "Custom model" })).toHaveValue("claude-opus-5-5[1m]");
});

test("a wrongly typed model reads 'Edit this in Raw JSON.' and jumps there", async () => {
  const onShowRaw = vi.fn();
  render(
    <ScopeHarness start={{ template: { model: 5 } }} base={doc()} onShowRaw={onShowRaw}>
      <ModelField />
    </ScopeHarness>,
  );
  expect(screen.getByText(CONFIG_FIELD_MSG.editInRaw)).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show in Raw JSON" }));
  expect(onShowRaw).toHaveBeenCalledWith({ path: "template.model" });
});

test("a server issue on the model path lands on the field; a conflict reads 'Also changed elsewhere.'", () => {
  const { unmount } = render(
    <ScopeHarness
      start={{ template: { model: "opus" } }}
      base={doc()}
      issues={[
        {
          severity: "error",
          file: "settings.json",
          path: "template.model",
          message: "Not a model here.",
        },
      ]}
    >
      <ModelField />
    </ScopeHarness>,
  );
  expect(document.getElementById("field-model-error")).toHaveTextContent("Not a model here.");
  unmount();
  render(
    <ScopeHarness
      start={{ template: { model: "opus" } }}
      base={doc()}
      conflicts={["template.model"]}
    >
      <ModelField />
    </ScopeHarness>,
  );
  expect(screen.getByText(CONFIG_FIELD_MSG.alsoChanged)).toBeInTheDocument();
});

function Outside() {
  const [value, setValue] = useState<unknown>({});
  return (
    <>
      <button type="button" onClick={() => setValue({ template: { model: "haiku" } })}>
        Raw edit
      </button>
      <button type="button" onClick={() => setValue({})}>
        Discard
      </button>
      <ConfigFormScope
        mode="agent"
        value={value}
        base={doc()}
        issues={[]}
        onChange={(u) => setValue(u)}
      >
        <ModelField />
      </ConfigFormScope>
    </>
  );
}

test("Custom closes when the model changes from outside (a Raw edit, a Discard)", async () => {
  render(<Outside />);
  await pick("Custom…");
  await userEvent.type(screen.getByRole("textbox", { name: "Custom model" }), "x");
  await userEvent.click(screen.getByRole("button", { name: "Raw edit" }));
  expect(screen.queryByRole("textbox", { name: "Custom model" })).toBeNull();
  expect(trigger()).toHaveTextContent("haiku");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  // Opened at inherit with nothing typed, then the draft is discarded: the model is the same, Custom still closes.
  await pick("Custom…");
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("textbox", { name: "Custom model" })).toBeNull();
  expect(trigger()).toHaveTextContent("Inherit from template");
});

test("typing a listed value in Custom keeps Custom open", async () => {
  render(<Outside />);
  await pick("Custom…");
  await userEvent.type(screen.getByRole("textbox", { name: "Custom model" }), "opus");
  expect(screen.getByRole("textbox", { name: "Custom model" })).toHaveValue("opus");
  expect(trigger()).toHaveTextContent("Custom…");
});
