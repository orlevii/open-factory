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
    const spy = vi.spyOn(view(), "dispatch");
    rerender(<CodeEditor ref={ref} {...props} value={doc} />);
    expect(spy).not.toHaveBeenCalled();
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
});
