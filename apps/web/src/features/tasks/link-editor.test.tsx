import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LinkEditor, newLinkRow } from "./link-editor";

test("the kind list is not a blur: rows are checked after it closes, not while it is open", async () => {
  const onBlurRow = vi.fn();
  render(
    <TooltipProvider>
      <LinkEditor rows={[newLinkRow()]} onChange={() => {}} errors={{}} onBlurRow={onBlurRow} />
    </TooltipProvider>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Link 1 kind" }));
  await screen.findByRole("listbox");
  expect(onBlurRow).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onBlurRow).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(onBlurRow).toHaveBeenCalledTimes(1);
});

const renderRows = (errors: Record<string, string | undefined>, rows = [newLinkRow()]) =>
  render(
    <TooltipProvider>
      <LinkEditor rows={rows} onChange={() => {}} errors={errors} onBlurRow={() => {}} />
    </TooltipProvider>,
  );

test("each row has its note after the target and before the title", () => {
  const { container } = renderRows({});
  const note = container.querySelector(".field-note") as Element;
  const target = screen.getByLabelText("Link 1 target");
  const title = screen.getByLabelText("Link 1 title");
  expect(target.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(note.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a row error is in its note and described by the target; no loose error paragraph", () => {
  const row = newLinkRow();
  const { container } = renderRows({ [row.id]: "Links must be http(s) URLs." }, [row]);
  const target = screen.getByLabelText("Link 1 target");
  expect(target).toHaveAttribute("aria-describedby", `${row.id}-error`);
  expect(container.querySelector(`#${row.id}-error`)?.textContent).toBe(
    "Links must be http(s) URLs.",
  );
  expect(container.querySelectorAll("p svg").length).toBe(
    container.querySelectorAll(".field-note p svg").length,
  );
});

test("tab order in a row is kind, target, title, then remove", () => {
  renderRows({});
  const order = [
    screen.getByRole("combobox", { name: "Link 1 kind" }),
    screen.getByLabelText("Link 1 target"),
    screen.getByLabelText("Link 1 title"),
    screen.getByRole("button", { name: "Remove link 1" }),
  ];
  for (let i = 0; i < order.length - 1; i++)
    expect(
      (order[i] as HTMLElement).compareDocumentPosition(order[i + 1] as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
});

test("the whole row is the field, so focusing its target brings the note into view too", () => {
  const row = newLinkRow();
  const { container } = renderRows({ [row.id]: "Links must be http(s) URLs." }, [row]);
  const field = screen.getByLabelText("Link 1 target").closest("[data-field]");
  expect(field).not.toBeNull();
  expect(field?.contains(container.querySelector(`#${row.id}-error`))).toBe(true);
  expect(field?.contains(screen.getByLabelText("Link 1 title"))).toBe(true);
});
