import { render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Markdown } from "./markdown";

// The factory runs only if something imports "mermaid", so it doubles as an import counter.
const loads = vi.hoisted(() => ({ mermaid: 0 }));
vi.mock("mermaid", () => {
  loads.mermaid++;
  return { default: { initialize: vi.fn(), render: vi.fn() } };
});

test("a document without a mermaid block never imports mermaid", async () => {
  const { container } = render(
    <Markdown source={"# Title\n\n| a |\n|---|\n| 1 |\n\n```ts\nconst a = 1;\n```"} />,
  );
  // Let the lazy effects settle (the code block highlights), then check.
  await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument());
  expect(loads.mermaid).toBe(0);
});
