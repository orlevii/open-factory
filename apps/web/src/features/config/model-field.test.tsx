import { MODEL_MSG } from "@open-factory/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { CONFIG_FIELD_MSG } from "./messages";
import { ModelField } from "./model-field";
import { doc, ScopeHarness } from "./test-harness";

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
  ).toEqual([
    "Inherit from template",
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "Custom…",
  ]);
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
  render(
    <ScopeHarness
      start={{ template: { model: "opus" } }}
      base={doc()}
      conflicts={["template.model"]}
      issues={[]}
    >
      <ModelField />
    </ScopeHarness>,
  );
  expect(screen.getByText(CONFIG_FIELD_MSG.alsoChanged)).toBeInTheDocument();
});
