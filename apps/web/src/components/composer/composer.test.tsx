import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readDraft } from "@/lib/drafts";
import {
  Composer,
  type ComposerHandle,
  FILES_NOTE,
  SubmitError,
  type SubmitOptions,
} from "./composer";

/** Renders of the composer's textarea: the composer rendered. */
const boxRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/components/ui/textarea", async (orig) => {
  const m = await orig<typeof import("@/components/ui/textarea")>();
  return {
    ...m,
    Textarea: (p: Parameters<typeof m.Textarea>[0]) => {
      boxRenders.n++;
      return <m.Textarea {...p} />;
    },
  };
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

const noSubmit = async () => {};
function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const ref = createRef<ComposerHandle>();
  const onSubmit = vi.fn<(text: string, o: SubmitOptions) => Promise<void>>(noSubmit);
  const props = {
    draftKey: "agent:dev",
    placeholder: "Message Dev",
    label: "Message to Dev",
    onSubmit,
    ...over,
  };
  const r = render(<Composer ref={ref} {...props} />);
  return {
    ref,
    onSubmit,
    box: screen.getByRole("textbox", { name: "Message to Dev" }),
    rerender: (more: Partial<Parameters<typeof Composer>[0]>) =>
      r.rerender(<Composer ref={ref} {...props} {...more} />),
  };
}

test("one frame holds the textarea and a 32px toolbar", () => {
  const { box } = setup();
  const frame = box.closest("[data-composer-frame]");
  expect(frame).not.toBeNull();
  const toolbar = frame?.querySelector("[data-composer-toolbar]");
  expect(toolbar).not.toBeNull();
  expect(toolbar).toHaveClass("h-8");
  expect(toolbar?.contains(screen.getByRole("button", { name: "Send" }))).toBe(true);
});

test("growth is capped at 6 lines or 35svh below md, 12 lines or 40svh from md, then it scrolls", () => {
  const { box } = setup();
  expect(box).toHaveClass(
    "max-h-[min(calc(6lh_+_1rem),35svh)]",
    "md:max-h-[min(calc(12lh_+_1rem),40svh)]",
    "min-h-[calc(2lh_+_1rem)]",
    "overflow-y-auto",
  );
});

test("Send is labelled Send, disabled-shaped while empty, primary at once when there is text", async () => {
  const { box } = setup();
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toBeDisabled();
  expect(send).toHaveAttribute("data-variant", "default");
  // A keyboard action: no transition between the disabled plate and graphite.
  expect(send).toHaveClass("transition-none");
  await userEvent.type(box, "x");
  expect(send).toBeEnabled();
  await userEvent.clear(box);
  await userEvent.type(box, "   ");
  expect(send).toBeDisabled();
});

test("Stop's slot keeps its width with no turn open (an invisible stand-in), so a turn edge never re-wraps", () => {
  const onStop = vi.fn(async () => {});
  const { rerender } = setup({ onStop, stopEpoch: 1, turnOpen: false });
  const slot = document.querySelector("[data-stop-slot]");
  expect(slot).not.toBeNull();
  const standIn = slot?.querySelector("[data-stop-stand-in]");
  expect(standIn).toHaveClass("invisible");
  expect(standIn).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  rerender({ onStop, stopEpoch: 2, turnOpen: true });
  expect(document.querySelector("[data-stop-slot]")).toBe(slot);
  expect(slot?.querySelector("[data-stop-stand-in]")).toBe(standIn);
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  // The toolbar never wraps: the hint is what shrinks.
  expect(document.querySelector("[data-composer-toolbar]")).toHaveClass("flex-nowrap");
});

test("no Stop slot where there is nothing to stop", () => {
  setup();
  expect(document.querySelector("[data-stop-slot]")).toBeNull();
});

test("the hint sits in the toolbar, takes the free room and truncates first", () => {
  setup({ hintMode: "working", turnOpen: true });
  const hint = document.querySelector("[data-composer-hint]");
  expect(hint?.closest("[data-composer-toolbar]")).not.toBeNull();
  expect(hint).toHaveClass("min-w-0", "flex-1", "truncate");
  expect(hint).toHaveTextContent(
    /^Arrives at the agent's next step\. (⌥|Alt)↵ to interrupt instead\.$/,
  );
});

test("hint modes are primitives: coarse points at Stop, none is an empty reserved line", () => {
  const { rerender } = setup({ hintMode: "coarse", turnOpen: true });
  expect(document.querySelector("[data-composer-hint]")).toHaveTextContent(
    "Arrives at the agent's next step. Stop first to interrupt.",
  );
  rerender({ hintMode: "none", turnOpen: false });
  expect(document.querySelector("[data-composer-hint]")).toBeEmptyDOMElement();
});

test("Enter submits the text with a fresh clientMessageId and no attachments; the box empties at once", async () => {
  const { box, onSubmit } = setup();
  await userEvent.type(box, "hello{Enter}");
  expect(box).toHaveValue("");
  expect(onSubmit).toHaveBeenCalledWith("hello", {
    urgent: false,
    clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    attachments: [],
  });
});

test("⌥Enter submits urgent; the IME guard comes first", async () => {
  const { box, onSubmit } = setup();
  await userEvent.type(box, "now");
  fireEvent.keyDown(box, { key: "Enter", altKey: true, isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  expect(onSubmit.mock.calls[0]?.[1].urgent).toBe(true);
});

test("a rejected submit puts the text back after anything typed since and shows the reason", async () => {
  let fail: (e: unknown) => void = () => {};
  const { box } = setup({
    onSubmit: () =>
      new Promise((_, rej) => {
        fail = rej;
      }),
  });
  await userEvent.type(box, "hello{Enter}");
  await userEvent.type(box, "more");
  await act(async () => fail(new SubmitError("Boom")));
  expect(box).toHaveValue("more\nhello");
  expect(screen.getByRole("alert")).toHaveTextContent("Boom");
});

test("a validation message keeps the text and calls nothing", async () => {
  const { box, onSubmit } = setup({ validate: (t) => (t.length > 3 ? "Too long" : undefined) });
  await userEvent.type(box, "hello{Enter}");
  expect(box).toHaveValue("hello");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Too long");
});

test("the handle: insertAtStart once, prefillIfEmpty only into an empty box and not as a draft", () => {
  const { ref, box } = setup({ draftKey: "task:T-1" });
  act(() => {
    expect(ref.current?.prefillIfEmpty("@dev ")).toBe(true);
  });
  expect(box).toHaveValue("@dev ");
  expect(box).not.toHaveFocus();
  expect(readDraft("task:T-1")).toBe("");
  act(() => {
    expect(ref.current?.prefillIfEmpty("@ada ")).toBe(false);
  });
  act(() => ref.current?.insertAtStart("@ada "));
  act(() => ref.current?.insertAtStart("@ada "));
  expect(box).toHaveValue("@ada @dev ");
  act(() => ref.current?.focus());
  expect(box).toHaveFocus();
});

test("without attachments a pasted file is ignored with the note; text still pastes", () => {
  const { box } = setup();
  const file = new File(["x"], "a.png", { type: "image/png" });
  const pasted = fireEvent.paste(box, {
    clipboardData: { files: [file], getData: () => "", types: ["Files"] },
  });
  expect(pasted).toBe(false); // default prevented: nothing inserted
  expect(screen.getByText(FILES_NOTE)).toBeInTheDocument();
  expect(FILES_NOTE).toBe("Files can be sent in an agent's session");
  const text = fireEvent.paste(box, {
    clipboardData: { files: [file], getData: () => "words", types: ["text/plain", "Files"] },
  });
  expect(text).toBe(true);
});

test("without attachments a dropped file is ignored with the note", () => {
  const { box } = setup();
  const frame = box.closest("[data-composer-frame]") as HTMLElement;
  const file = new File(["x"], "a.txt", { type: "text/plain" });
  expect(fireEvent.dragOver(frame, { dataTransfer: { files: [file], types: ["Files"] } })).toBe(
    false,
  );
  expect(fireEvent.drop(frame, { dataTransfer: { files: [file], types: ["Files"] } })).toBe(false);
  expect(screen.getByText(FILES_NOTE)).toBeInTheDocument();
});

test("preview: a Write/Preview toggle in the toolbar renders the markdown in place", async () => {
  const { box } = setup({ preview: true });
  await userEvent.type(box, "**bold**");
  const toolbar = document.querySelector("[data-composer-toolbar]") as HTMLElement;
  const preview = screen.getByRole("button", { name: "Preview" });
  expect(toolbar.contains(preview)).toBe(true);
  expect(screen.getByRole("button", { name: "Write" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(preview);
  expect(preview).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector("[data-composer-frame] strong")).toHaveTextContent("bold");
  expect(screen.queryByRole("textbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Write" }));
  expect(screen.getByRole("textbox")).toHaveValue("**bold**");
});

let parentRenders = 0;
let bump: () => void = () => {};
const stableSubmit = async () => {};
/** Re-renders on `bump()`, passing the composer the same props each time. */
function Parent() {
  const [n, setN] = useState(0);
  bump = () => setN(n + 1);
  parentRenders++;
  return (
    <Composer
      draftKey="agent:dev"
      placeholder="Message Dev"
      label="Message to Dev"
      onSubmit={stableSubmit}
      hintMode="none"
    />
  );
}

test("memo: a parent render with the same props renders the composer 0 times; a keystroke renders only it", async () => {
  render(<Parent />);
  boxRenders.n = 0;
  parentRenders = 0;
  act(() => bump());
  expect(parentRenders).toBe(1);
  expect(boxRenders.n).toBe(0);
  parentRenders = 0;
  await userEvent.type(screen.getByRole("textbox"), "a");
  expect(parentRenders).toBe(0);
  expect(boxRenders.n).toBeGreaterThan(0);
});
