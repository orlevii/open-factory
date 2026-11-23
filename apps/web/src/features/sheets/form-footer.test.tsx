import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { Outcome } from "@/components/forms/form-outcome";
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
