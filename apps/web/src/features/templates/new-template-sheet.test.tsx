import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { clearDraft, hasDraft } from "@/features/sheets/drafts";
import {
  closeSheet,
  getSheetState,
  openChildSheet,
  openSheet,
} from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));

// biome-ignore lint/suspicious/noThenProperty: SheetSpec's field, not a thenable
const EDITOR = { kind: "new-template", then: "open-editor" } as const;
// biome-ignore lint/suspicious/noThenProperty: ChildSpec's field, not a thenable
const STACKED = { kind: "new-template", then: "return" } as const;

beforeEach(() => {
  fakeMatchMedia.install(false);
  clearDraft("new-template");
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const detail = (name: string) => ({
  template: {
    name,
    path: `/d/${name}`,
    files: [],
    issues: [],
    agents: [],
    avatar: { version: null, tooLarge: false },
  },
});
function base() {
  let release: (r: Response) => void = () => {};
  const api = mockApi({
    "GET /api/templates": () => json({ dir: "/d", templates: [] }),
    "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "POST /api/templates": () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  });
  return { api, release: (r: Response) => release(r) };
}
async function fill(text: string) {
  const d = await screen.findByRole("dialog", { name: "New template" });
  await userEvent.type(await within(d).findByLabelText("Display name"), text);
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
}

test("stacked: success hands the name to the parent and closes only the child", async () => {
  const { release } = base();
  renderApp("/tasks", alice);
  await screen.findByRole("heading", { level: 1, name: "Tasks", hidden: true });
  const onDone = vi.fn();
  act(() => openSheet({ kind: "new-task" }));
  await screen.findByRole("dialog", { name: "New task" });
  act(() => openChildSheet(STACKED, onDone));
  await fill("Lead");
  release(json(detail("lead"), 201));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("lead"));
  expect(getSheetState().child).toBeUndefined();
  expect(getSheetState().parent?.kind).toBe("new-task");
  expect(hasDraft("new-template")).toBe(false);
});

test("a late success toasts Open, does not navigate, and clears the draft when nothing reopened", async () => {
  const { release } = base();
  const { router } = renderApp("/templates", alice);
  await screen.findByRole("heading", { level: 1, name: "Templates" });
  act(() => openSheet(EDITOR));
  await fill("Lead");
  act(() => closeSheet());
  release(json(detail("lead"), 201));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const toast = vi.mocked(notify).mock.calls[0]?.[0];
  expect(toast?.text).toBe("Created lead.");
  expect(router.state.location.pathname).toBe("/templates");
  expect(hasDraft("new-template")).toBe(false);
  await act(async () => toast?.action?.run());
  await waitFor(() => expect(router.state.location.pathname).toBe("/templates/lead"));
});

test("a late success keeps the draft the user restored by reopening New template", async () => {
  const { release } = base();
  renderApp("/templates", alice);
  await screen.findByRole("heading", { level: 1, name: "Templates" });
  act(() => openSheet(EDITOR));
  await fill("Lead");
  act(() => closeSheet());
  act(() => openSheet(EDITOR));
  const d = await screen.findByRole("dialog", { name: "New template" });
  expect(await within(d).findByLabelText("Display name")).toHaveValue("Lead");
  release(json(detail("lead"), 201));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(hasDraft("new-template")).toBe(true);
});
