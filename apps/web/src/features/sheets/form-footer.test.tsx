import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { FormField } from "@/components/form-field";
import type { Outcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { SheetFormFooter } from "./form-footer";

beforeEach(() => fakeMatchMedia.install(false));

function renderFooter(outcome: Outcome) {
  return render(
    <Sheet open onOpenChange={() => {}}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>T</SheetTitle>
        </SheetHeader>
        <form>
          <SheetFormFooter
            submitLabel="Save"
            pendingLabel="Saving…"
            pending={false}
            restored={false}
            onDiscard={() => {}}
            outcome={outcome}
          />
        </form>
      </SheetContent>
    </Sheet>,
  );
}
const footer = () => document.querySelector("[data-slot$=footer]") as HTMLElement;

test("the outcome line is the footer's first child, before every button", () => {
  renderFooter({ outcomeKey: 0 });
  const line = footer().firstElementChild as HTMLElement;
  expect(line).toHaveClass("form-outcome");
  const submit = screen.getByRole("button", { name: "Save" });
  expect(line.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(line.contains(submit)).toBe(false);
});

test("a notice describes the submit button", () => {
  renderFooter({ outcomeKey: 0, notice: "Restarts the agent." });
  const submit = screen.getByRole("button", { name: "Save" });
  const id = submit.getAttribute("aria-describedby") as string;
  expect(document.getElementById(id)).toHaveTextContent("Restarts the agent.");
});

test("an error hides the notice and is announced", () => {
  renderFooter({ outcomeKey: 1, notice: "Restarts the agent.", error: "Could not save." });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save.");
  expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute("aria-describedby");
  expect(document.querySelector(".form-outcome-notice")).not.toHaveAttribute("data-shown");
});

test("Discard skips the leaving field's validation", () => {
  render(
    <Sheet open onOpenChange={() => {}}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>T</SheetTitle>
        </SheetHeader>
        <form>
          <SheetFormFooter
            submitLabel="Save"
            pendingLabel="Saving…"
            pending={false}
            restored
            onDiscard={() => {}}
            outcome={{ outcomeKey: 0 }}
          />
        </form>
      </SheetContent>
    </Sheet>,
  );
  expect(screen.getByRole("button", { name: "Discard" })).toHaveAttribute("data-skip-validate");
});

/** A one-field sheet form: Title is required once changed. */
function TitleSheet() {
  const form = useRef<HTMLFormElement>(null);
  const [title, setTitle] = useState("x");
  const f = useFieldErrors<"title">({
    form,
    fields: ["title"],
    checks: { title: () => (title === "" ? "Enter a title." : undefined) },
  });
  return (
    <Sheet open onOpenChange={() => {}}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>T</SheetTitle>
        </SheetHeader>
        <form ref={form}>
          <FormField
            name="title"
            label="Title"
            value={title}
            error={f.errors.title}
            onChange={(e) => {
              setTitle(e.target.value);
              f.change("title");
            }}
            onBlur={(e) => f.blur("title", e)}
          />
          <SheetFormFooter
            submitLabel="Save"
            pendingLabel="Saving…"
            pending={false}
            restored={false}
            onDiscard={() => {}}
            outcome={{ outcomeKey: 0 }}
          />
        </form>
      </SheetContent>
    </Sheet>
  );
}

// The header's X comes first in the DOM, the footer's Close last.
test.each([
  ["the header's X", 0],
  ["the footer's Close", 1],
])("pressing %s doesn't count as leaving a changed field", async (_, index) => {
  render(<TitleSheet />);
  const title = screen.getByLabelText("Title");
  await userEvent.clear(title);
  expect(title).toHaveFocus();
  const closes = screen.getAllByRole("button", { name: "Close" });
  expect(closes).toHaveLength(2);
  await userEvent.click(closes[index] as HTMLElement);
  expect(title).not.toHaveAttribute("aria-invalid");
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("the footer's Close and the header's X both carry data-skip-validate", () => {
  renderFooter({ outcomeKey: 0 });
  const closes = screen.getAllByRole("button", { name: "Close" });
  expect(closes).toHaveLength(2);
  for (const c of closes) expect(c).toHaveAttribute("data-skip-validate");
});
