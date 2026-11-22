import { EditorView } from "@codemirror/view";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

// The editor's chunk is held until a test opens the gate. The lazy import settles once per file, so
// the tests run in order: the textarea fallback first, then the swap.
const gate = vi.hoisted(() => {
  let open = () => {};
  const loaded = new Promise<void>((r) => {
    open = r;
  });
  return { loaded, open: () => open() };
});
vi.mock("@/features/templates/code-editor", async (importOriginal) => {
  await gate.loaded;
  return importOriginal();
});
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

// jsdom has no Range geometry; a focused CodeMirror measures its cursor and selection with it.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const yaml = "name: lead\ndisplay_name: Lead\n";
const detail = (issues: unknown[] = []) => ({
  template: {
    name: "lead",
    path: "/h/of/templates/lead",
    issues,
    agents: [],
    avatar: { version: null, tooLarge: false },
    files: [
      { file: "template.yaml", content: yaml, hash: "h1" },
      { file: "AGENTS.md", content: "# Lead\n", hash: "h2" },
      { file: "settings.json", content: '{\n  "a": 1\n}\n', hash: "h3" },
      { file: "mcp.json", content: null, hash: null },
    ],
  },
});
const textarea = (name: string) => {
  const el = screen.getByRole("textbox", { name });
  expect(el.tagName).toBe("TEXTAREA");
  return el as HTMLTextAreaElement;
};

test("while the editor's chunk loads, the textarea fallback serves an issue's jump", async () => {
  mockApi({
    "GET /api/templates/lead": () =>
      json(
        detail([
          { severity: "error", file: "settings.json", message: "JSON: bad", line: 2, column: 3 },
        ]),
      ),
  });
  renderApp("/templates/lead", alice);
  await userEvent.click(
    await screen.findByRole("button", { name: /settings\.json.*2:3.*JSON: bad/ }),
  );
  const el = textarea("settings.json");
  expect(el).toHaveFocus();
  expect(el.selectionStart).toBe(el.value.indexOf("\n") + 1);
  expect(el).toHaveClass("pl-15"); // padded by the gutter the editor will have
});

test("on the swap the selection and focus carry over; an earlier tab's textarea leaves nothing behind", async () => {
  mockApi({
    "GET /api/templates/lead": () => json(detail()),
    "POST /api/templates/lead/validate": () => json({ issues: [] }),
  });
  renderApp("/templates/lead", alice);
  await screen.findByRole("textbox", { name: "template.yaml" });
  // A selection in settings.json, then away from it before the chunk arrives: not a swap.
  await userEvent.click(screen.getByRole("tab", { name: /settings\.json/ }));
  const settings = textarea("settings.json");
  act(() => {
    settings.focus();
    settings.setSelectionRange(3, 5);
  });
  await userEvent.click(screen.getByRole("tab", { name: /template\.yaml/ }));

  const el = textarea("template.yaml");
  act(() => {
    el.focus();
    el.setSelectionRange(2, 6, "backward");
  });
  await act(async () => gate.open());

  const editor = await waitFor(() => {
    const e = screen.getByRole("textbox", { name: "template.yaml" });
    expect(e).toHaveClass("cm-content");
    return e;
  });
  const sel = (EditorView.findFromDOM(editor) as EditorView).state.selection.main;
  expect([sel.anchor, sel.head]).toEqual([6, 2]);
  expect(editor).toHaveFocus();

  await userEvent.click(screen.getByRole("tab", { name: /settings\.json/ }));
  const later = await waitFor(() => {
    const e = screen.getByRole("textbox", { name: "settings.json" });
    expect(e).toHaveClass("cm-content");
    return e;
  });
  const fresh = (EditorView.findFromDOM(later) as EditorView).state.selection.main;
  expect([fresh.anchor, fresh.head]).toEqual([0, 0]);
});
