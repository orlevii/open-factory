import type { ServerMessage } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { onRestartFrame, restartAgentNow, useRestartPending } from "@/features/agents/lifecycle";
import { lostWorkBody, RestartConfirmHost } from "@/features/agents/restart-confirm";
import { RestartNowButton } from "@/features/session/restart-now-button";
import { json, mockApi } from "@/test/mock-api";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toaster", () => ({ notify }));

afterEach(() => {
  cleanup();
  notify.mockReset();
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  vi.unstubAllGlobals();
});

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const lostWork = (tasks: string[], crons: string[]) =>
  json(
    {
      error: {
        code: "lost_work",
        message: "Background work would be lost.",
        data: { tasks, crons },
      },
    },
    409,
  );

function Pending({ slug }: { slug: string }) {
  return <p>{useRestartPending(slug) ? `${slug} pending` : `${slug} idle`}</p>;
}

test("lostWorkBody: at most 5 of each, then a count; no crons are left out of the text", () => {
  const tasks = ["a", "b", "c", "d", "e", "f", "g"];
  const body = lostWorkBody("dev", tasks, []);
  expect(body.tasks).toEqual(["a", "b", "c", "d", "e"]);
  expect(body.moreTasks).toBe(2);
  expect(body.crons).toEqual([]);
  expect(body.text).toBe("@dev has 7 background tasks. Restarting stops them.");
  expect(lostWorkBody("dev", ["pnpm test", "vite dev"], ["x"]).text).toBe(
    "@dev has 2 background tasks (pnpm test, vite dev) and 1 cron. Restarting stops them.",
  );
});

test.each([
  ["restarting", "Restarting @dev."],
  ["restart_pending", "Restarts @dev when its task results are in."],
  ["restarted_idle", "@dev restarted; its next start uses the latest config."],
  ["not_running", "@dev isn't running; its next start uses the latest config."],
])("a 202 %s shows no dialog and toasts its text", async (status, text) => {
  mockApi({ "POST /api/agents/dev/restart": () => json({ status }, 202) });
  render(
    <QueryClientProvider client={qc()}>
      <RestartConfirmHost />
    </QueryClientProvider>,
  );
  await restartAgentNow("dev", qc());
  expect(notify).toHaveBeenCalledWith({ text });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("a 409 lost_work opens the confirm even with nothing mounted but the host, and Restart anyway forces", async () => {
  let forced: unknown;
  const api = mockApi({
    "POST /api/agents/dev/restart": (body) => {
      forced = body;
      return (body as { force?: boolean })?.force
        ? json({ status: "restarting" }, 202)
        : lostWork(["pnpm test", "vite dev"], ["every 5 minutes"]);
    },
  });
  render(<RestartConfirmHost />);
  await restartAgentNow("dev", qc());
  const dialog = await screen.findByRole("alertdialog", { name: "Restart @dev now?" });
  expect(dialog).toHaveTextContent(
    "@dev has 2 background tasks (pnpm test, vite dev) and 1 cron. Restarting stops them.",
  );
  expect(within(dialog).getByText("pnpm test")).toBeInTheDocument();
  expect(within(dialog).getByText("every 5 minutes")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Restart anyway" }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(forced).toEqual({ force: true });
  expect(api.calls.filter((c) => c.url === "/api/agents/dev/restart")).toHaveLength(2);
  expect(notify).toHaveBeenCalledWith({ text: "Restarting @dev." });
});

test("the dialog lists at most 5 of each, then 'and N more'", async () => {
  mockApi({
    "POST /api/agents/dev/restart": () =>
      lostWork(["t1", "t2", "t3", "t4", "t5", "t6", "t7"], ["c1"]),
  });
  render(<RestartConfirmHost />);
  await restartAgentNow("dev", qc());
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("t5")).toBeInTheDocument();
  expect(within(dialog).queryByText("t6")).toBeNull();
  expect(within(dialog).getByText("and 2 more")).toBeInTheDocument();
});

test("another failure toasts a message naming the agent", async () => {
  mockApi({
    "POST /api/agents/dev/restart": () =>
      json({ error: { code: "starting", message: "@dev is starting." } }, 409),
  });
  await restartAgentNow("dev", qc());
  expect(notify).toHaveBeenCalledWith({ text: "Couldn't restart @dev: @dev is starting." });
});

test("the pending latch holds after the 202 until a status frame for that slug, shared by every button", async () => {
  mockApi({ "POST /api/agents/dev/restart": () => json({ status: "restarting" }, 202) });
  render(
    <QueryClientProvider client={qc()}>
      <RestartNowButton slug="dev" />
      <RestartNowButton slug="dev" />
      <Pending slug="other" />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getAllByRole("button", { name: "Restart now" })[0] as HTMLElement);
  await vi.waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Restarting…" })).toHaveLength(2),
  );
  const status = (agent: string): ServerMessage => ({
    type: "agent_status",
    agent,
    status: "idle",
    turnOpen: false,
    restartPending: false,
    restartWaitingOn: 0,
    restartChanges: [],
  });
  act(() => onRestartFrame(status("other")));
  expect(screen.getAllByRole("button", { name: "Restarting…" })).toHaveLength(2);
  act(() => onRestartFrame(status("dev")));
  expect(screen.getAllByRole("button", { name: "Restart now" })).toHaveLength(2);
});

test("an error event ends the latch", async () => {
  mockApi({ "POST /api/agents/dev/restart": () => json({ status: "restarting" }, 202) });
  render(
    <QueryClientProvider client={qc()}>
      <RestartNowButton slug="dev" />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Restart now" }));
  await screen.findByRole("button", { name: "Restarting…" });
  act(() =>
    onRestartFrame({
      type: "session_event",
      agent: "dev",
      event: { event: { type: "error", source: "spawn", message: "x" } },
    } as unknown as ServerMessage),
  );
  expect(screen.getByRole("button", { name: "Restart now" })).toBeInTheDocument();
});
