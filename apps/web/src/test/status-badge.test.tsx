import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatusBadge } from "@/features/session/status-badge";

test.each([
  ["hibernated", "Hibernated"],
  ["working", "Working"],
  ["idle", "Idle"],
  ["errored", "Errored"],
] as const)("%s renders its label next to the mark", (status, label) => {
  render(<StatusBadge status={status} />);
  expect(screen.getByText(label)).toBeInTheDocument();
});
