import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderInRouter } from "@/test/render-in-router";
import { BlockedMarker, StatusLabel } from "./status-label";
import { TaskBadge } from "./task-badge";

/** The marker's label, matched on its whole text (the keys are separate spans, so getByText(string) can't);
 *  the wrapper that also holds the icon is excluded. */
const blockedLabel = (text: string) => (_: string, el: Element | null) =>
  !!el && el.textContent === text && el.children.length > 0 && !el.querySelector("svg");

test("a linked badge: key, separator, title; its name is 'Task T-42: Plan the billing migration'", async () => {
  renderInRouter(<TaskBadge taskKey="T-42" title="Plan the billing migration" link />);
  const link = await screen.findByRole("link", { name: "Task T-42: Plan the billing migration" });
  expect(link).toHaveAttribute("href", "/tasks/T-42");
  expect(link).toHaveTextContent("T-42·Plan the billing migration");
});

test("a comment target adds ?comment=", async () => {
  renderInRouter(<TaskBadge taskKey="T-42" title="x" link={{ comment: "c9" }} />);
  expect(await screen.findByRole("link")).toHaveAttribute("href", "/tasks/T-42?comment=c9");
});

test("without a title only the key shows; unlinked it is plain text", async () => {
  renderInRouter(<TaskBadge taskKey="T-7" />);
  expect(await screen.findByText("T-7")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText("·")).toBeNull();
});

test("a title is plain text: markup is shown as typed", async () => {
  const { container } = renderInRouter(<TaskBadge taskKey="T-1" title="<b>x</b>" />);
  expect(await screen.findByText("<b>x</b>")).toBeInTheDocument();
  expect(container.querySelector("b")).toBeNull();
});

test.each([
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
] as const)("%s shows its icon (aria-hidden) and the label %s", (status, label) => {
  const { container } = renderInRouter(<StatusLabel status={status} />);
  return screen.findByText(label).then(() => {
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

test("the blocked marker lists the keys and renders nothing when none", async () => {
  const { container } = renderInRouter(<BlockedMarker keys={["T-41", "T-44"]} />);
  expect(await screen.findByText(blockedLabel("Blocked by T-41, T-44"))).toBeInTheDocument();
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});
