import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createUploadStore } from "@/features/session/uploads";
import { readDraft } from "@/lib/drafts";
import { FakeXhr, file, holdFrames, installFakeXhr, lastXhr } from "@/test/fake-xhr";
import { json, mockApi } from "@/test/mock-api";
import { NO_FOLDERS, TOO_MANY } from "./attachments";
import {
  type CompletionItem,
  type CompletionSource,
  Composer,
  type ComposerHandle,
  FILES_NOTE,
  SubmitError,
  type SubmitOptions,
} from "./composer";
import { acceptMention, mentionOpensAt } from "./mentions";

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

/** Renders of each chip's name (MiddleTruncate is the chip's name and nothing else in the composer). */
const nameRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("@/components/middle-truncate", async (orig) => {
  const m = await orig<typeof import("@/components/middle-truncate")>();
  return {
    ...m,
    MiddleTruncate: (p: Parameters<typeof m.MiddleTruncate>[0]) => {
      nameRenders.set(p.text, (nameRenders.get(p.text) ?? 0) + 1);
      return <m.MiddleTruncate {...p} />;
    },
  };
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  for (const x of FakeXhr.all) x.abort();
  FakeXhr.all = [];
  vi.unstubAllGlobals();
});

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
    // With caret menus the textarea is a combobox (U3 §13.4).
    box: screen.getByRole(props.completions ? "combobox" : "textbox", { name: "Message to Dev" }),
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
  expect(toolbar).toHaveClass("min-h-8"); // one 32px line, a second only when it must wrap
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
  // The hint is what shrinks; Stop and Send wrap only together, as one group whose width the
  // stand-in fixes, so a turn edge never changes whether they wrap.
  expect(slot?.closest("[data-composer-actions]")).not.toBeNull();
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

// ---- `@` completion (U3 §13.4) ----

const PEOPLE: CompletionItem[] = [
  { id: "dev", label: "Dev", detail: "@dev", group: "agents" },
  { id: "dana", label: "Dana", detail: "@dana", group: "humans" },
  { id: "humans", label: "Humans", detail: "@humans", group: "humans" },
];
const askedFor = vi.hoisted(() => ({ queries: [] as string[] }));
const AT: CompletionSource = {
  trigger: "@",
  label: "Insert an agent's handle",
  opensAt: mentionOpensAt,
  items(query) {
    askedFor.queries.push(query);
    return PEOPLE.filter((p) => p.id.startsWith(query));
  },
  accept: (item, text, from, caret) => acceptMention(text, item.id, from, caret),
};
const AT_ONLY = { at: AT };
const highlighted = () =>
  screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

test("`@` anywhere opens the menu; items are asked for only while it is open", async () => {
  askedFor.queries = [];
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "hello there");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(askedFor.queries).toEqual([]);
  await userEvent.type(box, " @d");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(box).toHaveAttribute("aria-expanded", "true");
  expect(box.getAttribute("aria-activedescendant")).toBe(highlighted()?.id);
  expect(document.activeElement).toBe(box);
});

test("↑/↓ move the highlight; Enter accepts with `@slug ` and sends nothing", async () => {
  const { box, onSubmit } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "ask @");
  expect(highlighted()).toHaveTextContent("Dev");
  await userEvent.keyboard("{ArrowDown}");
  expect(highlighted()).toHaveTextContent("Dana");
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  expect(highlighted()).toHaveTextContent("Humans");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(box).toHaveValue("ask @dev ");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box).toHaveAttribute("aria-expanded", "false");
  // The caret lands after the inserted handle, so typing carries on.
  await userEvent.type(box, "now");
  expect(box).toHaveValue("ask @dev now");
});

test("Tab accepts too", async () => {
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "@da");
  await userEvent.keyboard("{Tab}");
  expect(box).toHaveValue("@dana ");
  expect(document.activeElement).toBe(box);
});

test("Esc closes the menu and leaves the text; it doesn't stop the turn", async () => {
  const onStop = vi.fn(async () => {});
  const { box } = setup({ completions: AT_ONLY, turnOpen: true, stopEpoch: 1, onStop });
  await userEvent.type(box, "hi @d");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box).toHaveValue("hi @d");
  expect(onStop).not.toHaveBeenCalled();
  // Typing on in the same token doesn't bring it back; a new `@` does.
  await userEvent.type(box, "e");
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.type(box, " @");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  // With the menu closed, Esc goes on to stop the turn.
  await userEvent.keyboard("{Escape}{Escape}");
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("an IME composition never accepts", async () => {
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "@d");
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  fireEvent.keyDown(box, { key: "Tab", keyCode: 229 });
  expect(box).toHaveValue("@d");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
});

test("no match: no menu, and Enter sends", async () => {
  const { box, onSubmit } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "@zz");
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("@zz", expect.anything());
});

test("the toolbar's `@` button inserts `@` at the caret and opens the same menu", async () => {
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "ask");
  await userEvent.click(screen.getByRole("button", { name: "Insert an agent's handle" }));
  expect(box).toHaveValue("ask @");
  expect(document.activeElement).toBe(box);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(box).toHaveValue("ask @dev ");
});

test("a click on a row accepts it", async () => {
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "@");
  await userEvent.click(screen.getByRole("option", { name: /Humans/ }));
  expect(box).toHaveValue("@humans ");
  expect(document.activeElement).toBe(box);
});

test("in Preview the box isn't empty: prefillIfEmpty and putBackIfEmpty leave the typed text alone", async () => {
  const { ref } = setup({ preview: true, draftKey: "task:T-1" });
  await userEvent.type(screen.getByRole("textbox"), "my draft");
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  act(() => {
    expect(ref.current?.prefillIfEmpty("@dev ")).toBe(false);
    expect(ref.current?.putBackIfEmpty("cancelled")).toBe(false);
  });
  await userEvent.click(screen.getByRole("button", { name: "Write" }));
  expect(screen.getByRole("textbox")).toHaveValue("my draft");
});

test("sending from Preview returns to Write", async () => {
  setup({ preview: true });
  await userEvent.type(screen.getByRole("textbox"), "hello");
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Write" })).toHaveAttribute("aria-pressed", "true");
});

test("pendingLabel: a muted status line while a submit is pending; Send keeps its label", async () => {
  let done: () => void = () => {};
  const { box } = setup({
    pendingLabel: "Posting…",
    onSubmit: () =>
      new Promise<void>((res) => {
        done = res;
      }),
  });
  expect(screen.queryByText("Posting…")).toBeNull();
  await userEvent.type(box, "hi{Enter}");
  expect(screen.getByRole("status")).toHaveTextContent("Posting…");
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  await act(async () => done());
  expect(screen.queryByText("Posting…")).toBeNull();
});

test("without a pendingLabel nothing shows while a submit is pending", async () => {
  const { box } = setup({ onSubmit: () => new Promise<void>(() => {}) });
  await userEvent.type(box, "hi{Enter}");
  expect(screen.queryByRole("status")).toBeNull();
});

test("Stop's stand-in holds every label Stop can show, so the slot never grows within a turn", () => {
  setup({ onStop: async () => {}, stopEpoch: 1 });
  const standIn = document.querySelector("[data-stop-stand-in]") as HTMLElement;
  const labels = [...standIn.querySelectorAll("[data-stop-label]")].map((el) =>
    el.getAttribute("data-stop-label"),
  );
  expect(labels).toEqual(["Stop", "Stopping…", "Compacting…"]);
  // No text node: nothing for a text query to find twice.
  expect(standIn.textContent).toBe("");
});

test("with caret menus the textarea is a combobox whose popup state matches the menu", async () => {
  const { box } = setup({ completions: AT_ONLY });
  expect(box.tagName).toBe("TEXTAREA");
  expect(box).toHaveAttribute("aria-haspopup", "listbox");
  expect(box).toHaveAttribute("aria-autocomplete", "list");
  expect(box).toHaveAttribute("aria-expanded", "false");
  expect(box).not.toHaveAttribute("aria-controls");
  expect(box).not.toHaveAttribute("aria-activedescendant");
  await userEvent.type(box, "@");
  const list = screen.getByRole("listbox");
  expect(box).toHaveAttribute("aria-expanded", "true");
  expect(box).toHaveAttribute("aria-controls", list.id);
  expect(box.getAttribute("aria-activedescendant")).toBe(highlighted()?.id);
  await userEvent.keyboard("{Escape}");
  expect(box).toHaveAttribute("aria-expanded", "false");
  expect(box).not.toHaveAttribute("aria-controls");
  expect(box).not.toHaveAttribute("aria-activedescendant");
});

test("without caret menus it stays a plain textbox", () => {
  setup();
  expect(screen.getByRole("textbox", { name: "Message to Dev" })).not.toHaveAttribute(
    "aria-haspopup",
  );
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("⌥Enter and ⌘Enter with the menu open send the text as typed and close the menu", async () => {
  const { box, onSubmit } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "ping @d");
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  expect(onSubmit).toHaveBeenLastCalledWith("ping @d", expect.objectContaining({ urgent: true }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box).toHaveAttribute("aria-expanded", "false");
  await userEvent.type(box, "again @d");
  fireEvent.keyDown(box, { key: "Enter", metaKey: true });
  expect(onSubmit).toHaveBeenLastCalledWith("again @d", expect.objectContaining({ urgent: false }));
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a text change from outside the box (Reply) closes the menu", async () => {
  const { box, ref } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "@d");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  act(() => ref.current?.insertAtStart("@lead "));
  expect(box).toHaveValue("@lead @d");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a click outside closes the menu and leaves the text", async () => {
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "hi @d");
  await userEvent.click(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box).toHaveValue("hi @d");
});

test("the toolbar's `@` button with a menu open starts a new handle", async () => {
  const { box } = setup({ completions: AT_ONLY });
  await userEvent.type(box, "@d");
  await userEvent.click(screen.getByRole("button", { name: "Insert an agent's handle" }));
  expect(box).toHaveValue("@d @");
  expect(document.activeElement).toBe(box);
  expect(screen.getAllByRole("option")).toHaveLength(3);
  await userEvent.keyboard("{Enter}");
  expect(box).toHaveValue("@d @dev ");
});

test("data that arrives while the menu is open shows without a keystroke", async () => {
  let rows: CompletionItem[] = [PEOPLE[0] as CompletionItem];
  let notify = () => {};
  const unwatch = vi.fn();
  const watching: CompletionSource = {
    ...AT,
    items: (q) => rows.filter((p) => p.id.startsWith(q)),
    watch(onChange) {
      notify = onChange;
      return unwatch;
    },
  };
  const { box } = setup({ completions: { at: watching } });
  await userEvent.type(box, "@d");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  rows = PEOPLE;
  act(() => notify());
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await userEvent.keyboard("{Escape}");
  expect(unwatch).toHaveBeenCalledTimes(1);
});

// ---- `/` commands and command mode (U3 §13.3, Q36, Q43) ----

/** A `/` source over a fixed list: `exact` marks a name-prefix match (the only rows Enter takes). */
const COMMANDS: CompletionItem[] = [
  {
    id: "code-review",
    label: "/code-review",
    hint: "[target]",
    group: "Commands",
    kind: "command",
  },
  { id: "context", label: "/context", group: "Commands", kind: "command" },
  { id: "deploy", label: "/deploy", detail: "Ship the code", group: "Skills", kind: "command" },
];
const slashAsked = vi.hoisted(() => ({ queries: [] as string[] }));
const SLASH: CompletionSource = {
  trigger: "/",
  label: "Run a command",
  opensAt(text, caret) {
    const m = /^\/(?!\/)(\S*)$/.exec(text);
    return m && caret > 0 ? { query: m[1] ?? "", from: 0 } : undefined;
  },
  items(query) {
    slashAsked.queries.push(query);
    return COMMANDS.flatMap((c) =>
      c.id.startsWith(query)
        ? [{ ...c, exact: true }]
        : c.detail?.toLowerCase().includes(query)
          ? [c]
          : [],
    );
  },
  enterNeedsExact: true,
  accept: (item) => ({
    text: "",
    caret: 0,
    command: { name: item.id, placeholder: item.hint ?? "" },
  }),
  commandFor(text) {
    const m = /^\/(\S+) $/.exec(text);
    const c = m && COMMANDS.find((x) => x.id === m[1]);
    return c ? { name: c.id, placeholder: c.hint ?? "" } : undefined;
  },
  missNote: () => "Not a command for this agent; sends as text",
  textNote: (text) =>
    /^\/\/[^\s/]/.test(text)
      ? "Sends as text; the agent may still run a skill by that name"
      : undefined,
};
const SLASH_ONLY = { slash: SLASH };
type OnCommand = (name: string, args: string, o: { clientMessageId: string }) => Promise<void>;
function setupSlash(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onCommand = vi.fn<OnCommand>(async () => {});
  const r = setup({ completions: SLASH_ONLY, onCommand, ...over });
  return { ...r, onCommand };
}
const chip = () => document.querySelector("[data-command-chip]");

test("a typed `/` opens the menu; items are asked for only while it is open", async () => {
  slashAsked.queries = [];
  const { box } = setupSlash();
  await userEvent.type(box, "hi /c");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(slashAsked.queries).toEqual([]);
  await userEvent.clear(box);
  await userEvent.type(box, "/cod");
  // A name match, and a description match ("Ship the code").
  expect(screen.getAllByRole("option")).toHaveLength(2);
  // A space closes it.
  await userEvent.type(box, " ");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a paste never opens the menu", async () => {
  const { box } = setupSlash();
  box.focus();
  await userEvent.paste("/co");
  expect(box).toHaveValue("/co");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a pasted multi-line text starting with `/` and Enter sends unchanged", async () => {
  const { box, onSubmit, onCommand } = setupSlash();
  box.focus();
  await userEvent.paste("/context\nplease explain");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/context\nplease explain", expect.anything());
  expect(onCommand).not.toHaveBeenCalled();
});

test("Enter takes a name match into command mode, its hint as the placeholder; Enter then dispatches", async () => {
  const { box, onSubmit, onCommand } = setupSlash();
  await userEvent.type(box, "/code");
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(chip()).toHaveTextContent("Command");
  expect(chip()).toHaveTextContent("/code-review");
  expect(box).toHaveValue("");
  expect(box).toHaveAttribute("placeholder", "[target]");
  // Send works with no arguments too.
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  await userEvent.type(box, " src/ {Enter}");
  expect(onCommand).toHaveBeenCalledWith("code-review", "src/", expect.anything());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(chip()).toBeNull();
  expect(box).toHaveValue("");
});

test("Enter on a description-only match sends the text as typed", async () => {
  const { box, onSubmit, onCommand } = setupSlash();
  await userEvent.type(box, "/ship");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/ship", expect.anything());
  expect(onCommand).not.toHaveBeenCalled();
});

test("Tab completes a match into command mode", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "/con");
  await userEvent.keyboard("{Tab}");
  expect(chip()).toHaveTextContent("/context");
  expect(document.activeElement).toBe(box);
});

test("an exact name and a space enter command mode", async () => {
  const { box, onCommand } = setupSlash();
  await userEvent.type(box, "/context ");
  expect(chip()).toHaveTextContent("/context");
  expect(box).toHaveValue("");
  await userEvent.type(box, "{Enter}");
  expect(onCommand).toHaveBeenCalledWith("context", "", expect.anything());
});

test("⌥Enter acts as Enter in command mode", async () => {
  const { box, onSubmit, onCommand } = setupSlash();
  await userEvent.type(box, "/context ");
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  expect(onCommand).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});

test("a refused command shows its error inline, comes back in command mode, sends no text", async () => {
  const onCommand = vi.fn<OnCommand>(async () => {
    throw new SubmitError("/context isn't a command this agent can run.");
  });
  const { box, onSubmit } = setupSlash({ onCommand });
  await userEvent.type(box, "/context ");
  await userEvent.type(box, "now{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "/context isn't a command this agent can run.",
  );
  expect(chip()).toHaveTextContent("/context");
  expect(box).toHaveValue("now");
  expect(onSubmit).not.toHaveBeenCalled();
});

test("`/foo` that matches nothing says it sends as text, and Enter sends it", async () => {
  const { box, onSubmit } = setupSlash();
  await userEvent.type(box, "/foo");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByText("Not a command for this agent; sends as text")).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/foo", expect.anything());
});

test("`//x` says it sends as text", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "//deploy");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(
    screen.getByText("Sends as text; the agent may still run a skill by that name"),
  ).toBeInTheDocument();
});

test("an open menu with no rows shows its note (the empty state); Enter sends", async () => {
  const empty: CompletionSource = {
    ...SLASH,
    items: () => [],
    menuNote: () => "No commands loaded yet. They appear after the agent starts.",
  };
  const { box, onSubmit } = setupSlash({ completions: { slash: empty } });
  await userEvent.type(box, "/x");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(
    screen.getByText("No commands loaded yet. They appear after the agent starts."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Not a command for this agent; sends as text")).toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/x", expect.anything());
});

test("Esc order: the menu, then command mode, then stop", async () => {
  const onStop = vi.fn(async () => {});
  const { box } = setupSlash({ onStop, stopEpoch: 1, turnOpen: true });
  await userEvent.type(box, "/code");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box).toHaveValue("/code");
  await userEvent.clear(box);
  await userEvent.type(box, "/context ");
  await userEvent.type(box, "x");
  expect(chip()).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  // Leaving command mode keeps what was typed, as text.
  expect(chip()).toBeNull();
  expect(box).toHaveValue("/context x");
  expect(onStop).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("IME composition never dispatches, completes or leaves command mode", async () => {
  const { box, onCommand } = setupSlash();
  await userEvent.type(box, "/context ");
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  fireEvent.keyDown(box, { key: "Escape", keyCode: 229 });
  expect(onCommand).not.toHaveBeenCalled();
  expect(chip()).not.toBeNull();
});

test("Backspace in an empty command mode puts the name back as text", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "/context ");
  await userEvent.keyboard("{Backspace}");
  expect(chip()).toBeNull();
  expect(box).toHaveValue("/context");
});

test("the toolbar's `/` button starts a command in an empty box", async () => {
  const { box } = setupSlash();
  await userEvent.click(screen.getByRole("button", { name: "Run a command" }));
  expect(box).toHaveValue("/");
  expect(document.activeElement).toBe(box);
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

// U3 §13.5: files in the session composer.
function setupFiles(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  installFakeXhr();
  const frames = holdFrames();
  const store = createUploadStore("dev");
  const r = setup({ attachments: store, ...over });
  const frame = r.box.closest("[data-composer-frame]") as HTMLElement;
  return { ...r, store, frames, frame };
}
const pasteFiles = (box: HTMLElement, files: File[], text = "") =>
  fireEvent.paste(box, {
    clipboardData: {
      files,
      getData: (t: string) => (t === "text/plain" ? text : ""),
      types: text ? ["text/plain", "Files"] : ["Files"],
    },
  });
const chips = () => [...document.querySelectorAll<HTMLElement>("[data-upload-chip]")];
const ok = (id: string, name: string) => ({ uploadId: id, kind: "text", bytes: 5, name });

test("a paste with text inserts the text and ignores its image items", () => {
  const { box, store } = setupFiles();
  const pasted = pasteFiles(box, [file("cells.png", 10, "image/png")], "A1\tB1");
  expect(pasted).toBe(true); // the browser inserts the text
  expect(store.keys()).toEqual([]);
  expect(chips()).toHaveLength(0);
});

test("a files-only paste attaches them as chips, max 12rem wide", () => {
  const { box } = setupFiles();
  expect(pasteFiles(box, [file("notes.txt")])).toBe(false);
  expect(chips()).toHaveLength(1);
  expect(chips()[0]).toHaveClass("max-w-[12rem]");
  expect(chips()[0]).toHaveTextContent("notes.txt");
  expect(lastXhr().url).toBe("/api/agents/dev/uploads");
});

test("a file name is text: markup and bidi overrides are never interpreted", () => {
  const { box } = setupFiles();
  pasteFiles(box, [file("<img src=x onerror=alert(1)>\u202Egnp.txt")]);
  expect(document.querySelector("[data-upload-chip] img")).toBeNull();
  expect(chips()[0]).toHaveTextContent("<img src=x onerror=alert(1)>gnp.txt");
});

test("chips take at most two rows, then +N files expands them in place", async () => {
  // Four chips a row: rows start at 0, 40, 80.
  const spy = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute("data-upload-chip")) return 0;
    return Math.floor([...(this.parentElement?.children ?? [])].indexOf(this) / 4) * 40;
  });
  const { box } = setupFiles();
  pasteFiles(
    box,
    Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`)),
  );
  const more = await screen.findByRole("button", { name: "+2 files" });
  expect(chips().filter((c) => c.hasAttribute("inert"))).toHaveLength(2);
  await userEvent.click(more);
  expect(screen.queryByRole("button", { name: /^\+\d+ files?$/ })).toBeNull();
  expect(chips().filter((c) => c.hasAttribute("inert"))).toHaveLength(0);
  spy.mockRestore();
});

test("past 10 files the rest are left out with a note; a folder is refused with a note", () => {
  const { box, frame } = setupFiles();
  pasteFiles(
    box,
    Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`)),
  );
  expect(chips()).toHaveLength(10);
  expect(screen.getByText(TOO_MANY)).toBeInTheDocument();
  const folder = file("photos", 0, "");
  fireEvent.drop(frame, {
    dataTransfer: {
      files: [folder],
      items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
      types: ["Files"],
    },
  });
  expect(screen.getByText(NO_FOLDERS)).toBeInTheDocument();
});

test("an image's thumbnail is a 64px bitmap on a canvas, never a full-size <img>", async () => {
  const bitmap = { width: 128, height: 80, close: vi.fn() };
  const createImageBitmap = vi.fn(async () => bitmap);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as never);
  const { box, store } = setupFiles();
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  const img = file("shot.png", 20, "image/png");
  pasteFiles(box, [img]);
  expect(createImageBitmap).toHaveBeenCalledWith(img, { resizeWidth: 64 });
  await vi.waitFor(() => expect(document.querySelector("canvas[data-thumb]")).not.toBeNull());
  // Fixed at 64px wide, whatever size the bitmap came back.
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 64, 40);
  expect(document.querySelector("[data-composer-frame] img")).toBeNull();
  expect(store.keys()).toHaveLength(1);
});

test("an upload shows a determinate 2px bar and a tabular percentage, without transition", () => {
  const { box, frames } = setupFiles();
  pasteFiles(box, [file("a.txt")]);
  act(() => {
    lastXhr().progress(40, 100);
    frames.flush();
  });
  const bar = screen.getByRole("progressbar", { name: "Uploading a.txt" });
  expect(bar).toHaveAttribute("aria-valuenow", "40");
  expect(bar).toHaveClass("h-0.5", "transition-none");
  expect(bar.style.transform).toBe("scaleX(0.4)");
  expect(screen.getByText("40%")).toHaveClass("tabular-nums");
  expect(screen.getByRole("button", { name: "Cancel a.txt" })).toBeInTheDocument();
});

test("a progress tick renders only its own chip, once per frame; not the composer", () => {
  const { box, frames } = setupFiles();
  pasteFiles(box, [file("a.txt"), file("b.txt")]);
  const [xa] = FakeXhr.all as [FakeXhr];
  const a0 = nameRenders.get("a.txt") ?? 0;
  const b0 = nameRenders.get("b.txt") ?? 0;
  const box0 = boxRenders.n;
  act(() => {
    xa.progress(10, 100);
    xa.progress(30, 100);
    xa.progress(50, 100);
    frames.flush();
  });
  expect(nameRenders.get("a.txt")).toBe(a0 + 1);
  expect(nameRenders.get("b.txt")).toBe(b0);
  expect(boxRenders.n).toBe(box0);
});

test("a refused file shows its reason with Remove only; a failure a retry can fix offers Retry", async () => {
  const { box } = setupFiles();
  pasteFiles(box, [file("p.heic", 10, "image/heic"), file("a.txt")]);
  const [heic, txt] = FakeXhr.all as [FakeXhr, FakeXhr];
  act(() => {
    heic.respond(415, {
      error: { code: "unsupported_type", message: "HEIC isn't supported; export as JPEG" },
    });
    txt.respond(503, { error: { message: "The server is busy." } });
  });
  expect(chips()[0]).toHaveTextContent("HEIC isn't supported; export as JPEG");
  expect(screen.queryByRole("button", { name: "Retry p.heic" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry a.txt" }));
  expect(FakeXhr.all).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "Remove p.heic" }));
  expect(chips()).toHaveLength(1);
});

test("a non-JSON 413 says the proxy refused it", () => {
  const { box } = setupFiles();
  pasteFiles(box, [file("big.txt")]);
  act(() => lastXhr().respond(413, "<html>413 Request Entity Too Large</html>"));
  expect(chips()[0]).toHaveTextContent(
    "The server refused a file this large (check the proxy's upload limit).",
  );
});

test("Send holds for uploads, then for a failed file: focusable, its reason a visible line", async () => {
  const { box, onSubmit } = setupFiles();
  await userEvent.type(box, "see these");
  pasteFiles(box, [file("a.txt"), file("b.txt")]);
  const send = screen.getByRole("button", { name: "Send" });
  const reason = () => document.querySelector("[data-send-reason]");
  expect(send).toBeEnabled(); // focusable, so the reason is reachable
  expect(send).toHaveAttribute("aria-disabled", "true");
  expect(send).toHaveAccessibleDescription("Waiting for 2 uploads");
  expect(reason()).toHaveTextContent("Waiting for 2 uploads");
  fireEvent.keyDown(box, { key: "Enter" });
  await userEvent.click(send);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(box).toHaveValue("see these");
  act(() => (FakeXhr.all[0] as FakeXhr).respond(201, ok("u1", "a.txt")));
  expect(send).toHaveAccessibleDescription("Waiting for 1 upload");
  act(() => (FakeXhr.all[1] as FakeXhr).fail());
  expect(send).toHaveAttribute("aria-disabled", "true");
  expect(reason()).toHaveTextContent("Remove or retry the failed file");
  await userEvent.click(screen.getByRole("button", { name: "Remove b.txt" }));
  expect(send).not.toHaveAttribute("aria-disabled");
  expect(reason()).toBeNull();
});

test("files with an empty box: Send says to add a message", async () => {
  const { box, onSubmit } = setupFiles();
  pasteFiles(box, [file("a.txt")]);
  act(() => lastXhr().respond(201, ok("u1", "a.txt")));
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toHaveAttribute("aria-disabled", "true");
  expect(document.querySelector("[data-send-reason]")).toHaveTextContent(
    "Add a message to send the files",
  );
  await userEvent.click(send);
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.type(box, "x");
  expect(send).not.toHaveAttribute("aria-disabled");
});

test("validate hears how many files go with the text", async () => {
  const validate = vi.fn<(t: string, files: number) => string | undefined>(() => undefined);
  const { box } = setupFiles({ validate });
  pasteFiles(box, [file("a.txt")]);
  act(() => lastXhr().respond(201, ok("u1", "a.txt")));
  await userEvent.type(box, "hi{Enter}");
  expect(validate).toHaveBeenCalledWith("hi", 1);
});

test("after a send empties the chips, the next batch starts collapsed", async () => {
  const spy = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute("data-upload-chip")) return 0;
    return Math.floor([...(this.parentElement?.children ?? [])].indexOf(this) / 4) * 40;
  });
  const { box } = setupFiles();
  const ten = () => Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`));
  pasteFiles(box, ten());
  await userEvent.click(await screen.findByRole("button", { name: "+2 files" }));
  act(() => {
    for (const [i, x] of FakeXhr.all.entries()) x.respond(201, ok(`u${i}`, `f${i}.txt`));
  });
  await userEvent.type(box, "go{Enter}");
  expect(chips()).toHaveLength(0);
  pasteFiles(box, ten());
  expect(await screen.findByRole("button", { name: "+2 files" })).toBeInTheDocument();
  spy.mockRestore();
});

test("moving between the frame's children keeps the drop edge; leaving the frame drops it", () => {
  const { frame, box } = setupFiles();
  const dt = { files: [file("a.txt")], types: ["Files"] };
  fireEvent.dragEnter(frame, { dataTransfer: dt });
  fireEvent.dragEnter(box, { dataTransfer: dt }); // into a child: Safari's relatedTarget is null
  fireEvent.dragLeave(frame, { dataTransfer: dt, relatedTarget: null });
  expect(frame.querySelector("[data-drop-edge]")).not.toBeNull();
  fireEvent.dragLeave(box, { dataTransfer: dt, relatedTarget: null });
  expect(frame.querySelector("[data-drop-edge]")).toBeNull();
});

test("Send carries the finished uploads; a failed send puts the chips back", async () => {
  let fail: (e: unknown) => void = () => {};
  const onSubmit = vi.fn(
    (_t: string, _o: SubmitOptions) =>
      new Promise<void>((_, rej) => {
        fail = rej;
      }),
  );
  const { box } = setupFiles({ onSubmit });
  pasteFiles(box, [file("a.txt")]);
  act(() => lastXhr().respond(201, ok("u1", "a.txt")));
  await userEvent.type(box, "here{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("here", expect.objectContaining({ attachments: ["u1"] }));
  expect(chips()).toHaveLength(0);
  await act(async () => fail(new SubmitError("Boom")));
  expect(chips()).toHaveLength(1);
  expect(box).toHaveValue("here");
});

test("removing a finished chip deletes the upload on the server", async () => {
  const api = mockApi({ "DELETE /api/agents/dev/uploads/u1": () => json({}, 204) });
  const { box } = setupFiles();
  pasteFiles(box, [file("a.txt")]);
  act(() => lastXhr().respond(201, ok("u1", "a.txt")));
  await userEvent.click(screen.getByRole("button", { name: "Remove a.txt" }));
  await vi.waitFor(() =>
    expect(api.calls).toContainEqual(
      expect.objectContaining({ method: "DELETE", url: "/api/agents/dev/uploads/u1" }),
    ),
  );
});

test("leaving keeps the uploads: a remounted composer shows them again", () => {
  installFakeXhr();
  holdFrames();
  const store = createUploadStore("dev");
  const props = {
    draftKey: "agent:dev",
    placeholder: "p",
    label: "Message to Dev",
    onSubmit: noSubmit,
  };
  const first = render(<Composer {...props} attachments={store} />);
  pasteFiles(screen.getByRole("textbox"), [file("a.txt")]);
  first.unmount();
  expect(lastXhr().aborted).toBe(false);
  render(<Composer {...props} attachments={store} />);
  expect(chips()).toHaveLength(1);
});

test("a file dragged over the frame edges it in ink with no animation; dropping attaches it", () => {
  const { frame } = setupFiles();
  const f = file("a.txt");
  const dt = {
    files: [f],
    items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) }],
    types: ["Files"],
  };
  expect(fireEvent.dragOver(frame, { dataTransfer: dt })).toBe(false);
  const edge = frame.querySelector("[data-drop-edge]");
  expect(edge).not.toBeNull();
  expect(edge).toHaveClass("border-foreground");
  expect(edge?.className).not.toMatch(/transition|animate/);
  expect(fireEvent.drop(frame, { dataTransfer: dt })).toBe(false);
  expect(frame.querySelector("[data-drop-edge]")).toBeNull();
  expect(chips()).toHaveLength(1);
});

test("the attach button picks files", async () => {
  setupFiles();
  const input = document.querySelector<HTMLInputElement>("input[type=file]") as HTMLInputElement;
  expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
  await userEvent.upload(input, [file("a.txt"), file("b.txt")]);
  expect(chips()).toHaveLength(2);
});

test("↑ in an empty box recalls your last message's text; not once the box has text", async () => {
  const recall = vi.fn(() => "see this");
  const { box } = setupFiles({ recall });
  fireEvent.keyDown(box, { key: "ArrowUp", isComposing: true });
  expect(recall).not.toHaveBeenCalled();
  await userEvent.click(box);
  await userEvent.keyboard("{ArrowUp}");
  expect(box).toHaveValue("see this");
  await userEvent.keyboard("{ArrowUp}");
  expect(recall).toHaveBeenCalledTimes(1);
});

// ---- Task 56 fix round 1 ----

test("command mode is perceivable: the box is described by the chip, and the change is announced", async () => {
  const { box } = setupSlash();
  const live = screen.getAllByText((_, el) => el?.getAttribute("aria-live") === "polite");
  expect(live.length).toBeGreaterThan(0);
  await userEvent.type(box, "/context ");
  const c = chip() as HTMLElement;
  expect(c.id).not.toBe("");
  expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(c.id);
  const announce = screen.getByText("Command mode: /context. Esc to leave.");
  expect(announce).toHaveAttribute("aria-live", "polite");
  await userEvent.keyboard("{Escape}");
  expect(announce).toHaveTextContent("");
  expect(box.getAttribute("aria-describedby") ?? "").not.toContain(c.id);
});

test("command mode is stored in the draft as `/name args`", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "/code-review ");
  await userEvent.type(box, "src/");
  box.blur();
  expect(readDraft("agent:dev")).toBe("/code-review src/");
});

test("a stored `/name args` draft comes back in command mode when the name is known; else plain text", () => {
  localStorage.setItem(
    "of-draft:v1:agent:dev",
    JSON.stringify({ text: "/code-review src/", at: Date.now() }),
  );
  const { box } = setupSlash();
  expect(chip()).toHaveTextContent("/code-review");
  expect(box).toHaveValue("src/");
  cleanup();
  localStorage.setItem(
    "of-draft:v1:agent:dev",
    JSON.stringify({ text: "/nope src/", at: Date.now() }),
  );
  const again = setupSlash();
  expect(chip()).toBeNull();
  expect(again.box).toHaveValue("/nope src/");
});

test("a refused command after the box was used goes after the new text, never lost", async () => {
  let fail: (e: unknown) => void = () => {};
  const onCommand = vi.fn<OnCommand>(
    () =>
      new Promise<void>((_, rej) => {
        fail = rej;
      }),
  );
  const { box } = setupSlash({ onCommand });
  await userEvent.type(box, "/context ");
  await userEvent.type(box, "now{Enter}");
  await userEvent.type(box, "hello");
  await act(async () => fail(new SubmitError("Refused.")));
  expect(box).toHaveValue("hello\n/context now");
  expect(chip()).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Refused.");
});

test("an Esc a peek already took closes only the peek: command mode stays", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "/context ");
  const ev = createEvent.keyDown(box, { key: "Escape", cancelable: true });
  ev.preventDefault();
  fireEvent(box, ev);
  expect(chip()).not.toBeNull();
});

test("the slash note's live region is there before the note", async () => {
  const { box } = setupSlash();
  const region = document.querySelector("[data-slash-note]") as HTMLElement;
  expect(region).toHaveAttribute("aria-live", "polite");
  expect(region).toHaveTextContent("");
  await userEvent.type(box, "/foo");
  expect(region).toHaveTextContent("Not a command for this agent; sends as text");
});

test("the `/` button is disabled while the box has text", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "hi");
  expect(screen.getByRole("button", { name: "Run a command" })).toBeDisabled();
});

test("⌥Enter with the `/` menu open sends the text as typed", async () => {
  const { box, onSubmit, onCommand } = setupSlash();
  await userEvent.type(box, "/code");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  expect(onSubmit).toHaveBeenCalledWith("/code", expect.objectContaining({ urgent: true }));
  expect(onCommand).not.toHaveBeenCalled();
});

test("a row with a heading starts a labelled group in the menu", async () => {
  const items: CompletionItem[] = [
    { id: "a", label: "/a", group: "Skills", kind: "command", heading: "Skills", exact: true },
    { id: "b", label: "/b", group: "Skills", kind: "command", exact: true },
    { id: "c", label: "/c", group: "Commands", kind: "command", heading: "Commands", exact: true },
  ];
  const slash: CompletionSource = {
    trigger: "/",
    opensAt: (t, c) =>
      /^\/\S*$/.test(t.slice(0, c)) ? { query: t.slice(1, c), from: 0 } : undefined,
    items: () => items,
    accept: () => ({ text: "", caret: 0 }),
  };
  const { box } = setup({ completions: { slash } });
  await userEvent.type(box, "/");
  const groups = screen.getAllByRole("group");
  expect(groups.map((g) => within(g).getAllByRole("option").length)).toEqual([2, 1]);
  expect(screen.getByText("Skills")).toBeInTheDocument();
  expect(screen.getByText("Commands")).toBeInTheDocument();
});

test("chips that wrap after their names lay out still collapse to two rows (each chip is observed)", async () => {
  const observers: { cb: ResizeObserverCallback; els: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      els: Element[] = [];
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb, els: this.els });
      }
      observe(el: Element) {
        this.els.push(el);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  let wrapped = false; // first layout: one row; after the names widen: one chip a row
  const spy = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute("data-upload-chip") || !wrapped) return 0;
    return [...(this.parentElement?.children ?? [])].indexOf(this) * 42;
  });
  const { box } = setupFiles();
  pasteFiles(box, [file("a.txt"), file("b.txt"), file("p.heic", 10, "image/heic")]);
  expect(screen.queryByRole("button", { name: "+1 file" })).toBeNull();
  const lis = chips();
  expect(observers.some((o) => lis.every((li) => o.els.includes(li)))).toBe(true);
  wrapped = true;
  act(() => {
    for (const o of observers) o.cb([], {} as ResizeObserver);
  });
  expect(screen.getByRole("button", { name: "+1 file" })).toBeInTheDocument();
  expect(chips()[2]).toHaveAttribute("inert");
  expect(chips()[2]).toHaveAttribute("aria-hidden", "true");
  spy.mockRestore();
});

test("a failed chip's reason takes up to two lines instead of being cut to a few words", () => {
  const { box } = setupFiles();
  pasteFiles(box, [file("p.heic", 10, "image/heic")]);
  act(() => lastXhr().respond(415, { error: { message: "HEIC isn't supported; export as JPEG" } }));
  const reason = chips()[0]?.querySelector("[data-upload-error]");
  expect(reason).toHaveTextContent("HEIC isn't supported; export as JPEG");
  expect(reason).toHaveClass("line-clamp-2");
  expect(reason).not.toHaveClass("truncate");
});

test("after a reload the stored command comes back once the commands list arrives, if the box is untouched", () => {
  localStorage.setItem(
    "of-draft:v1:agent:dev",
    JSON.stringify({ text: "/code-review src/", at: Date.now() }),
  );
  // The list isn't loaded at mount: nothing is known until `watch` says it changed.
  let loaded = false;
  let changed: () => void = () => {};
  const late: CompletionSource = {
    ...SLASH,
    commandFor: (t) => (loaded ? SLASH.commandFor?.(t) : undefined),
    watch(onChange) {
      changed = onChange;
      return () => {};
    },
  };
  const { box } = setupSlash({ completions: { slash: late } });
  expect(chip()).toBeNull();
  expect(box).toHaveValue("/code-review src/");
  loaded = true;
  act(() => changed());
  expect(chip()).toHaveTextContent("/code-review");
  expect(box).toHaveValue("src/");
});

test("a stored command typed over before the list arrives stays text", async () => {
  localStorage.setItem(
    "of-draft:v1:agent:dev",
    JSON.stringify({ text: "/code-review src/", at: Date.now() }),
  );
  let loaded = false;
  let changed: () => void = () => {};
  const late: CompletionSource = {
    ...SLASH,
    commandFor: (t) => (loaded ? SLASH.commandFor?.(t) : undefined),
    watch(onChange) {
      changed = onChange;
      return () => {};
    },
  };
  const { box } = setupSlash({ completions: { slash: late } });
  await userEvent.type(box, "x");
  loaded = true;
  act(() => changed());
  expect(chip()).toBeNull();
  expect(box).toHaveValue("/code-review src/x");
});

test("Esc out of command mode puts the name back without reopening the menu", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "/context ");
  expect(chip()).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(box).toHaveValue("/context");
  fireEvent.select(box); // the caret placed after the name
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.type(box, "x"); // typing brings menus back as usual
  expect(box).toHaveValue("/contextx");
});
