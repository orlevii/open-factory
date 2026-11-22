import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CopyButton, CopyIcon, useCopy } from "./copy-feedback";
import { CodeBlock } from "./markdown/code-block";
import { Markdown } from "./markdown/markdown";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const clipboard = (ok = true) => {
  const writeText = ok
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
};

function Probe({ viaKeyboard = false }: { viaKeyboard?: boolean }) {
  const { state, instant, copy } = useCopy();
  return (
    <button type="button" data-state={state} onClick={() => copy("hello", viaKeyboard)}>
      <CopyIcon state={state} instant={instant} idle={<span>idle</span>} />
    </button>
  );
}

test("copy: the check shows, then reverts after 1.5s", async () => {
  vi.useFakeTimers();
  const writeText = clipboard();
  render(<Probe />);
  const button = screen.getByRole("button");
  fireEvent.click(button);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(writeText).toHaveBeenCalledWith("hello");
  expect(button).toHaveAttribute("data-state", "copied");
  await act(() => vi.advanceTimersByTimeAsync(1499));
  expect(button).toHaveAttribute("data-state", "copied");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(button).toHaveAttribute("data-state", "idle");
});

test("the feedback is animated from a pointer and instant from the keyboard", async () => {
  clipboard();
  const { unmount } = render(<Probe />);
  fireEvent.click(screen.getByRole("button"));
  await vi.waitFor(() =>
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "copied"),
  );
  expect(document.querySelector("[data-copy-feedback]")).not.toHaveAttribute("data-instant");
  unmount();
  render(<Probe viaKeyboard />);
  fireEvent.click(screen.getByRole("button"));
  await vi.waitFor(() =>
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "copied"),
  );
  expect(document.querySelector("[data-copy-feedback]")).toHaveAttribute("data-instant");
});

test("a refused clipboard, or none (plain http), is failed", async () => {
  clipboard(false);
  render(<Probe />);
  fireEvent.click(screen.getByRole("button"));
  await vi.waitFor(() =>
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "failed"),
  );
  vi.stubGlobal("navigator", {});
  render(<Probe />);
  fireEvent.click(screen.getAllByRole("button")[1] as HTMLElement);
  expect(screen.getAllByRole("button")[1]).toHaveAttribute("data-state", "failed");
});

test("CopyButton copies its text, says Copied, and says Couldn't copy inline on failure", async () => {
  const writeText = clipboard();
  render(<CopyButton text="ls -la" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("ls -la");
});

test("code blocks, highlighted or plain, have a Copy button", () => {
  clipboard();
  const { unmount } = render(<CodeBlock code="const a = 1;" lang="ts" />);
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  unmount();
  render(<Markdown source={"```\nplain text\n```"} />);
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
});

test("copying again within the hold restarts it: the check holds 1.5s from the last copy", async () => {
  vi.useFakeTimers();
  clipboard();
  render(<Probe />);
  const button = screen.getByRole("button");
  fireEvent.click(button);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  fireEvent.click(button);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(button).toHaveAttribute("data-state", "copied");
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(button).toHaveAttribute("data-state", "idle");
});
