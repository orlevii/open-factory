import type { FactorySettingsDto, ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { factorySettingsQueryOptions } from "@/features/settings/api";
import type { WsOptions } from "@/lib/ws";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const h = vi.hoisted(() => ({ opts: undefined as WsOptions | undefined }));
vi.mock("@/lib/ws", () => ({
  connectWs: (opts: WsOptions) => {
    h.opts = opts;
    return { close() {}, status: () => "open", send: () => true };
  },
}));

beforeEach(() => {
  h.opts = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const frame = (m: ServerMessage) => act(() => h.opts?.onMessage?.(m));

const settings = (o: Partial<FactorySettingsDto> = {}): FactorySettingsDto => ({
  maxRunningAgents: 8,
  defaultWarmWindowMinutes: 70,
  memberUpdateDebounceSeconds: 30,
  allowLocalRuntime: false,
  updatedAt: null,
  updatedBy: null,
  ...o,
});

/** `state.settings` is live: the PATCH handler changes it, and a refetch sees it. */
function world(extra: Record<string, Handler> = {}, initial = settings()) {
  const state = { settings: initial };
  const api = mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/secrets": () => json({ secrets: [] }),
    "GET /api/projects": () => json({ projects: [] }),
    "GET /api/users": () => json({ users: [] }),
    "GET /api/invites": () => json({ invites: [] }),
    "GET /api/usage/daily?": () => json({ timezone: "Europe/Berlin", days: [] }),
    "GET /api/usage/agents?": () => json({ agents: [] }),
    "GET /api/usage/credentials?": () =>
      json({
        credentials: [],
        unattributed: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          turns: 0,
        },
      }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 2, max: 8 } }),
    "GET /api/settings/factory": () => json(state.settings),
    "PATCH /api/settings/factory": (body) => {
      state.settings = { ...state.settings, ...(body as Partial<FactorySettingsDto>) };
      return json(state.settings);
    },
    ...extra,
  });
  return { api, state };
}

const factory = () => screen.findByRole("region", { name: "Factory" });
const field = async (label: string) =>
  within(await factory()).findByLabelText<HTMLInputElement>(label);

const CAP_HINT =
  "Agents that can run at once (1–64). Lowering it never interrupts a turn; idle agents may hibernate sooner.";
const WARM_HINT =
  "How long an idle agent stays running before it hibernates (1–1440 min). Templates can set their own with warm_window_minutes. Agents created before this change keep 70 min until re-synced.";
const DEBOUNCE_HINT =
  "How long to collect status changes from an agent's reports before telling it (0–86400 s). 0 sends each change at once.";

test("the three fields carry their hints and suffixes, with the loaded values", async () => {
  world();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  const warm = await field("Default warm window");
  const debounce = await field("Member-update debounce");
  await waitFor(() => expect(cap).toHaveValue(8));
  expect(warm).toHaveValue(70);
  expect(debounce).toHaveValue(30);
  expect(cap).toHaveAccessibleDescription(CAP_HINT);
  // The warm-window hint always carries the re-sync sentence (spec §12.4).
  expect(warm).toHaveAccessibleDescription(WARM_HINT);
  expect(debounce).toHaveAccessibleDescription(DEBOUNCE_HINT);
  const region = await factory();
  expect(within(region).getByText("min")).toBeInTheDocument();
  expect(within(region).getByText("s")).toBeInTheDocument();
});

test("the running count is live from the supervisor frame", async () => {
  world();
  renderApp("/settings/factory", alice);
  const region = await factory();
  expect(await within(region).findByText("2 of 8 running")).toBeInTheDocument();
  await frame({ type: "supervisor", running: 3, max: 8 });
  expect(await within(region).findByText("3 of 8 running")).toBeInTheDocument();
});

test("the local runtime row is read-only with how to change it", async () => {
  world();
  renderApp("/settings/factory", alice);
  const region = await factory();
  expect(await within(region).findByText("Local runtime: Not allowed")).toBeInTheDocument();
  expect(
    within(region).getByText(
      (_, el) =>
        el?.tagName === "P" &&
        el.textContent ===
          "Set FACTORY_ALLOW_LOCAL_RUNTIME on the server and restart to change it.",
    ),
  ).toBeInTheDocument();
});

test("allowed local runtime reads Allowed", async () => {
  world({}, settings({ allowLocalRuntime: true }));
  renderApp("/settings/factory", alice);
  expect(await within(await factory()).findByText("Local runtime: Allowed")).toBeInTheDocument();
});

test("blur validates the cap; editing clears the error", async () => {
  world();
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  await waitFor(() => expect(cap).toHaveValue(8));
  await user.clear(cap);
  await user.type(cap, "0");
  // Never while typing.
  expect(screen.queryByText("Enter a whole number from 1 to 64.")).not.toBeInTheDocument();
  await user.tab();
  expect(cap).toHaveAccessibleDescription("Enter a whole number from 1 to 64.");
  expect(cap).toHaveAttribute("aria-invalid", "true");
  await user.type(cap, "5");
  expect(cap).toHaveAccessibleDescription(CAP_HINT);
});

test("Save validates first and focuses the invalid field without sending", async () => {
  const { api } = world();
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const debounce = await field("Member-update debounce");
  await waitFor(() => expect(debounce).toHaveValue(30));
  await user.clear(debounce);
  await user.type(debounce, "90000");
  await user.click(within(await factory()).getByRole("button", { name: "Save" }));
  expect(debounce).toHaveAccessibleDescription("Enter a whole number from 0 to 86400.");
  expect(debounce).toHaveFocus();
  expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("Save sends only the changed fields and shows Saved.", async () => {
  const { api } = world();
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const warm = await field("Default warm window");
  await waitFor(() => expect(warm).toHaveValue(70));
  await user.clear(warm);
  await user.type(warm, "120");
  const region = await factory();
  await user.click(within(region).getByRole("button", { name: "Save" }));
  const saved = await within(region).findByText("Saved.");
  // The line sits above Save, nothing beside it.
  const save = within(region).getByRole("button", { name: "Save" });
  expect(saved.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(api.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
    { defaultWarmWindowMinutes: 120 },
  ]);
  expect(warm).toHaveValue(120);
  // Our own save's frame is not a conflict.
  await frame({ type: "settings_changed" });
  await waitFor(() =>
    expect(api.calls.filter((c) => c.url === "/api/settings/factory").length).toBeGreaterThan(2),
  );
  expect(screen.queryByText("These settings were changed elsewhere.")).not.toBeInTheDocument();
  // Editing again clears the outcome.
  await user.type(warm, "1");
  expect(within(region).queryByText("Saved.")).not.toBeInTheDocument();
});

test("blur on an unchanged number field shows nothing", async () => {
  world();
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  await waitFor(() => expect(cap).toHaveValue(8));
  await user.click(cap);
  await user.tab();
  expect(cap).toHaveAccessibleDescription(CAP_HINT);
});

test("a failed save says so in an alert", async () => {
  world({
    "PATCH /api/settings/factory": () => json({ error: { code: "boom", message: "x" } }, 500),
  });
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const warm = await field("Default warm window");
  await waitFor(() => expect(warm).toHaveValue(70));
  await user.clear(warm);
  await user.type(warm, "120");
  const region = await factory();
  await user.click(within(region).getByRole("button", { name: "Save" }));
  expect(await within(region).findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
});

test("a server 400 maps to its field", async () => {
  world({
    "PATCH /api/settings/factory": () =>
      json(
        {
          error: {
            code: "invalid_settings",
            message: "Enter a whole number from 1 to 64.",
            fields: { maxRunningAgents: "Enter a whole number from 1 to 64." },
          },
        },
        400,
      ),
  });
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  await waitFor(() => expect(cap).toHaveValue(8));
  await user.clear(cap);
  await user.type(cap, "12");
  await user.click(within(await factory()).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(cap).toHaveAccessibleDescription("Enter a whole number from 1 to 64."),
  );
  await waitFor(() => expect(cap).toHaveFocus());
});

test("a settings_changed frame while dirty shows the conflict notice; Reload takes the new values", async () => {
  const { state } = world();
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  await waitFor(() => expect(cap).toHaveValue(8));
  await user.clear(cap);
  await user.type(cap, "10");
  state.settings = settings({ maxRunningAgents: 12, defaultWarmWindowMinutes: 90 });
  await frame({ type: "settings_changed" });
  const region = await factory();
  expect(
    await within(region).findByText("These settings were changed elsewhere."),
  ).toBeInTheDocument();
  // The edit is kept until Reload.
  expect(cap).toHaveValue(10);
  await user.click(within(region).getByRole("button", { name: "Reload" }));
  expect(cap).toHaveValue(12);
  expect(await field("Default warm window")).toHaveValue(90);
  expect(screen.queryByText("These settings were changed elsewhere.")).not.toBeInTheDocument();
});

test("our own save's echo arriving before the PATCH resolves is no conflict", async () => {
  let release: () => void = () => {};
  const { state, api } = world({
    "PATCH /api/settings/factory": async (body) => {
      // The server commits and publishes settings_changed before it answers.
      state.settings = { ...state.settings, ...(body as Partial<FactorySettingsDto>) };
      await new Promise<void>((r) => {
        release = r;
      });
      return json(state.settings);
    },
  });
  const user = userEvent.setup();
  const { queryClient } = renderApp("/settings/factory", alice);
  const warm = await field("Default warm window");
  await waitFor(() => expect(warm).toHaveValue(70));
  await user.clear(warm);
  await user.type(warm, "120");
  const region = await factory();
  // The notice must never render, not even for one frame.
  let flashed = false;
  const watch = new MutationObserver(() => {
    if (document.body.textContent?.includes("These settings were changed elsewhere."))
      flashed = true;
  });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  await user.click(within(region).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
  await frame({ type: "settings_changed" });
  // The refetch lands (with our saved values) while the PATCH is still pending.
  await waitFor(() =>
    expect(queryClient.getQueryData(factorySettingsQueryOptions.queryKey)).toMatchObject({
      defaultWarmWindowMinutes: 120,
    }),
  );
  await act(async () => release());
  expect(await within(region).findByText("Saved.")).toBeInTheDocument();
  watch.disconnect();
  expect(flashed).toBe(false);
  expect(screen.queryByText("These settings were changed elsewhere.")).not.toBeInTheDocument();
});

test("the conflict notice clears when the server goes back to the loaded values", async () => {
  const { state } = world();
  const user = userEvent.setup();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  await waitFor(() => expect(cap).toHaveValue(8));
  await user.clear(cap);
  await user.type(cap, "10");
  state.settings = settings({ maxRunningAgents: 12 });
  await frame({ type: "settings_changed" });
  const region = await factory();
  expect(
    await within(region).findByText("These settings were changed elsewhere."),
  ).toBeInTheDocument();
  state.settings = settings();
  await frame({ type: "settings_changed" });
  await waitFor(() =>
    expect(
      within(region).queryByText("These settings were changed elsewhere."),
    ).not.toBeInTheDocument(),
  );
  expect(cap).toHaveValue(10);
});

test("a settings_changed frame on a clean form just takes the new values", async () => {
  const { state } = world();
  renderApp("/settings/factory", alice);
  const cap = await field("Concurrency cap");
  await waitFor(() => expect(cap).toHaveValue(8));
  state.settings = settings({ maxRunningAgents: 4 });
  await frame({ type: "settings_changed" });
  await waitFor(() => expect(cap).toHaveValue(4));
  expect(screen.queryByText("These settings were changed elsewhere.")).not.toBeInTheDocument();
});

test("a failing load shows Couldn't load factory settings. with Retry", async () => {
  world({
    "GET /api/settings/factory": () => json({ error: { code: "boom", message: "x" } }, 500),
  });
  renderApp("/settings/factory", alice);
  expect(
    await within(await factory()).findByText("Couldn't load factory settings."),
  ).toBeInTheDocument();
  expect(within(await factory()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
