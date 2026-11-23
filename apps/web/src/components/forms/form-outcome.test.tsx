import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FormOutcome, useOutcome } from "@/components/forms/form-outcome";

function Probe() {
  const o = useOutcome();
  return (
    <>
      <FormOutcome outcome={o.outcome} />
      <button type="button" onClick={() => o.fail("Couldn't save. Try again.")}>
        fail
      </button>
    </>
  );
}

test("both live regions are always mounted and never visibility-hidden", () => {
  render(<FormOutcome outcome={{ outcomeKey: 0 }} />);
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
});

test("an identical second failure re-inserts its text", () => {
  const { rerender } = render(
    <FormOutcome outcome={{ error: "Couldn't save. Try again.", outcomeKey: 1 }} />,
  );
  const first = screen.getByText("Couldn't save. Try again.");
  rerender(<FormOutcome outcome={{ error: "Couldn't save. Try again.", outcomeKey: 2 }} />);
  expect(screen.getByText("Couldn't save. Try again.")).not.toBe(first);
});

test("an error hides the notice; the notice returns when it clears", () => {
  const { container, rerender } = render(
    <FormOutcome noticeId="n" outcome={{ notice: "@ada restarts when idle.", outcomeKey: 0 }} />,
  );
  expect(container.querySelector("#n")).toHaveAttribute("data-shown");
  rerender(
    <FormOutcome
      noticeId="n"
      outcome={{
        notice: "@ada restarts when idle.",
        error: "Couldn't save. Try again.",
        outcomeKey: 1,
      }}
    />,
  );
  expect(container.querySelector("#n")).not.toHaveAttribute("data-shown");
  rerender(
    <FormOutcome noticeId="n" outcome={{ notice: "@ada restarts when idle.", outcomeKey: 1 }} />,
  );
  expect(container.querySelector("#n")).toHaveAttribute("data-shown");
});

test("useOutcome bumps the key with every fail, so a repeat is re-inserted", () => {
  render(<Probe />);
  fireEvent.click(screen.getByText("fail"));
  const first = screen.getByText("Couldn't save. Try again.");
  fireEvent.click(screen.getByText("fail"));
  expect(screen.getByText("Couldn't save. Try again.")).not.toBe(first);
});

test("success goes to the status region; pending only to the sr-only status", () => {
  render(<FormOutcome pending="Saving…" outcome={{ success: "Saved.", outcomeKey: 1 }} />);
  expect(screen.getByText("Saved.").closest("[role=status]")).toBeInTheDocument();
  expect(screen.getByText("Saving…")).toHaveClass("sr-only");
});
