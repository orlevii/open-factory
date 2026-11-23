import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { focusField } from "@/components/forms/focus-field";
import { useFieldErrors } from "@/components/forms/use-field-errors";

type F = "title" | "path";
let api: ReturnType<typeof useFieldErrors<F>>;
let setPendingOut: (p: boolean) => void;
function Harness({ startHidden = false }: { startHidden?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const [v, setV] = useState({ title: "", path: "" });
  const [hidePath, setHidePath] = useState(startHidden);
  const [pending, setPending] = useState(false);
  setPendingOut = setPending;
  api = useFieldErrors<F>({
    form,
    fields: ["title", "path"],
    checks: {
      title: () => (v.title.trim() ? undefined : "Enter a title."),
      path: () =>
        !v.path ? "Enter a path." : v.path.startsWith("/") ? undefined : "Use an absolute path.",
    },
  });
  const field = (f: F) => (
    <div data-field="">
      <input
        aria-label={f}
        aria-invalid={api.errors[f] ? true : undefined}
        value={v[f]}
        onChange={(e) => {
          setV((x) => ({ ...x, [f]: e.target.value }));
          api.change(f);
        }}
        onBlur={(e) => api.blur(f, e)}
      />
      <span>{api.errors[f]}</span>
    </div>
  );
  return (
    <form ref={form}>
      <fieldset disabled={pending}>
        {field("title")}
        {!hidePath && field("path")}
      </fieldset>
      <button type="button" data-skip-validate="">
        Close
      </button>
      <button type="button">Other</button>
      <button
        type="button"
        onClick={() => {
          setHidePath(false);
          api.set("path", "Enter a path.", { focus: true });
        }}
      >
        Reveal
      </button>
    </form>
  );
}
const renderH = (p?: { startHidden?: boolean }) =>
  render(
    <StrictMode>
      <Harness {...p} />
    </StrictMode>,
  );

afterEach(() => vi.restoreAllMocks());

test("tabbing past an untouched field shows nothing", async () => {
  renderH();
  await userEvent.click(screen.getByLabelText("title"));
  await userEvent.tab();
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("blur on a changed field flags; while flagged the message follows typing; a pass clears and typing never re-flags", async () => {
  renderH();
  const path = screen.getByLabelText("path");
  await userEvent.type(path, "a");
  await userEvent.click(screen.getByText("Other"));
  expect(screen.getByText("Use an absolute path.")).toBeInTheDocument();
  await userEvent.clear(path);
  expect(screen.getByText("Enter a path.")).toBeInTheDocument();
  await userEvent.type(path, "/x");
  expect(screen.queryByText(/path\./)).toBeNull();
  await userEvent.clear(path);
  expect(screen.queryByText("Enter a path.")).toBeNull(); // no error while typing once fixed
});

test("blur to a data-skip-validate control doesn't validate", async () => {
  renderH();
  await userEvent.type(screen.getByLabelText("title"), " ");
  await userEvent.click(screen.getByText("Close"));
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("blur while the document has lost focus doesn't validate", async () => {
  renderH();
  const title = screen.getByLabelText("title");
  await userEvent.type(title, " ");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  fireEvent.blur(title);
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("submit flags all, focuses the first invalid field in DOM order, bumps attempt", () => {
  renderH();
  let ok = true;
  act(() => {
    ok = api.submit();
  });
  expect(ok).toBe(false);
  expect(api.attempt).toBe(1);
  expect(screen.getByLabelText("title")).toHaveFocus();
});

test("a same-tick async result passed as extra fails submit and gets focus; change clears it", async () => {
  renderH();
  await userEvent.type(screen.getByLabelText("title"), "x");
  await userEvent.type(screen.getByLabelText("path"), "/x");
  let ok = true;
  act(() => {
    ok = api.submit(undefined, { path: "No folder at this path." });
  });
  expect(ok).toBe(false);
  expect(screen.getByText("No folder at this path.")).toBeInTheDocument();
  expect(screen.getByLabelText("path")).toHaveFocus();
  await userEvent.type(screen.getByLabelText("path"), "y");
  expect(screen.queryByText("No folder at this path.")).toBeNull();
});

test("submit with a subset unflags the rest", () => {
  renderH();
  act(() => {
    api.submit();
  });
  act(() => {
    api.submit(["path"]);
  });
  expect(screen.queryByText("Enter a title.")).toBeNull();
  expect(screen.getByText("Enter a path.")).toBeInTheDocument();
});

test("server maps known fields only and says whether it did", () => {
  renderH();
  let mapped = true;
  act(() => {
    mapped = api.server({ other: "x" });
  });
  expect(mapped).toBe(false);
  act(() => {
    mapped = api.server({ path: "Another project uses this folder." });
  });
  expect(mapped).toBe(true);
  expect(screen.getByLabelText("path")).toHaveFocus();
});

test("a fieldset re-enabled in the same update as server() lets the field take focus", () => {
  renderH();
  act(() => setPendingOut(true));
  act(() => {
    setPendingOut(false);
    api.server({ path: "Another project uses this folder." });
  });
  expect(screen.getByLabelText("path")).toHaveFocus();
});

test("focus reaches a field that mounts in the same commit; set with focus requests focus even when the message is unchanged", async () => {
  renderH({ startHidden: true });
  await userEvent.click(screen.getByText("Reveal"));
  expect(screen.getByLabelText("path")).toHaveFocus();
  await userEvent.click(screen.getByText("Other"));
  await userEvent.click(screen.getByText("Reveal")); // same message again
  expect(screen.getByLabelText("path")).toHaveFocus();
});

test("focusField skips invalid fields in a disabled fieldset and scrolls the whole field into view", () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const { container } = render(
    <div>
      <fieldset disabled>
        <div data-field="" data-testid="a">
          <input aria-label="a" aria-invalid="true" />
        </div>
      </fieldset>
      <div data-field="" data-testid="b">
        <input aria-label="b" aria-invalid="true" />
      </div>
    </div>,
  );
  focusField(container);
  expect(screen.getByLabelText("b")).toHaveFocus();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.contexts[0]).toBe(screen.getByTestId("b"));
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});

test("a blur with no relatedTarget after a pointerdown on a skip control doesn't validate; later than 500ms it does", async () => {
  renderH();
  const title = screen.getByLabelText("title");
  await userEvent.type(title, " ");
  let now = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  fireEvent.pointerDown(screen.getByText("Close"));
  now += 100;
  fireEvent.blur(title);
  expect(screen.queryByText("Enter a title.")).toBeNull();
  now += 600;
  fireEvent.blur(title);
  expect(screen.getByText("Enter a title.")).toBeInTheDocument();
});

test("submit returns true and neither bumps attempt nor moves focus when all checks pass", async () => {
  renderH();
  await userEvent.type(screen.getByLabelText("title"), "x");
  await userEvent.type(screen.getByLabelText("path"), "/x");
  screen.getByText("Other").focus();
  let ok = false;
  act(() => {
    ok = api.submit();
  });
  expect(ok).toBe(true);
  expect(api.attempt).toBe(0);
  expect(screen.getByText("Other")).toHaveFocus();
});

test("extra with an undefined value clears a prior external error", () => {
  renderH();
  act(() => api.set("path", "No folder at this path."));
  expect(screen.getByText("No folder at this path.")).toBeInTheDocument();
  let ok = false;
  act(() => {
    ok = api.submit(["path"], { path: undefined });
  });
  expect(screen.queryByText("No folder at this path.")).toBeNull();
  expect(ok).toBe(false); // the empty path still fails its own check
  expect(screen.getByText("Enter a path.")).toBeInTheDocument();
});

test("reset clears flags, external errors and the changed marks", async () => {
  renderH();
  await userEvent.type(screen.getByLabelText("title"), " ");
  await userEvent.click(screen.getByText("Other"));
  act(() => api.set("path", "No folder at this path."));
  expect(screen.getByText("Enter a title.")).toBeInTheDocument();
  act(() => api.reset());
  expect(screen.queryByText("Enter a title.")).toBeNull();
  expect(screen.queryByText("No folder at this path.")).toBeNull();
  fireEvent.blur(screen.getByLabelText("title")); // no longer counted as changed
  expect(screen.queryByText("Enter a title.")).toBeNull();
});

test("change clears a server message for that field", async () => {
  renderH();
  act(() => {
    api.server({ path: "Another project uses this folder." });
  });
  expect(screen.getByText("Another project uses this folder.")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("path"), "/");
  expect(screen.queryByText("Another project uses this folder.")).toBeNull();
});

test("server replaces all external messages, not merges", () => {
  renderH();
  act(() => api.set("title", "Title is taken."));
  act(() => {
    api.server({ path: "Another project uses this folder." });
  });
  expect(screen.queryByText("Title is taken.")).toBeNull();
  expect(screen.getByText("Another project uses this folder.")).toBeInTheDocument();
});
