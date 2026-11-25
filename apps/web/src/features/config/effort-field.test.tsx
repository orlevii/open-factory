import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { doc, ScopeHarness } from "@/test/config-harness";
import { EffortField } from "./effort-field";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

const trigger = () => screen.getByRole("combobox", { name: "Effort" });

test("the inherit option names the template's effort, and Claude Code default when it sets none", () => {
  const { unmount } = render(
    <ScopeHarness start={{}} base={doc({ effort: "high" })}>
      <EffortField />
    </ScopeHarness>,
  );
  expect(trigger()).toHaveTextContent("Template's (high)");
  unmount();
  render(
    <ScopeHarness start={{}} base={doc({ model: "opus" })}>
      <EffortField />
    </ScopeHarness>,
  );
  expect(trigger()).toHaveTextContent("Template's (Claude Code default)");
});

test("an override keeps its value when the template changes, and the inherit label follows the new template", async () => {
  const onValue = vi.fn();
  const { rerender } = render(
    <ScopeHarness start={{}} base={doc({ effort: "high" })} onValue={onValue}>
      <EffortField />
    </ScopeHarness>,
  );
  await userEvent.click(trigger());
  await userEvent.click(await screen.findByRole("option", { name: "low" }));
  expect(onValue).toHaveBeenLastCalledWith({ template: { effort: "low" } });
  expect(trigger()).toHaveTextContent("low");
  rerender(
    <ScopeHarness start={{}} base={doc({ effort: "max" })} onValue={onValue}>
      <EffortField />
    </ScopeHarness>,
  );
  expect(trigger()).toHaveTextContent("low");
  await userEvent.click(screen.getByRole("button", { name: "Use template's effort" }));
  expect(trigger()).toHaveTextContent("Template's (max)");
});
