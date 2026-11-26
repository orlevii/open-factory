import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { resetDrafts } from "@/features/sheets/drafts";
import { closeSheet, getSheetState, openSheet } from "@/features/sheets/sheet-store";
import { mockWorld } from "@/test/agent-screens-fixtures";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
vi.mock("@/components/ui/toaster", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toaster")>()),
  notify: vi.fn(),
}));

beforeEach(() => {
  fakeMatchMedia.install(false);
  resetDrafts();
  vi.mocked(notify).mockClear();
});
afterEach(() => {
  act(() => closeSheet());
  vi.unstubAllGlobals();
});

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const principal = (handle: string, kind: "agent" | "human" = "agent") => ({
  id: refFor(handle),
  ref: refFor(handle),
  kind,
  handle,
  name: handle,
  state: "live" as const,
  avatar: null,
});
const patchesMe = (api: { calls: { method: string; url: string; body: unknown }[] }) =>
  api.calls.filter((c) => c.method === "PATCH" && c.url === "/api/me").map((c) => c.body);

async function open(extra: Record<string, () => Response> = {}) {
  const api = mockWorld({
    agents: [agentSummary({ handle: "dev" })],
    extra: {
      "GET /api/principals": () =>
        json({ principals: [principal("alice", "human"), principal("dev")] }),
      "PATCH /api/me": () => json({ ...alice.user, name: "Alice L", handle: "ally" }),
      ...extra,
    },
  });
  renderApp("/agents", alice);
  await screen.findByRole("heading", { level: 1, name: "Agents" });
  act(() => openSheet({ kind: "edit-profile" }));
  await screen.findByRole("dialog", { name: "Edit profile" });
  await vi.waitFor(() => expect(field("Name")).toBeEnabled());
  return api;
}
const type = async (label: string, value: string) => {
  await userEvent.clear(field(label));
  await userEvent.type(field(label), value);
};
const save = () => userEvent.click(screen.getByRole("button", { name: "Save changes" }));

test("Edit profile saves a new name and handle, closes, and toasts the rename", async () => {
  const api = await open();
  expect(field("Name")).toHaveValue("Alice");
  expect(field("Handle")).toHaveValue("alice");
  await type("Name", "Alice L");
  await type("Handle", "ally");
  await save();
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patchesMe(api)).toEqual([{ name: "Alice L", handle: "ally" }]);
  expect(vi.mocked(notify).mock.calls.at(-1)?.[0].text).toBe("@alice is now @ally");
});

test("a name-only save sends only the name and toasts no rename", async () => {
  const api = await open();
  await type("Name", "Alice L");
  await save();
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  expect(patchesMe(api)).toEqual([{ name: "Alice L" }]);
  expect(vi.mocked(notify).mock.calls.at(-1)?.[0].undo).toBeUndefined();
});

test("a taken handle shows 'Another agent or person has this handle' on blur, and sends nothing", async () => {
  const api = await open();
  await type("Handle", "dev");
  await userEvent.click(field("Name"));
  expect(await screen.findByText("Another agent or person has this handle")).toBeInTheDocument();
  await save();
  expect(patchesMe(api)).toEqual([]);
});

test("a reserved handle shows 'Reserved for the factory' on blur", async () => {
  await open();
  await type("Handle", "factory");
  await userEvent.click(field("Name"));
  expect(await screen.findByText("Reserved for the factory")).toBeInTheDocument();
});

test("Undo on the rename toast restores the old handle", async () => {
  const api = await open();
  await type("Handle", "ally");
  await save();
  await waitFor(() => expect(getSheetState().parent).toBeUndefined());
  await vi.mocked(notify).mock.calls.at(-1)?.[0].undo?.();
  expect(patchesMe(api)).toEqual([{ handle: "ally" }, { handle: "alice" }]);
});
