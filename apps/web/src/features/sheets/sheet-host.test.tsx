import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NO_OUTCOME } from "@/components/forms/form-outcome";
import { createQueryClient } from "@/lib/query-client";
import { agentSummary } from "@/test/agent-screens-fixtures";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { useSheetDraft } from "./drafts";
import { SheetFormFooter } from "./form-footer";
import { type BodyProps, sheetBodies } from "./sheet-bodies";
import {
  closeSheet,
  completeChild,
  getSheetState,
  openChildSheet,
  openSheet,
  openSheetForResult,
  returnFocusAfterChild,
} from "./sheet-store";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "connecting", send: () => true }),
}));

// SheetHost calls useSheet once per render, and re-renders whenever the shell above it does (no props, no memo).
let hostRenders = 0;
vi.mock("./sheet-store", async (orig) => {
  const m = await orig<typeof import("./sheet-store")>();
  return {
    ...m,
    useSheet: () => {
      hostRenders++;
      return m.useSheet();
    },
  };
});
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
        outcome={NO_OUTCOME}
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
    "GET /api/agents?ended=exclude": () => json({ agents: [], running: { count: 0 } }),
    "GET /api/agents?ended=only": () => json({ agents: [], more: false, running: { count: 0 } }),
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
  sheetBodies["add-secret"] = {
    load: async () => ({ default: StubChild as never }),
    prefetch: () => {},
    title: "Add secret",
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
  expect(screen.getByText("For New task.")).toBeInTheDocument();
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

test("a chunk that fails to load shows Retry inside the sheet; Retry loads the body; Close still works", async () => {
  await shell();
  let calls = 0;
  sheetBodies["new-task"] = {
    ...(sheetBodies["new-task"] as NonNullable<(typeof sheetBodies)["new-task"]>),
    load: async () => {
      if (++calls === 1) throw new Error("Failed to fetch dynamically imported module");
      return { default: StubTask as never };
    },
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  act(() => openSheet({ kind: "new-task" }));
  const panel = await screen.findByRole("dialog", { name: "New task" });
  const retry = await within(panel).findByRole("button", { name: "Retry" });
  expect(screen.getByRole("heading", { level: 1, hidden: true })).toBeInTheDocument();
  await userEvent.click(retry);
  expect(await screen.findByLabelText("Title")).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "Retry" })).toBeNull();
  await userEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
});

test("an entry's title can be a function of the spec", async () => {
  await shell();
  sheetBodies["new-task"] = {
    ...(sheetBodies["new-task"] as NonNullable<(typeof sheetBodies)["new-task"]>),
    title: (spec: { assignee?: string }) => `Task for ${spec.assignee}`,
  };
  act(() => openSheet({ kind: "new-task", assignee: "bob" }));
  expect(await screen.findByRole("dialog", { name: "Task for bob" })).toBeInTheDocument();
});

test("typing in a body's field re-renders neither SheetHost nor the shell above it", async () => {
  await shell();
  act(() => openSheet({ kind: "new-task" }));
  const input = await screen.findByLabelText("Title");
  const before = hostRenders;
  await userEvent.type(input, "abc");
  expect(hostRenders).toBe(before);
});

test("edit-schedule prefetches the detail and the live agents only (edit mode never reads the ended list)", () => {
  const prefetchQuery = vi.fn(() => Promise.resolve());
  restoreBodies["edit-schedule"]?.prefetch({ prefetchQuery } as never, { key: "S-3" });
  expect(
    prefetchQuery.mock.calls.map((c) => (c as unknown as [{ queryKey: unknown }])[0].queryKey),
  ).toEqual([
    ["schedules", "detail", "S-3"],
    ["agents", "exclude"],
  ]);
});

test("add-project prefetch requests host info with the never-stale options", () => {
  const prefetchQuery = vi.fn(() => Promise.resolve());
  restoreBodies["add-project"]?.prefetch({ prefetchQuery } as never, { kind: "add-project" });
  const opts = (
    prefetchQuery.mock.calls as unknown as [{ queryKey: unknown; staleTime?: number }][]
  ).map((c) => c[0]);
  expect(opts.find((o) => (o.queryKey as string[])[0] === "host")?.staleTime).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("intent prefetch has its own freshness window: hover, press and open fetch each list once", async () => {
  const api = mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/projects": () => json({ projects: [] }),
    "GET /api/agents/lead": () =>
      json({
        agent: agentSummary({ slug: "lead" }),
        queue: [],
        lastSeq: 0,
      }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0 } }),
  });
  const qc = createQueryClient({ queries: { retry: false } });
  const prefetch = restoreBodies["edit-agent"]?.prefetch;
  for (let i = 0; i < 3; i++) {
    prefetch?.(qc, { kind: "edit-agent", slug: "lead" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const gets = (url: string) => api.calls.filter((c) => c.url === url).length;
  expect(gets("/api/credentials")).toBe(1);
  expect(gets("/api/projects")).toBe(1);
  expect(gets("/api/agents/lead")).toBe(1);
});

test("each open has its own opener: one started from the page body doesn't return focus to the last one's", async () => {
  await shell();
  const button = document.createElement("button");
  button.textContent = "First opener";
  document.body.append(button);
  try {
    button.focus();
    act(() => openSheet({ kind: "new-task" }));
    await screen.findByRole("dialog", { name: "New task" });
    act(() => closeSheet());
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
    // A shortcut-style open: focus is on the page body.
    button.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => openSheet({ kind: "new-task" }));
    await screen.findByRole("dialog", { name: "New task" });
    act(() => closeSheet());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).not.toBe(button);
  } finally {
    button.remove();
  }
});

test("Add secret opened from a page returns focus to the field it filled, not to its opener", async () => {
  await shell();
  const opener = document.createElement("button");
  opener.textContent = "Insert secret";
  const value = document.createElement("input");
  value.setAttribute("aria-label", "Value");
  document.body.append(opener, value);
  try {
    opener.focus();
    act(() =>
      openSheetForResult({ kind: "add-secret", name: "" }, (name) => {
        value.value = `\${${name}}`;
        returnFocusAfterChild(() => value);
      }),
    );
    await screen.findByRole("dialog", { name: "Add secret" });
    act(() => completeChild(getSheetState().parent?.id ?? -1, "GH_TOKEN"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add secret" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(value));
    expect(value.value).toBe(`\${GH_TOKEN}`);
  } finally {
    opener.remove();
    value.remove();
  }
});

test("Add credential opened for a result with no sheet open serves itself: submitting closes it and returns focus to the opener", async () => {
  mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/claude-sign-in": () => json({ available: true, attempt: null }),
    "POST /api/credentials": () =>
      json(
        {
          credential: {
            name: "work",
            kind: "oauth_token",
            lastVerifiedAt: "2026-11-23T12:00:00Z",
            lastError: null,
            expiresAt: null,
            rejected: false,
            usedBy: [],
            archivedUsedBy: [],
            rateLimit: null,
          },
        },
        201,
      ),
  });
  await shell();
  const opener = document.createElement("button");
  opener.textContent = "Add credential";
  document.body.append(opener);
  try {
    opener.focus();
    const done = vi.fn();
    act(() => openSheetForResult({ kind: "add-credential" }, done));
    const d = await screen.findByRole("dialog", { name: "Add credential" });
    await userEvent.click(await within(d).findByRole("radio", { name: "Paste a token" }));
    await userEvent.type(within(d).getByLabelText("Name"), "work");
    await userEvent.type(within(d).getByLabelText("Token"), "sk-ant-oat01-SYNTHETIC{Enter}");
    await waitFor(() => expect(done).toHaveBeenCalledWith("work"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add credential" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  } finally {
    opener.remove();
  }
});

test("a top-level sheet shows its entry's description", async () => {
  await shell();
  sheetBodies["new-task"] = {
    ...sheetBodies["new-task"]!,
    description: () => "work",
  };
  act(() => openSheet({ kind: "new-task" }));
  const panel = await screen.findByRole("dialog", { name: "New task" });
  const description = within(panel).getByText("work");
  expect(description).toHaveAttribute("data-slot", "sheet-description");
});
