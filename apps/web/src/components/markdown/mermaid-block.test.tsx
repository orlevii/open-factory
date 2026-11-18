import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MermaidBlock } from "./mermaid-block";

// Simulates the lazy mermaid chunk failing to load (offline, stale deploy).
vi.mock("mermaid", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

test("a failed mermaid chunk load shows the error note and the source", async () => {
  const { container } = render(<MermaidBlock source="graph TD; A-->B" />);
  expect(await screen.findByText("Couldn't render this diagram.")).toBeInTheDocument();
  expect(container.querySelector("pre")).toHaveTextContent("graph TD; A-->B");
});
