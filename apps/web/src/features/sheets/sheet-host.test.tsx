import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { useSheetDraft } from "./drafts";
import { SheetFormFooter } from "./form-footer";
import { type BodyProps, sheetBodies } from "./sheet-bodies";
import { SheetHost } from "./sheet-host";
import { closeSheet, openChildSheet, openSheet } from "./sheet-store";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "connecting", send: () => true }),
}));

let renders = 0;
function StubTask({ close }: BodyProps<{ kind: "new-task" }>) {
  const draft = useSheetDraft("new-task", () => ({ title: "" }));
  const [title, setTitle] = useState(draft.start.title);
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <input
        aria-label="Title"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          draft.save({ title: e.target.value });
        }}
      />
      <SheetFormFooter
        submitLabel="Create task"
        pendingLabel="Creating…"
        pending={false}
        restored={draft.restored}
        onDiscard={() => {
          draft.clear();
          setTitle("");
        }}
      />
      <button type="button" onClick={close}>
        stub-close
      </button>
    </form>
  );
}
function StubChild() {
  return <p>child body</p>;
}

const restoreBodies = { ...sheetBodies };
let gate: Promise<unknown> = Promise.resolve();
beforeEach(() => {
  localStorage.clear();
  fakeMatchMedia.install(false);
  mockApi({
    "GET /api/agents?ended=exclude": () => json({ agents: [], running: { count: 0, max: 8 } }),
    "GET /api/agents?ended=only": () =>
      json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
  gate = Promise.resolve();
  sheetBodies["new-task"] = {
    load: async () => {
      await gate;
      return { default: StubTask as never };
    },
    prefetch: () => {},
    title: "New task",
  };
  sheetBodies["add-project"] = {
    load: async () => ({ default: StubChild as never }),
    prefetch: () => {},
    title: "Add project",
  };
});
afterEach(() => {
  act(() => closeSheet());
  for (const k of Object.keys(sheetBodies)) delete (sheetBodies as Record<string, unknown>)[k];
  Object.assign(sheetBodies, restoreBodies);
});

async function shell(path = "/inbox") {
  const r = renderApp(path, alice);
  await screen.findByRole("heading", { level: 1 });
  return r;
}
const dialog = () => screen.queryByRole("dialog", { name: "New task" });

test("a sheet opened over /tasks closes when the path changes, not on a search change", async () => {
  const { router } = await shell("/tasks");
  act(() => openSheet({ kind: "new-task" }));
  expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
  await act(() => router.navigate({ to: "/tasks", search: { q: "x" } as never }));
  expect(dialog()).toBeInTheDocument();
  await act(() => router.navigate({ to: "/agents" }));
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
});

test("a redirect-opened sheet (at: '/tasks') survives the navigation that lands on /tasks", async () => {
  const { router } = await shell("/inbox");
  act(() => openSheet({ kind: "new-task" }, { at: "/tasks" }));
  await act(() => router.navigate({ to: "/tasks" }));
  expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
  await act(() => router.navigate({ to: "/agents" }));
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
});

test("the child sheet stacks over the parent; Esc closes only the child", async () => {
  await shell();
  act(() => openSheet({ kind: "new-task" }));
  await screen.findByRole("dialog", { name: "New task" });
  act(() => openChildSheet({ kind: "add-project" }, () => {}));
  const child = await screen.findByRole("dialog", { name: "Add project" });
  expect(await screen.findByText("child body")).toBeInTheDocument();
  expect(child).toHaveTextContent("child body");
  expect(screen.getByText("For New task")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());
  expect(dialog()).toBeInTheDocument();
});

test("the body's chunk loads lazily; the skeleton shows header and field rows meanwhile", async () => {
  await shell();
  let release = () => {};
  gate = new Promise<void>((r) => {
    release = r;
  });
  act(() => openSheet({ kind: "new-task" }));
  const panel = await screen.findByRole("dialog", { name: "New task" });
  expect(panel.querySelector("[data-slot=body-skeleton]")).not.toBeNull();
  expect(screen.queryByLabelText("Title")).toBeNull();
  await act(async () => release());
  expect(await screen.findByLabelText("Title")).toBeInTheDocument();
  expect(panel.querySelector("[data-slot=body-skeleton]")).toBeNull();
});

test("opening starts the body's queries before its chunk resolves", async () => {
  await shell();
  let release = () => {};
  gate = new Promise<void>((r) => {
    release = r;
  });
  const prefetch = vi.fn();
  sheetBodies["new-task"] = { ...sheetBodies["new-task"]!, prefetch };
  act(() => openSheet({ kind: "new-task" }));
  await screen.findByRole("dialog", { name: "New task" });
  expect(prefetch).toHaveBeenCalledTimes(1);
  expect(prefetch.mock.calls[0]?.[1]).toMatchObject({ kind: "new-task" });
  await act(async () => release());
  await screen.findByLabelText("Title");
});

test("Close keeps the draft; reopening shows 'Draft restored · Discard'; Discard clears it", async () => {
  await shell();
  act(() => openSheet({ kind: "new-task" }));
  await userEvent.type(await screen.findByLabelText("Title"), "Write docs");
  expect(screen.queryByText(/Draft restored/)).toBeNull();
  await userEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  act(() => openSheet({ kind: "new-task" }));
  expect(await screen.findByLabelText("Title")).toHaveValue("Write docs");
  expect(screen.getByText(/Draft restored/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByLabelText("Title")).toHaveValue("");
  act(() => closeSheet());
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  act(() => openSheet({ kind: "new-task" }));
  await screen.findByLabelText("Title");
  expect(screen.queryByText(/Draft restored/)).toBeNull();
});

test("typing in a body's field re-renders neither the host nor its parent", async () => {
  const router = (await shell()).router;
  void router;
  // The host is rendered by the shell; count renders of a second host under a Profiler instead.
  const { queryClient } = await shell();
  const onRender = vi.fn(() => void renders++);
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } = await import(
    "@tanstack/react-router"
  );
  const root = createRootRoute({
    component: () => (
      <Profiler id="host" onRender={onRender}>
        <SheetHost />
      </Profiler>
    ),
  });
  const r2 = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={r2} />
    </QueryClientProvider>,
  );
  act(() => openSheet({ kind: "new-task" }));
  const input = (await screen.findAllByLabelText("Title")).at(-1) as HTMLElement;
  const before = renders;
  await userEvent.type(input, "abc");
  expect(renders).toBe(before);
});
