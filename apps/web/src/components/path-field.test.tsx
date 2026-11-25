import { MSG } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useRef, useState } from "react";
import { expect, test } from "vitest";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { checkHostPath, PathField } from "@/components/path-field";
import { FORM_MSG } from "@/lib/form-messages";
import { createQueryClient } from "@/lib/query-client";

const renderWithQuery = (ui: ReactNode) =>
  render(<QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>);

test.each([
  ["", FORM_MSG.enterPath],
  ["   ", FORM_MSG.enterPath],
  ["code/web", MSG.hostPathStart],
  ["~other/x", MSG.hostPathStart],
  ["~", undefined],
  ["~/code/web", undefined],
  [" /srv/app ", undefined],
])("checkHostPath(%j)", (p, msg) => expect(checkHostPath(p)).toBe(msg));

test("the label row holds the help button; the input is mono with no autocomplete", () => {
  renderWithQuery(
    <PathField name="p" label="Path" help="Some help." value="" onChange={() => {}} />,
  );
  const input = screen.getByLabelText("Path");
  expect(input).toHaveClass("font-mono");
  expect(input).toHaveAttribute("autocomplete", "off");
  expect(input).toHaveAttribute("spellcheck", "false");
  expect(screen.getByRole("button", { name: "How do I find this path?" })).toBeInTheDocument();
});

function Harness() {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState("");
  const f = useFieldErrors<"path">({
    form,
    fields: ["path"],
    checks: { path: () => checkHostPath(v) },
  });
  return (
    <form ref={form}>
      <PathField
        name="path"
        label="Path"
        help="Some help."
        value={v}
        error={f.errors.path}
        onChange={(e) => {
          setV(e.target.value);
          f.change("path");
        }}
        onBlur={(e) => f.blur("path", e)}
      />
    </form>
  );
}

test("AC6 click: opening the help does not flag the half-typed path", async () => {
  renderWithQuery(<Harness />);
  const input = screen.getByLabelText("Path");
  await userEvent.type(input, "code");
  await userEvent.click(screen.getByRole("button", { name: "How do I find this path?" }));
  expect(input).not.toHaveAttribute("aria-invalid");
  expect(input).toHaveAccessibleDescription("Some help.");
});

test("AC6 keyboard: Shift+Tab to the help button does not flag the path", async () => {
  renderWithQuery(<Harness />);
  const input = screen.getByLabelText("Path");
  await userEvent.click(input);
  await userEvent.keyboard("code");
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(screen.getByRole("button", { name: "How do I find this path?" })).toHaveFocus();
  expect(input).not.toHaveAttribute("aria-invalid");
});
