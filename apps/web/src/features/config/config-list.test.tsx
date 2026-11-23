import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { ConfigList } from "./config-list";
import { CONFIG_FIELD_MSG } from "./messages";

const many = Array.from({ length: 40 }, (_, i) => `Bash(t${i}:*)`);

function Harness({
  inherited,
  start = [],
  onReject = () => {},
}: {
  inherited?: readonly string[];
  start?: string[];
  onReject?: (m: string) => void;
}) {
  const [own, setOwn] = useState<readonly string[]>(start);
  const [error, setError] = useState<string>();
  return (
    <ConfigList
      name="allow"
      label="Allow rules"
      noun="allow rule"
      mono
      own={own}
      inherited={inherited}
      inheritedLabel="From template dev"
      error={error}
      onAdd={(v) => setOwn((l) => [...l, v])}
      onRemove={(i) => setOwn((l) => l.filter((_, j) => j !== i))}
      onReject={(m) => {
        setError(m);
        onReject(m);
      }}
      onInput={() => setError(undefined)}
    />
  );
}

test("two groups, each labelled once with a count; the template group is read-only", () => {
  render(<Harness inherited={["Bash(git:*)"]} start={["Read"]} />);
  const tpl = screen.getByRole("list", { name: "From template dev · 1" });
  const mine = screen.getByRole("list", { name: "This agent · 1" });
  expect(within(tpl).queryByRole("button")).toBeNull();
  expect(within(mine).getByRole("button", { name: "Remove allow rule 1" })).toBeInTheDocument();
});

test("template mode is one unlabelled group", () => {
  render(<Harness start={["Read"]} />);
  expect(screen.getAllByRole("list")).toHaveLength(1);
  expect(screen.queryByText(/This agent/)).toBeNull();
});

test("only the template group collapses past 8; Show all reveals in place and focuses the first revealed row", async () => {
  render(<Harness inherited={many} start={["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]} />);
  const tpl = () => screen.getByRole("list", { name: "From template dev · 40" });
  expect(within(tpl()).getAllByRole("listitem")).toHaveLength(8);
  expect(
    within(screen.getByRole("list", { name: "This agent · 10" })).getAllByRole("listitem"),
  ).toHaveLength(10);
  await userEvent.click(screen.getByRole("button", { name: "Show all 40" }));
  expect(within(tpl()).getAllByRole("listitem")).toHaveLength(40);
  expect(document.activeElement).toHaveTextContent("Bash(t8:*)");
  await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(within(tpl()).getAllByRole("listitem")).toHaveLength(8);
});

test("eight template rows never collapse", () => {
  render(<Harness inherited={many.slice(0, 8)} />);
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

test("Enter adds a row and clears the input; the new row is scrolled into view", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  render(<Harness />);
  const input = screen.getByRole("textbox", { name: "Add allow rule" });
  await userEvent.type(input, "  Bash(ls:*)  {Enter}");
  expect(screen.getByRole("list", { name: undefined })).toHaveTextContent("Bash(ls:*)");
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(scroll).toHaveBeenCalled();
  expect(scroll.mock.contexts.at(-1)).toHaveTextContent("Bash(ls:*)");
  scroll.mockRestore();
});

test("a duplicate is rejected with 'Already in the list.' and expands the group to the match", async () => {
  const onReject = vi.fn();
  render(<Harness inherited={many} onReject={onReject} />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add allow rule" }),
    "Bash(t30:*){Enter}",
  );
  expect(onReject).toHaveBeenCalledWith(CONFIG_FIELD_MSG.duplicate);
  expect(screen.getByText(CONFIG_FIELD_MSG.duplicate)).toBeInTheDocument();
  expect(
    within(screen.getByRole("list", { name: "From template dev · 40" })).getAllByRole("listitem"),
  ).toHaveLength(40);
  expect(
    within(screen.getByRole("list", { name: "This agent · 0" })).queryAllByRole("listitem"),
  ).toHaveLength(0);
  expect(document.getElementById("field-allow-error")).toHaveAttribute("data-shown");
  // Typing again clears the note (FieldNote keeps the text in its hidden layer).
  await userEvent.type(screen.getByRole("textbox", { name: "Add allow rule" }), "x");
  expect(document.getElementById("field-allow-error")).not.toHaveAttribute("data-shown");
});

test("remove moves focus to the next remove button, else to the add input", async () => {
  render(<Harness start={["a", "b", "c"]} />);
  await userEvent.click(screen.getByRole("button", { name: "Remove allow rule 2" }));
  expect(screen.getByRole("list")).not.toHaveTextContent("b");
  // "c" is now row 2.
  expect(screen.getByRole("button", { name: "Remove allow rule 2" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Remove allow rule 2" }));
  expect(screen.getByRole("textbox", { name: "Add allow rule" })).toHaveFocus();
});

test("rows wrap and never truncate; rules are mono", () => {
  render(<Harness start={["Bash(git push:*)"]} />);
  const row = screen.getByRole("listitem");
  expect(row.className).toMatch(/min-h-8/);
  expect(row.className).toMatch(/pointer-coarse:min-h-10/);
  expect(row.className).toMatch(/items-start/);
  expect(row.innerHTML).not.toMatch(/truncate/);
  expect(within(row).getByText("Bash(git push:*)").className).toMatch(/font-mono/);
  expect(within(row).getByText("Bash(git push:*)").className).toMatch(/overflow-wrap:anywhere/);
});

test("read-only shows no add row and no remove buttons", () => {
  render(
    <ConfigList
      name="deny"
      label="Deny rules"
      noun="deny rule"
      own={["a"]}
      readOnly
      onAdd={() => {}}
      onRemove={() => {}}
      onReject={() => {}}
      onInput={() => {}}
    />,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

test("a row note shows under that row, an error as an error and a warning as a warning", () => {
  render(
    <ConfigList
      name="allow"
      label="Allow rules"
      noun="allow rule"
      own={["a", "b", "c"]}
      rowNotes={
        new Map([
          [1, { message: "Bad rule.", severity: "error" as const }],
          [2, { message: "Odd rule.", severity: "warning" as const }],
        ])
      }
      onAdd={() => {}}
      onRemove={() => {}}
      onReject={() => {}}
      onInput={() => {}}
    />,
  );
  const rows = screen.getAllByRole("listitem");
  const err = within(rows[1] as HTMLElement).getByText("Bad rule.").parentElement;
  const warn = within(rows[2] as HTMLElement).getByText("Odd rule.").parentElement;
  expect(err?.className).toMatch(/text-destructive/);
  expect(warn?.className).not.toMatch(/text-destructive/);
  expect(screen.getByRole("button", { name: "Remove allow rule 2" })).toHaveAccessibleDescription(
    "Bad rule.",
  );
});

test("removing one of a repeated value (Raw JSON made it) still focuses the next remove button", async () => {
  render(<Harness start={["a", "a", "b"]} />);
  await userEvent.click(screen.getByRole("button", { name: "Remove allow rule 1" }));
  expect(screen.getByRole("button", { name: "Remove allow rule 1" })).toHaveFocus();
});
