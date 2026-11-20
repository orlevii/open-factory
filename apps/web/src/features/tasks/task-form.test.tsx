import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const agents = () =>
  json({
    agents: [agentSummary({ slug: "dev", displayName: "Dev" })],
    more: false,
    running: { count: 0, max: 8 },
  });
const summary = (n: number, status = "open") => ({
  key: `T-${n}`,
  title: `Task ${n}`,
  status,
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: "2026-11-19T10:00:00.000Z",
});
const detail = (n: number) => ({
  ...summary(n),
  body: "",
  createdAt: "2026-11-19T10:00:00.000Z",
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
});
const base = {
  "GET /api/agents?": agents,
  "GET /api/tasks?": () => json({ tasks: [], nextCursor: null }),
};

test("validates on leave, not while typing; typing clears the error", async () => {
  mockApi(base);
  renderApp("/tasks/new", alice);
  const title = await screen.findByLabelText("Title");
  await userEvent.click(title);
  await userEvent.tab();
  expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
  await userEvent.type(title, "x");
  expect(screen.queryByText("Enter a title.")).toBeNull();
  await userEvent.clear(title);
  expect(screen.queryByText("Enter a title.")).toBeNull();
  await userEvent.type(title, "a".repeat(201));
  expect(screen.queryByText("Keep the title to 200 characters or fewer.")).toBeNull();
  await userEvent.tab();
  expect(await screen.findByText("Keep the title to 200 characters or fewer.")).toBeInTheDocument();
});

test("submit checks everything again and focuses the first invalid field", async () => {
  const api = mockApi(base);
  renderApp("/tasks/new", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Create task" }));
  expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveFocus();
  expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

test("dependency keys resolve in one request on leave and show as badges; errors use the exact sentences", async () => {
  const api = mockApi({
    ...base,
    "GET /api/tasks?": (_b, url) =>
      json({
        tasks: url.includes("keys=T-41%2CT-44")
          ? [summary(41), summary(44, "done")]
          : [summary(41)],
        nextCursor: null,
      }),
  });
  renderApp("/tasks/new", alice);
  const deps = await screen.findByLabelText("Depends on");
  await userEvent.type(deps, "T-41, T-44");
  await userEvent.tab();
  const list = await screen.findByRole("list", { name: "Resolved dependencies" });
  expect(within(list).getByText("Task 41")).toBeInTheDocument();
  expect(within(list).getByText("Done")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.url.includes("keys="))).toHaveLength(1);
  await userEvent.clear(deps);
  await userEvent.type(deps, "banana");
  await userEvent.tab();
  expect(await screen.findByText("Use task keys, like T-41.")).toBeInTheDocument();
  await userEvent.clear(deps);
  await userEvent.type(deps, "T-99");
  await userEvent.tab();
  expect(await screen.findByText("No task T-99.")).toBeInTheDocument();
});

test("links: add and remove rows; a javascript: target is refused on leave", async () => {
  mockApi(base);
  renderApp("/tasks/new", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Add link" }));
  const target = screen.getByLabelText("Link 1 target");
  await userEvent.type(target, "javascript:alert(1)");
  await userEvent.tab();
  expect(await screen.findByText("Links must be http(s) URLs.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add link" }));
  expect(screen.getByLabelText("Link 2 target")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Remove link 1" }));
  expect(screen.queryByText("Links must be http(s) URLs.")).toBeNull();
  expect(screen.getAllByLabelText(/Link \d target/)).toHaveLength(1);
});

test("creating sends the task and opens it; the button reads Creating… meanwhile", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const api = mockApi({
    ...base,
    "POST /api/tasks": async () => {
      await gate;
      return json({ task: detail(42) }, 201);
    },
    "GET /api/tasks/T-42": () => json(detail(42)),
  });
  const { router } = renderApp("/tasks/new", alice);
  await userEvent.type(await screen.findByLabelText("Title"), "  Plan  ");
  await userEvent.selectOptions(screen.getByLabelText("Assignee"), "@dev · Dev");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();
  release();
  await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/T-42"));
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    title: "Plan",
    body: "",
    assignee: "dev",
    dependsOn: [],
    links: [],
  });
});

test("a server field error lands under its field; another failure is one alert line", async () => {
  let n = 0;
  mockApi({
    ...base,
    "POST /api/tasks": () =>
      ++n === 1
        ? json(
            {
              error: {
                code: "validation_error",
                message: "x",
                fields: { dependsOn: "T-2 already depends on T-1; that would make a cycle." },
              },
            },
            400,
          )
        : json({ error: { code: "internal_error", message: "Internal error" } }, 500),
  });
  renderApp("/tasks/new", alice);
  await userEvent.type(await screen.findByLabelText("Title"), "Plan");
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(
    await screen.findByText("T-2 already depends on T-1; that would make a cycle."),
  ).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Depends on")).toHaveFocus());
  await userEvent.click(screen.getByRole("button", { name: "Create task" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't create the task. Try again.",
  );
});

test("Cancel goes back to the list without a dialog", async () => {
  mockApi(base);
  const { router } = renderApp("/tasks/new", alice);
  await userEvent.click(await screen.findByRole("link", { name: "Cancel" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/tasks"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
