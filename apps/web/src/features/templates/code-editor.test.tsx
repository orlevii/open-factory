import { redo, undo, undoDepth } from "@codemirror/commands";
import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, test, vi } from "vitest";
import CodeEditor, { type CodeEditorHandle } from "./code-editor";

type Props = Parameters<typeof CodeEditor>[0];

function setup(over: Partial<Props> = {}) {
  const states = over.states ?? new Map<string, EditorState>();
  const props: Props = {
    value: "a: 1\nb: 2\nc: 3\nd: 4\n",
    onChange: vi.fn(),
    onSave: vi.fn(),
    id: "f-yaml",
    labelledBy: "tab-yaml",
    describedBy: "desc-yaml",
    language: "yaml",
    fileKey: "t1/template.yaml",
    states,
    diagnostics: [],
    ...over,
  };
  const ref = createRef<CodeEditorHandle>();
  const r = render(<CodeEditor ref={ref} {...props} />);
  const view = () => {
    const content = r.container.querySelector(".cm-content");
    if (!content) throw new Error("no editor");
    const v = EditorView.findFromDOM(content as HTMLElement);
    if (!v) throw new Error("no view");
    return v;
  };
  return { ...r, props, ref, view, states };
}

function type(v: EditorView, text: string, at = v.state.doc.length) {
  act(() => v.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" }));
}

describe("CodeEditor", () => {
  test("an edit calls onChange with the whole doc", () => {
    const { view, props } = setup();
    type(view(), "e: 5");
    expect(props.onChange).toHaveBeenLastCalledWith("a: 1\nb: 2\nc: 3\nd: 4\ne: 5");
  });

  test("a replaced onChange is the one the next edit calls", () => {
    const { view, props, rerender, ref } = setup();
    const next = vi.fn();
    rerender(<CodeEditor ref={ref} {...props} onChange={next} />);
    const before = view();
    type(view(), "x");
    expect(next).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
    expect(view()).toBe(before);
  });

  test("an external value replaces the doc without onChange and isn't undoable", () => {
    const { view, props, rerender, ref } = setup();
    rerender(<CodeEditor ref={ref} {...props} value={"reloaded: true\n"} />);
    expect(view().state.doc.toString()).toBe("reloaded: true\n");
    expect(props.onChange).not.toHaveBeenCalled();
    expect(undoDepth(view().state)).toBe(0);
    act(() => {
      undo(view());
    });
    expect(view().state.doc.toString()).toBe("reloaded: true\n");
  });

  test("a value equal to what was just emitted dispatches nothing", () => {
    const { view, props, rerender, ref } = setup();
    type(view(), "e");
    const doc = view().state.doc.toString();
    const before = view().state;
    const spy = vi.spyOn(view(), "dispatch");
    rerender(<CodeEditor ref={ref} {...props} value={doc} />);
    expect(spy).not.toHaveBeenCalled();
    expect(view().state).toBe(before); // no setState replace either
  });

  test("unmount and remount with the same fileKey and states keeps the undo history", () => {
    const states = new Map<string, EditorState>();
    const a = setup({ states });
    type(a.view(), "e: 5");
    type(a.view(), "\nf: 6");
    const depth = undoDepth(a.view().state);
    expect(depth).toBeGreaterThan(0);
    const doc = a.view().state.doc.toString();
    a.unmount();

    const b = setup({ states, value: doc });
    expect(undoDepth(b.view().state)).toBe(depth);
    act(() => {
      undo(b.view());
    });
    expect(b.view().state.doc.toString()).toBe("a: 1\nb: 2\nc: 3\nd: 4\n");
    // The restored state runs this mount's handlers, not the unmounted one's.
    act(() => {
      redo(b.view());
    });
    expect(b.props.onChange).toHaveBeenCalled();
    expect(a.props.onChange).toHaveBeenCalledTimes(2);
  });

  test("two fileKeys keep separate histories", () => {
    const states = new Map<string, EditorState>();
    const { view, props, rerender, ref } = setup({ states });
    type(view(), "e: 5");
    const yamlDepth = undoDepth(view().state);

    rerender(
      <CodeEditor ref={ref} {...props} fileKey="t1/settings.json" language="json" value="{}" />,
    );
    expect(view().state.doc.toString()).toBe("{}");
    expect(undoDepth(view().state)).toBe(0);
    type(view(), " ");
    expect(undoDepth(view().state)).toBe(1);

    rerender(<CodeEditor ref={ref} {...props} value={"a: 1\nb: 2\nc: 3\nd: 4\ne: 5"} />);
    expect(view().state.doc.toString()).toBe("a: 1\nb: 2\nc: 3\nd: 4\ne: 5");
    expect(undoDepth(view().state)).toBe(yamlDepth);
    expect(states.get("t1/settings.json")?.doc.toString()).toBe("{} ");
  });

  test("the content is a labelled, described, multiline textbox", () => {
    const { container } = setup();
    const content = container.querySelector(".cm-content");
    expect(content).toHaveAttribute("role", "textbox");
    expect(content).toHaveAttribute("aria-multiline", "true");
    expect(content).toHaveAttribute("id", "f-yaml");
    expect(content).toHaveAttribute("aria-labelledby", "tab-yaml");
    const described = content?.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described).toContain("desc-yaml");
    // The keyboard hint is appended and resolves.
    const hint = described.find((d) => d !== "desc-yaml");
    expect(hint && document.getElementById(hint)).toHaveTextContent(
      "Esc then Tab to leave the editor",
    );
  });

  test("focusLine puts the selection at that line's start", () => {
    const { view, ref } = setup();
    act(() => ref.current?.focusLine(4));
    expect(view().state.selection.main.head).toBe(view().state.doc.line(4).from);
  });

  test("a bare Tab indents (prevented); after Esc it's let through to leave the editor", () => {
    const { view, container } = setup();
    const content = container.querySelector(".cm-content") as HTMLElement;
    act(() => content.focus());
    // CodeMirror reads Tab and Esc by keyCode.
    expect(fireEvent.keyDown(content, { key: "Tab", code: "Tab", keyCode: 9 })).toBe(false);
    expect(view().state.doc.toString()).toBe("  a: 1\nb: 2\nc: 3\nd: 4\n");
    fireEvent.keyDown(content, { key: "Escape", code: "Escape", keyCode: 27 });
    expect(fireEvent.keyDown(content, { key: "Tab", code: "Tab", keyCode: 9 })).toBe(true);
  });

  test("restore takes over a textarea's selection, backwards and clamped, and focus", () => {
    const { view, ref, container } = setup();
    act(() => ref.current?.restore({ anchor: 7, head: 2, focus: true }));
    expect(view().state.selection.main.anchor).toBe(7);
    expect(view().state.selection.main.head).toBe(2);
    expect(container.querySelector(".cm-content")).toHaveFocus();
    act(() => ref.current?.restore({ anchor: 0, head: 999, focus: false }));
    expect(view().state.selection.main.head).toBe(view().state.doc.length);
  });

  test("Mod-s calls onSave", () => {
    const { container, props } = setup();
    const content = container.querySelector(".cm-content") as HTMLElement;
    const isMac = /Mac/.test(navigator.platform);
    fireEvent.keyDown(content, {
      key: "s",
      code: "KeyS",
      keyCode: 83,
      [isMac ? "metaKey" : "ctrlKey"]: true,
    });
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  test("diagnostics become lint diagnostics on their lines", () => {
    const { view, props, rerender, ref } = setup();
    rerender(
      <CodeEditor
        ref={ref}
        {...props}
        diagnostics={[{ line: 2, column: 1, message: "nope", severity: "error" }]}
      />,
    );
    const found: { message: string; from: number }[] = [];
    forEachDiagnostic(view().state, (d, from) => found.push({ message: d.message, from }));
    expect(found).toEqual([{ message: "nope", from: view().state.doc.line(2).from }]);
  });

  test("on phones a diagnostic marks its line number instead of a lint gutter", () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      ...real(q),
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as typeof window.matchMedia;
    try {
      const { container } = setup({
        diagnostics: [{ line: 2, message: "nope", severity: "error" }],
      });
      expect(container.querySelector(".cm-gutter-lint")).toBeNull();
      const marked = container.querySelector(".cm-lineNumbers .cm-lineDiag-error");
      expect(marked).toHaveTextContent("2");
    } finally {
      window.matchMedia = real;
    }
  });

  test("on desktop diagnostics get the lint gutter", () => {
    const { container } = setup({ diagnostics: [{ line: 2, message: "nope", severity: "error" }] });
    expect(container.querySelector(".cm-gutter-lint")).not.toBeNull();
  });

  test("an external replace after edits starts a fresh history: undo can't replay old edits onto it", () => {
    const { view, props, rerender, ref, states } = setup({ value: "keep foo here" });
    act(() => view().dispatch({ changes: { from: 5, to: 9 }, userEvent: "delete" }));
    expect(view().state.doc.toString()).toBe("keep here");
    expect(undoDepth(view().state)).toBe(1);
    vi.mocked(props.onChange).mockClear();

    rerender(<CodeEditor ref={ref} {...props} value={"server: v2\n"} />);
    expect(view().state.doc.toString()).toBe("server: v2\n");
    expect(undoDepth(view().state)).toBe(0);
    act(() => {
      undo(view());
    });
    expect(view().state.doc.toString()).toBe("server: v2\n");
    expect(props.onChange).not.toHaveBeenCalled();
    expect(states.get(props.fileKey)).toBe(view().state);
  });

  test("a later external value equal to an old emitted doc still replaces the doc", () => {
    const { view, props, rerender, ref } = setup({ value: "a" });
    type(view(), "b"); // emits "ab"
    rerender(<CodeEditor ref={ref} {...props} value="ab" />);
    rerender(<CodeEditor ref={ref} {...props} value="server" />);
    expect(view().state.doc.toString()).toBe("server");
    rerender(<CodeEditor ref={ref} {...props} value="ab" />);
    expect(view().state.doc.toString()).toBe("ab");
  });

  test("an external replace keeps the file's diagnostics", () => {
    const diagnostics = [{ line: 1, message: "nope", severity: "error" as const }];
    const { view, props, rerender, ref } = setup({ diagnostics });
    rerender(<CodeEditor ref={ref} {...props} diagnostics={diagnostics} value={"x: 1\n"} />);
    const found: string[] = [];
    forEachDiagnostic(view().state, (d) => found.push(d.message));
    expect(found).toEqual(["nope"]);
  });

  test("an equal diagnostics list in a new array isn't re-sent", () => {
    const diag = { line: 1, message: "nope", severity: "error" as const };
    const { view, props, rerender, ref } = setup({ diagnostics: [diag] });
    const spy = vi.spyOn(view(), "dispatch");
    rerender(<CodeEditor ref={ref} {...props} diagnostics={[{ ...diag }]} />);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a describedBy that arrives after mount reaches the content element", () => {
    const { container, props, rerender, ref } = setup({ describedBy: undefined });
    const content = () => container.querySelector(".cm-content");
    expect(content()?.getAttribute("aria-describedby")?.split(" ")).not.toContain("warm-hint");
    rerender(<CodeEditor ref={ref} {...props} describedBy="warm-hint" />);
    expect(content()?.getAttribute("aria-describedby")?.split(" ")).toContain("warm-hint");
  });

  test("crossing the phone breakpoint keeps the diagnostic marks", () => {
    const real = window.matchMedia;
    const listeners = new Set<(e: Event) => void>();
    let matches = false;
    window.matchMedia = ((q: string) => ({
      ...real(q),
      get matches() {
        return matches;
      },
      addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
    })) as typeof window.matchMedia;
    try {
      const { container } = setup({
        diagnostics: [{ line: 2, message: "nope", severity: "warning" }],
      });
      expect(container.querySelector(".cm-gutter-lint .cm-lint-marker-warning")).not.toBeNull();
      act(() => {
        matches = true;
        for (const l of listeners) l(new Event("change"));
      });
      expect(container.querySelector(".cm-gutter-lint")).toBeNull();
      expect(container.querySelector(".cm-lineNumbers .cm-lineDiag-warning")).toHaveTextContent(
        "2",
      );
      act(() => {
        matches = false;
        for (const l of listeners) l(new Event("change"));
      });
      expect(container.querySelector(".cm-gutter-lint .cm-lint-marker-warning")).not.toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
