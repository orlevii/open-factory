import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { CopyLink } from "./copy-link";

afterEach(() => vi.unstubAllGlobals());

test("copies the given URL under the given label", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <div className="group">
      <CopyLink
        url="http://x.test/tasks/T-1?comment=c1"
        label="Copy link to this comment"
        focusable
      />
    </div>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Copy link to this comment" }));
  expect(writeText).toHaveBeenCalledWith("http://x.test/tasks/T-1?comment=c1");
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
});

test("the label defaults to Copy link", () => {
  render(<CopyLink url="http://x.test/a" focusable />);
  expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
});
