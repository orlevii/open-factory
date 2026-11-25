import { fireEvent, render, screen, within } from "@testing-library/react";
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
      <button type="button" onClick={() => o.succeed("Saved.")}>
        succeed
      </button>
      <button type="button" onClick={o.clear}>
        clear
      </button>
      <output data-testid="key">{o.outcome.outcomeKey}</output>
    </>
  );
}

test("both live regions are always mounted, empty", () => {
  render(<FormOutcome outcome={{ outcomeKey: 0 }} />);
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(2);
  expect(statuses.filter((el) => el.classList.contains("sr-only"))).toHaveLength(1);
});

test("the error lands inside the alert region, next to its action", () => {
  render(
    <FormOutcome
      outcome={{
        error: "Couldn't save.",
        action: <button type="button">Retry</button>,
        outcomeKey: 1,
      }}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(within(alert).getByText("Couldn't save.")).toBeInTheDocument();
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

test("an error wins over success", () => {
  render(<FormOutcome outcome={{ error: "Bad.", success: "Saved.", outcomeKey: 1 }} />);
  expect(screen.getByText("Bad.")).toBeInTheDocument();
  expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
});

test("success hides the notice", () => {
  const { container } = render(
    <FormOutcome
      noticeId="n"
      outcome={{ notice: "Heads up.", success: "Saved.", outcomeKey: 1 }}
    />,
  );
  expect(container.querySelector("#n")).not.toHaveAttribute("data-shown");
});

test("an empty-string or false error is treated as none", () => {
  const { rerender } = render(
    <FormOutcome outcome={{ error: "", success: "Saved.", outcomeKey: 1 }} />,
  );
  expect(screen.getByText("Saved.")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  rerender(<FormOutcome outcome={{ error: false, success: "Saved.", outcomeKey: 1 }} />);
  expect(screen.getByText("Saved.")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
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

test("succeed() bumps the key; clear() drops the message and keeps the key", () => {
  render(<Probe />);
  fireEvent.click(screen.getByText("succeed"));
  expect(screen.getByText("Saved.")).toBeInTheDocument();
  expect(screen.getByTestId("key")).toHaveTextContent("1");
  fireEvent.click(screen.getByText("fail"));
  expect(screen.getByTestId("key")).toHaveTextContent("2");
  expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("clear"));
  expect(screen.queryByText("Couldn't save. Try again.")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  expect(screen.getByTestId("key")).toHaveTextContent("2");
});

const seen: unknown[][] = [];

function Ids() {
  const o = useOutcome();
  seen.push([o.fail, o.succeed, o.clear]);
  return (
    <button type="button" onClick={() => o.fail("x")}>
      go
    </button>
  );
}

test("fail, succeed and clear keep their identity across renders", () => {
  seen.length = 0;
  render(<Ids />);
  fireEvent.click(screen.getByText("go"));
  expect(seen.length).toBeGreaterThan(1);
  expect(seen[1]).toEqual(seen[0]);
});
