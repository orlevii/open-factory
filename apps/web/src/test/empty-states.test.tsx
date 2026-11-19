import { screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

test.each([
  ["/inbox", "Inbox", "Nothing in your inbox."],
  ["/tasks", "Tasks", "No tasks yet."],
  ["/schedules", "Schedules", "No schedules yet."],
  ["/settings", "Settings", "Nothing to configure yet."],
])("%s shows its heading and empty line", async (path, title, text) => {
  renderApp(path, alice);
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
});

test("the dashboard shows the Inbox and Agents panels, each empty", async () => {
  renderApp("/", alice);
  expect(await screen.findByText("Nothing in your inbox.")).toBeInTheDocument();
  expect(screen.getByText("No agents yet.")).toBeInTheDocument();
});

test("the sidebar links every section in order", async () => {
  renderApp("/", alice);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  const labels = within(nav)
    .getAllByRole("link")
    .map((a) => a.textContent);
  expect(labels).toEqual(["Inbox", "Agents", "Tasks", "Templates", "Schedules", "Settings"]);
});
