import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

function Harness() {
  const [v, setV] = useState("");
  return <MarkdownEditor value={v} onChange={setV} />;
}

test("write -> preview -> write keeps the text", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.type(screen.getByRole("textbox"), "# Hello");
  await user.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Write" }));
  expect(screen.getByRole("textbox")).toHaveValue("# Hello");
});
