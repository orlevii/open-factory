import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createUploadStore } from "@/features/session/uploads";
import { readDraft, writeDraft } from "@/lib/drafts";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { FakeXhr, file, holdFrames, installFakeXhr, lastXhr } from "@/test/fake-xhr";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
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
  expect(toolbar?.contains(screen.getByRole("button", { name: "Send" }))).toBe(true);
});

test("Send is labelled Send, disabled-shaped while empty, primary at once when there is text", async () => {
  const { box } = setup();
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toBeDisabled();
  await userEvent.type(box, "x");
  expect(send).toBeEnabled();
  await userEvent.clear(box);
  await userEvent.type(box, "   ");
  expect(send).toBeDisabled();
  expect(screen.queryByRole("checkbox", { name: "Urgent" })).toBeNull();
});

test("Stop's slot keeps its width with no turn open (an invisible stand-in), so a turn edge never re-wraps", () => {
  const onStop = vi.fn(async () => {});
  const { rerender } = setup({ onStop, stopEpoch: 1, turnOpen: false, stopVisible: false });
  const slot = document.querySelector("[data-stop-slot]");
  expect(slot).not.toBeNull();
  const standIn = slot?.querySelector("[data-stop-stand-in]");
  expect(standIn).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  rerender({ onStop, stopEpoch: 2, turnOpen: true, stopVisible: true });
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

test("↑/↓ move the highlight; Enter accepts with `@handle ` and sends nothing", async () => {
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
  const { box } = setup({
    completions: AT_ONLY,
    turnOpen: true,
    stopVisible: true,
    stopEpoch: 1,
    onStop,
  });
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

// ---- the `/` menu: autocomplete only (I1 §5.4) ----

/** A `/` source over a fixed list. `enterSends` marks a name typed in full. */
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
const CLEAR: CompletionItem = {
  id: "clear",
  label: "/clear",
  group: "Commands",
  kind: "command",
  detail: "/clear isn't available: each agent keeps one session.",
  disabled: "/clear isn't available: each agent keeps one session.",
  enterSends: true,
};
const slashAsked = vi.hoisted(() => ({ queries: [] as string[] }));
const SLASH: CompletionSource = {
  trigger: "/",
  label: "Run a command",
  opensAt(text, caret) {
    const m = /^\/(\S*)$/.exec(text);
    return m && caret > 0 ? { query: m[1] ?? "", from: 0 } : undefined;
  },
  items(query) {
    slashAsked.queries.push(query);
    return [
      ...(query === "clear" ? [CLEAR] : []),
      ...COMMANDS.flatMap((c) =>
        c.id === query
          ? [{ ...c, enterSends: true }]
          : c.id.startsWith(query)
            ? [c]
            : c.detail?.toLowerCase().includes(query)
              ? [{ ...c, enterSends: true }]
              : [],
      ),
    ];
  },
  accept: (item, text, from, caret) => ({
    text: `${text.slice(0, from)}/${item.id} ${text.slice(caret)}`,
    caret: from + item.id.length + 2,
  }),
  textNote(text, sending) {
    const m = /^\s*\/clear(\s|$)/.exec(text);
    return m && (m[1] !== "" || sending)
      ? { kind: "refusal", text: "/clear isn't available: each agent keeps one session." }
      : undefined;
  },
};
const SLASH_ONLY = { slash: SLASH };
function setupSlash(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  return setup({ completions: SLASH_ONLY, ...over });
}

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
  const { box, onSubmit } = setupSlash();
  box.focus();
  await userEvent.paste("/context\nplease explain");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/context\nplease explain", expect.anything());
});

test("Enter on a partial name inserts `/name ` and keeps the box; Tab does the same", async () => {
  const { box, onSubmit } = setupSlash();
  await userEvent.type(box, "/code");
  await userEvent.keyboard("{Enter}");
  expect(box).toHaveValue("/code-review ");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.clear(box);
  await userEvent.type(box, "/con");
  await userEvent.keyboard("{Tab}");
  expect(box).toHaveValue("/context ");
  expect(document.activeElement).toBe(box);
});

test("Enter on a name typed in full sends it as typed", async () => {
  const { box, onSubmit } = setupSlash();
  await userEvent.type(box, "/context");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/context", expect.anything());
});

test("a denied row is disabled with its reason and never accepted", async () => {
  const { box, onSubmit } = setupSlash();
  await userEvent.type(box, "/clear");
  const row = screen.getByRole("option", { name: /clear/ });
  expect(row).toHaveAttribute("aria-disabled", "true");
  expect(row).toHaveTextContent("/clear isn't available: each agent keeps one session.");
  fireEvent.keyDown(box, { key: "Tab" });
  expect(box).toHaveValue("/clear");
  // Enter sends as typed: the composer refuses it, it never reaches onSubmit.
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(slot()).toHaveTextContent("/clear isn't available: each agent keeps one session.");
});

test("a denied first token takes the slot once it is complete and holds Send", async () => {
  const { box, onSubmit } = setupSlash();
  const send = screen.getByRole("button", { name: "Send" });
  await userEvent.type(box, "/clear");
  expect(slot()).not.toHaveTextContent("isn't available"); // still typing the token
  await userEvent.type(box, " ");
  expect(slot()).toHaveTextContent("/clear isn't available: each agent keeps one session.");
  expect(send).toHaveAttribute("aria-disabled", "true");
  expect(send).toHaveAccessibleDescription("/clear isn't available: each agent keeps one session.");
  fireEvent.keyDown(box, { key: "Enter" });
  await userEvent.click(send);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(box).toHaveValue("/clear ");
  await userEvent.type(box, "{Backspace}{Backspace}");
  expect(slot()).toBeEmptyDOMElement();
  expect(send).not.toHaveAttribute("aria-disabled");
});

test("Esc closes the menu first and leaves the text", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "/co");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(box).toHaveValue("/co");
});

test("Enter on a description-only match sends the text as typed", async () => {
  const { box, onSubmit } = setupSlash();
  await userEvent.type(box, "/ship");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/ship", expect.anything());
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
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("/x", expect.anything());
});

test("the toolbar's `/` button opens the menu in an empty box", async () => {
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
  const store = createUploadStore(refFor("dev"));
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
  expect(chips()[0]).toHaveTextContent("notes.txt");
  expect(lastXhr().url).toBe(`/api/agents/${refFor("dev")}/uploads`);
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
  expect(bar.style.transform).toBe("scaleX(0.4)");
  expect(screen.getByText("40%")).toBeInTheDocument();
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
  const api = mockApi({ [`DELETE /api/agents/${refFor("dev")}/uploads/u1`]: () => json({}, 204) });
  const { box } = setupFiles();
  pasteFiles(box, [file("a.txt")]);
  act(() => lastXhr().respond(201, ok("u1", "a.txt")));
  await userEvent.click(screen.getByRole("button", { name: "Remove a.txt" }));
  await vi.waitFor(() =>
    expect(api.calls).toContainEqual(
      expect.objectContaining({ method: "DELETE", url: `/api/agents/${refFor("dev")}/uploads/u1` }),
    ),
  );
});

test("leaving keeps the uploads: a remounted composer shows them again", () => {
  installFakeXhr();
  holdFrames();
  const store = createUploadStore(refFor("dev"));
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

test("the note slot's live region is there before the note", async () => {
  const { box } = setupSlash();
  const region = document.querySelector("[data-composer-hint]") as HTMLElement;
  expect(region).toHaveAttribute("aria-live", "polite");
  expect(region).toHaveTextContent("");
  await userEvent.type(box, "/clear ");
  expect(region).toHaveTextContent("/clear isn't available");
});

test("the `/` button is disabled while the box has text", async () => {
  const { box } = setupSlash();
  await userEvent.type(box, "hi");
  expect(screen.getByRole("button", { name: "Run a command" })).toBeDisabled();
});

test("⌥Enter with the `/` menu open sends the text as typed", async () => {
  const { box, onSubmit } = setupSlash();
  await userEvent.type(box, "/code");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  expect(onSubmit).toHaveBeenCalledWith("/code", expect.objectContaining({ urgent: true }));
});

test("a row with a heading starts a labelled group in the menu", async () => {
  const items: CompletionItem[] = [
    { id: "a", label: "/a", group: "Skills", kind: "command", heading: "Skills" },
    { id: "b", label: "/b", group: "Skills", kind: "command" },
    { id: "c", label: "/c", group: "Commands", kind: "command", heading: "Commands" },
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
});

test("the `/` menu renders every row its source gives (the list scrolls); `@` keeps its 8", async () => {
  const many: CompletionItem[] = Array.from({ length: 13 }, (_, i) => ({
    id: `c${i}`,
    label: `/c${i}`,
    group: i < 8 ? "Skills" : "Commands",
    kind: "command",
  }));
  const slash: CompletionSource = {
    ...SLASH,
    items: () => many,
    allRows: true,
  };
  const { box } = setupSlash({ completions: { slash } });
  await userEvent.type(box, "/");
  expect(screen.getAllByRole("option")).toHaveLength(13);
});

// The phone composer (U4 §11.4, #107): below 48rem the toolbar is icons only, Stop and Send at its end.
function onPhone(): () => void {
  const real = window.matchMedia;
  fakeMatchMedia.install(true);
  return () => {
    window.matchMedia = real;
  };
}

test("on a phone Send is a 40px primary icon button named Send", async () => {
  const restore = onPhone();
  try {
    const { box } = setup();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toHaveTextContent(/^$/); // the arrow only, the name from aria-label
    expect(send.querySelector("svg")).not.toBeNull();
    expect(send).toBeDisabled();
    await userEvent.type(box, "x");
    expect(send).toBeEnabled();
  } finally {
    restore();
  }
});

test("on a phone attach, / and @ are 40px ghost icons and there is no Write/Preview or visible hint", () => {
  const restore = onPhone();
  try {
    setup({
      preview: true,
      attachments: createUploadStore(refFor("dev")),
      completions: { slash: SLASH, at: AT },
      hintMode: "coarse",
      turnOpen: true,
    });
    for (const name of ["Attach files", "Run a command", "Insert an agent's handle"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Write" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  } finally {
    restore();
  }
});

test("on a phone the hint stays the box's description while it isn't shown", () => {
  const restore = onPhone();
  try {
    const { box } = setup({ hintMode: "coarse", turnOpen: true });
    expect(box).toHaveAccessibleDescription(
      "Arrives at the agent's next step. Stop first to interrupt.",
    );
  } finally {
    restore();
  }
});

test("on a phone Stop is a 40px outline icon left of Send, in a slot kept with no turn open", () => {
  const restore = onPhone();
  try {
    const onStop = vi.fn(async () => {});
    const { rerender } = setup({ onStop, stopEpoch: 1, turnOpen: false, stopVisible: false });
    const toolbar = document.querySelector("[data-composer-toolbar]") as HTMLElement;
    const slot = document.querySelector("[data-stop-slot]") as HTMLElement;
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();

    rerender({ onStop, stopEpoch: 2, turnOpen: true, stopVisible: true });
    const stop = screen.getByRole("button", { name: "Stop" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(stop).toHaveTextContent(/^$/);
    expect(slot.contains(stop)).toBe(true);
    expect(stop.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing remounts on the turn edge: the same toolbar and slot.
    expect(document.querySelector("[data-composer-toolbar]")).toBe(toolbar);
    expect(document.querySelector("[data-stop-slot]")).toBe(slot);
  } finally {
    restore();
  }
});

test("on a phone a pending Stop is named Stopping… and says so in a status", async () => {
  const restore = onPhone();
  try {
    let resolve: () => void = () => {};
    const onStop = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    setup({ onStop, stopEpoch: 1, turnOpen: true, stopVisible: true });
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    const stop = screen.getByRole("button", { name: "Stopping…" });
    expect(stop).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Stopping…");
    resolve();
  } finally {
    restore();
  }
});

test("on a phone the placeholder carries the queued hint while a turn is open", () => {
  const restore = onPhone();
  try {
    const busy = "Sends after @dev's current step";
    const { box, rerender } = setup({ turnPlaceholder: busy, turnOpen: false });
    expect(box).toHaveAttribute("placeholder", "Message Dev");
    rerender({ turnPlaceholder: busy, turnOpen: true });
    expect(box).toHaveAttribute("placeholder", busy);
  } finally {
    restore();
  }
});

test("from 48rem the placeholder, Send and Stop keep U3's layout", () => {
  const { box } = setup({
    turnPlaceholder: "Sends after @dev's current step",
    turnOpen: true,
    stopVisible: true,
    stopEpoch: 1,
    onStop: async () => {},
  });
  expect(box).toHaveAttribute("placeholder", "Message Dev");
  expect(screen.getByRole("button", { name: "Send" })).toHaveTextContent("Send");
  expect(screen.getByRole("button", { name: "Stop" })).toHaveTextContent("Stop");
});

test("a Preview left open shows Write again on a phone, where there is no toggle", async () => {
  const real = window.matchMedia;
  const media = fakeMatchMedia.install(false);
  try {
    setup({ preview: true });
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() => media.set(true));
    expect(screen.getByRole("textbox", { name: "Message to Dev" })).toBeInTheDocument();
  } finally {
    window.matchMedia = real;
  }
});

// The one note slot (I1 §5.4, DESIGN §9.3).
const slot = () => document.querySelector("[data-composer-hint]") as HTMLElement;
const noteLine = () => document.querySelector("[data-composer-note-line]");

test("a fine pointer shows the note in the toolbar slot and the frame never changes height", () => {
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const { box, rerender } = setup();
  const frame = box.closest("[data-composer-frame]") as HTMLElement;
  const heightOf = () => frame.getBoundingClientRect().height;
  const before = heightOf();
  const siblings = frame.parentElement?.children.length;
  rerender({ note: { kind: "refusal", text: "Nope, not here." } });
  expect(slot()).toHaveTextContent("Nope, not here.");
  expect(frame.querySelector("[data-composer-toolbar]")?.contains(slot())).toBe(true);
  expect(heightOf()).toBe(before);
  expect(frame.parentElement?.children.length).toBe(siblings); // nothing is added under the frame
  expect(noteLine()).toBeNull();
  rect.mockRestore();
});

test("below md the one line is reserved under the frame, with no note in it", () => {
  const restore = onPhone();
  try {
    const { box, rerender } = setup({ reserveNote: true });
    const line = noteLine() as HTMLElement;
    expect(line).not.toBeNull();
    expect(line).toBeEmptyDOMElement();
    const frame = box.closest("[data-composer-frame]") as HTMLElement;
    const siblings = frame.parentElement?.children.length;
    rerender({ note: { kind: "conflict", text: "Several recipients." } });
    expect(noteLine()).toBe(line); // the same element, filled
    expect(line).toHaveTextContent("Several recipients.");
    expect(frame.parentElement?.children.length).toBe(siblings);
  } finally {
    restore();
  }
});

test("below md a composer that shows no notes reserves no line until one needs it", () => {
  const restore = onPhone();
  try {
    const { rerender } = setup();
    expect(noteLine()).toBeNull();
    rerender({ note: { kind: "refusal", text: "Nope." } });
    expect(noteLine()).toHaveTextContent("Nope.");
  } finally {
    restore();
  }
});

test("the slot carries its plain text in a title, so a cut line stays readable", () => {
  setup({ note: { kind: "refusal", text: "A long reason." } });
  expect(slot()).toHaveAttribute("title", "A long reason.");
});

test("one note at a time: error > refusal > conflict > hint", async () => {
  const onSubmit = vi.fn(async () => {
    throw new SubmitError("It failed.");
  });
  const { box, rerender } = setup({ onSubmit, note: { kind: "hint", text: "A hint." } });
  expect(slot()).toHaveTextContent("A hint.");
  rerender({ onSubmit, note: { kind: "conflict", text: "A conflict." } });
  expect(slot()).toHaveTextContent("A conflict.");
  // A dropped file is a refusal: it outranks the conflict.
  fireEvent.drop(box.closest("[data-composer-frame]") as HTMLElement, {
    dataTransfer: { files: [file("a.txt")], items: [], types: ["Files"] },
  });
  expect(slot()).toHaveTextContent(FILES_NOTE);
  expect(slot()).not.toHaveTextContent("A conflict.");
  rerender({ onSubmit, note: { kind: "refusal", text: "A refusal." } });
  expect(slot()).toHaveTextContent(FILES_NOTE); // equal rank: the composer's own is the more specific
  // An error outranks all of them.
  await userEvent.type(box, "x{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("It failed.");
  expect(slot()).toHaveTextContent("It failed.");
  expect(slot()).not.toHaveTextContent("A refusal.");
});

test("the slot is announced through the live region mounted with the box", () => {
  const { rerender } = setup();
  expect(slot()).toHaveAttribute("aria-live", "polite");
  expect(slot()).toBeEmptyDOMElement();
  rerender({ note: { kind: "refusal", text: "Refused." } });
  expect(slot()).toHaveAttribute("aria-live", "polite");
  expect(slot()).toHaveTextContent("Refused.");
});

test("a held Send is focusable and aria-disabled, its reason linked; pressing it shows the reason", async () => {
  const { box, onSubmit } = setupFiles();
  await userEvent.type(box, "see these");
  pasteFiles(box, [file("a.txt")]);
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toHaveAttribute("aria-disabled", "true");
  expect(send).toBeEnabled();
  expect(send).toHaveAccessibleDescription("Waiting for 1 upload");
  expect(slot()).not.toHaveTextContent("Waiting for 1 upload"); // not until it is pressed
  send.focus();
  expect(send).toHaveFocus();
  await userEvent.click(send);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(slot()).toHaveTextContent("Waiting for 1 upload");
});

// ---- Tags: atomic ranges over the text (principals and tags §4.5) ----

const ADA = refFor("ada");
const BOB = refFor("bob");
const HANDLES: Record<string, string> = { [ADA]: "ada", [BOB]: "bob" };
const TAGGING: CompletionSource = {
  trigger: "@",
  label: "Tag someone",
  opensAt: mentionOpensAt,
  items: (q) =>
    [
      { id: ADA, label: "Ada", detail: "@ada", group: "agents" },
      { id: BOB, label: "Bob", detail: "@bob", group: "humans" },
    ].filter((p) => p.detail.slice(1).startsWith(q)),
  accept: (item, text, from, caret) => acceptMention(text, item.id, from, caret),
  acceptTag: (item) => ({ ref: item.id, handle: (item.detail ?? "").slice(1) }),
  tagHandle: (ref) => HANDLES[ref],
};
const TAGS = { at: TAGGING };
const sentText = (onSubmit: ReturnType<typeof setup>["onSubmit"]) => onSubmit.mock.calls[0]?.[0];
/** The caret moved to `at`, then the event that makes React report a selection (a click's mouseup, a key's keyup). */
const caretAt = (box: HTMLElement, at: number, to = at, event: "mouseUp" | "keyUp" = "mouseUp") => {
  (box as HTMLTextAreaElement).setSelectionRange(at, to);
  fireEvent[event](box);
};
const undoKey = (box: HTMLElement) =>
  fireEvent(
    box,
    new InputEvent("beforeinput", { inputType: "historyUndo", cancelable: true, bubbles: true }),
  );
async function pickAda(box: HTMLElement, before = "") {
  await userEvent.type(box, `${before}@a`);
  await userEvent.keyboard("{Tab}");
}

test("picking from @ inserts a tag that is sent as <@ref>", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  await pickAda(box, "hi ");
  expect(box).toHaveValue("hi @ada ");
  await userEvent.type(box, "now{Enter}");
  expect(sentText(onSubmit)).toBe(`hi <@${ADA}> now`);
});

test("typed @name that wasn't picked is sent as text", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  await userEvent.type(box, "hi @ada{Escape}{Enter}");
  expect(sentText(onSubmit)).toBe("hi @ada");
});

test("a click inside a tag puts the caret at its edge", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box);
  fireEvent.mouseDown(box);
  caretAt(box, 1);
  expect((box as HTMLTextAreaElement).selectionStart).toBe(0);
  caretAt(box, 3);
  expect((box as HTMLTextAreaElement).selectionStart).toBe(4);
});

test("an arrow key moves the caret across a tag in one step", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box);
  caretAt(box, 4);
  fireEvent.keyDown(box, { key: "ArrowLeft" });
  caretAt(box, 3, 3, "keyUp"); // the browser's own move: one character left, into the tag
  expect((box as HTMLTextAreaElement).selectionStart).toBe(0);
});

test("a selection ending inside a tag grows to hold the whole tag", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box, "x ");
  caretAt(box, 0, 4);
  expect([
    (box as HTMLTextAreaElement).selectionStart,
    (box as HTMLTextAreaElement).selectionEnd,
  ]).toEqual([0, 6]);
});

test("Backspace at a tag's end removes it whole", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  await pickAda(box);
  caretAt(box, 4);
  fireEvent.keyDown(box, { key: "Backspace" });
  expect(box).toHaveValue("");
  await userEvent.type(box, "x{Enter}");
  expect(sentText(onSubmit)).toBe("x");
});

test("Delete at a tag's start removes it whole, with its space", async () => {
  const { box } = setup({ completions: TAGS });
  await userEvent.type(box, "a ");
  await pickAda(box);
  caretAt(box, 2);
  fireEvent.keyDown(box, { key: "Delete" });
  expect(box).toHaveValue("a ");
});

test("undo after deleting a tag restores it as a tag", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  await pickAda(box);
  caretAt(box, 4);
  fireEvent.keyDown(box, { key: "Backspace" });
  expect(box).toHaveValue("");
  const notPrevented = undoKey(box);
  expect(notPrevented).toBe(false); // the browser's own undo was stopped
  expect(box).toHaveValue("@ada ");
  await userEvent.type(box, "{Enter}");
  expect(sentText(onSubmit)).toBe(`<@${ADA}> `);
});

test("undo right after a pick brings back @query with the menu closed", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box);
  expect(box).toHaveValue("@ada ");
  undoKey(box);
  expect(box).toHaveValue("@a");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Ctrl+Y redoes what undo took back", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box);
  fireEvent.keyDown(box, { key: "z", ctrlKey: true });
  expect(box).toHaveValue("@a");
  fireEvent.keyDown(box, { key: "y", ctrlKey: true });
  expect(box).toHaveValue("@ada ");
});

test("typing undoes a word at a time, and after a pause", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const user = userEvent.setup({ delay: null });
  const { box } = setup({ completions: TAGS });
  await user.type(box, "one two");
  vi.setSystemTime(Date.now() + 600);
  await user.type(box, "three");
  fireEvent.keyDown(box, { key: "z", metaKey: true });
  expect(box).toHaveValue("one two");
  fireEvent.keyDown(box, { key: "z", metaKey: true });
  expect(box).toHaveValue("one");
  fireEvent.keyDown(box, { key: "z", metaKey: true, shiftKey: true });
  expect(box).toHaveValue("one two");
});

test("pasting copied tags keeps them as tags", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  const html = `<span data-of-tag="${ADA}">@ada</span> and <span data-of-tag="${BOB}">@bob</span>`;
  fireEvent.paste(box, {
    clipboardData: {
      files: [],
      getData: (t: string) => (t === "text/html" ? html : "@ada and @bob"),
    },
  });
  expect(box).toHaveValue("@ada and @bob");
  await userEvent.type(box, "{Enter}");
  expect(sentText(onSubmit)).toBe(`<@${ADA}> and <@${BOB}>`);
});

test("a pasted stored tag in plain text becomes a tag", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  fireEvent.paste(box, {
    clipboardData: {
      files: [],
      getData: (t: string) => (t === "text/plain" ? `<@${BOB}|bob> hi` : ""),
    },
  });
  expect(box).toHaveValue("@bob hi");
  await userEvent.type(box, "{Enter}");
  expect(sentText(onSubmit)).toBe(`<@${BOB}> hi`);
});

test("copying a tag writes @handle as text and a data-of-tag span as html", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box);
  (box as HTMLTextAreaElement).setSelectionRange(0, 5);
  const set = vi.fn();
  fireEvent.copy(box, { clipboardData: { setData: set } });
  expect(set).toHaveBeenCalledWith("text/plain", "@ada ");
  expect(set).toHaveBeenCalledWith("text/html", `<span data-of-tag="${ADA}">@ada</span> `);
});

test("a draft with a tag hydrates back to @handle and sends <@ref>", async () => {
  writeDraft("agent:dev", `hi <@${ADA}> there`);
  const { box, onSubmit } = setup({ completions: TAGS });
  expect(box).toHaveValue("hi @ada there");
  await userEvent.type(box, "{Enter}");
  expect(sentText(onSubmit)).toBe(`hi <@${ADA}> there`);
});

test("a tag whose principal is still pending shows @… and takes its handle once known", async () => {
  const late: Record<string, string> = {};
  let notify = () => {};
  const source: CompletionSource = {
    ...TAGGING,
    tagHandle: (ref) => late[ref],
    watchTags: (cb) => {
      notify = cb;
      return () => {};
    },
  };
  writeDraft("agent:dev", `hi <@${ADA}>`);
  const { box } = setup({ completions: { at: source } });
  expect(box).toHaveValue("hi @…");
  late[ADA] = "ada";
  act(() => notify());
  expect(box).toHaveValue("hi @ada");
});

test("an IME composition that starts inside a tag turns it back into plain text", async () => {
  const { box, onSubmit } = setup({ completions: TAGS });
  await pickAda(box);
  (box as HTMLTextAreaElement).setSelectionRange(2, 2); // no select event: the caret is left inside
  fireEvent.compositionStart(box);
  fireEvent.compositionEnd(box);
  await userEvent.type(box, "{Enter}");
  expect(sentText(onSubmit)).toBe("@ada ");
});

test("a composer without a tagging source leaves <@ref> text raw", async () => {
  writeDraft("agent:dev", `see <@${ADA}>`);
  const { box } = setup({ completions: { at: AT } });
  expect(box).toHaveValue(`see <@${ADA}>`);
});

test("a stored tag with a label or an uppercase ref hydrates as a tag without looping", async () => {
  writeDraft("agent:dev", `a <@${ADA}|ada> b <@${BOB.toUpperCase()}>`);
  const { box, onSubmit } = setup({ completions: TAGS });
  expect(box).toHaveValue("a @ada b @bob");
  await userEvent.type(box, "{Enter}");
  expect(sentText(onSubmit)).toContain(`<@${ADA}|ada>`);
});

test("cutting a tag removes it, puts it on the clipboard as a tag, and undo brings it back", async () => {
  const { box } = setup({ completions: TAGS });
  await pickAda(box, "x ");
  (box as HTMLTextAreaElement).setSelectionRange(2, 7);
  const set = vi.fn();
  fireEvent.cut(box, { clipboardData: { setData: set } });
  expect(set).toHaveBeenCalledWith("text/html", `<span data-of-tag="${ADA}">@ada</span> `);
  expect(box).toHaveValue("x ");
  fireEvent.keyDown(box, { key: "z", metaKey: true });
  expect(box).toHaveValue("x @ada ");
});

test("a paste never opens a menu, even when it ends in an @query", async () => {
  const { box } = setup({ completions: TAGS });
  const html = `<span data-of-tag="${ADA}">@ada</span> and @bo`;
  fireEvent.paste(box, {
    clipboardData: {
      files: [],
      getData: (t: string) => (t === "text/html" ? html : "@ada and @bo"),
    },
  });
  caretAt(box, 12, 12, "keyUp");
  expect(box).toHaveValue("@ada and @bo");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("an @query with no match closes the menu, and Esc then typing on doesn't reopen it", async () => {
  const { box } = setup({ completions: TAGS });
  await userEvent.type(box, "@a");
  expect(screen.getByRole("listbox", { name: "Tag someone" })).toBeInTheDocument();
  await userEvent.type(box, "zz");
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.clear(box);
  await userEvent.type(box, "@a{Escape}d");
  expect(screen.queryByRole("listbox")).toBeNull();
});
