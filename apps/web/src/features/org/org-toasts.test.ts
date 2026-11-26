import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createOrgToasts } from "@/features/org/org-toasts";
import { refFor } from "@/test/refs";

/** The handles the principals cache knows, by ref. */
const HANDLES: Record<string, string> = Object.fromEntries(
  ["hr", "cto", "dev", "a", "b", "c"].map((h) => [refFor(h), h]),
);
const notify = vi.fn();
const navigate = vi.fn();
const toasts = () => createOrgToasts({ notify, navigate, handleOf: (ref) => HANDLES[ref] });

beforeEach(() => {
  vi.useFakeTimers();
  notify.mockReset();
  navigate.mockReset();
});
afterEach(() => vi.useRealTimers());

test("a single frame toasts at 2,000 ms, not before, and Open goes to the agent's chat", () => {
  const t = toasts();
  t.onOrgAction({
    type: "org_action",
    action: "agent_created",
    by: refFor("hr"),
    subject: refFor("dev"),
  });
  vi.advanceTimersByTime(1999);
  expect(notify).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(notify).toHaveBeenCalledTimes(1);
  const n = notify.mock.calls[0]?.[0];
  expect(n.text).toBe("@hr created @dev");
  n.action.run();
  expect(navigate).toHaveBeenCalledWith(`/agents/${refFor("dev")}/chat`);
});

test("three created frames from one actor in the window give one toast to the list", () => {
  const t = toasts();
  for (const subject of ["a", "b", "c"].map(refFor)) {
    t.onOrgAction({ type: "org_action", action: "agent_created", by: refFor("hr"), subject });
    vi.advanceTimersByTime(500);
  }
  // The window is fixed: frames later in it don't extend it.
  vi.advanceTimersByTime(500);
  expect(notify).toHaveBeenCalledTimes(1);
  const n = notify.mock.calls[0]?.[0];
  expect(n.text).toBe("@hr created 3 agents");
  n.action.run();
  expect(navigate).toHaveBeenCalledWith("/agents");
});

test("a template toast opens the template", () => {
  const t = toasts();
  t.onOrgAction({ type: "org_action", action: "template_created", by: refFor("hr"), subject: "x" });
  vi.advanceTimersByTime(2000);
  const n = notify.mock.calls[0]?.[0];
  expect(n.text).toBe("@hr created template x");
  n.action.run();
  expect(navigate).toHaveBeenCalledWith("/templates/x");
});

test("archive and unarchive read as themselves", () => {
  const t = toasts();
  t.onOrgAction({
    type: "org_action",
    action: "agent_archived",
    by: refFor("hr"),
    subject: refFor("dev"),
  });
  t.onOrgAction({
    type: "org_action",
    action: "agent_unarchived",
    by: refFor("hr"),
    subject: refFor("dev"),
  });
  vi.advanceTimersByTime(2000);
  expect(notify.mock.calls.map((c) => c[0].text)).toEqual([
    "@hr archived @dev",
    "@hr unarchived @dev",
  ]);
});

test("two actors give two toasts", () => {
  const t = toasts();
  t.onOrgAction({
    type: "org_action",
    action: "agent_created",
    by: refFor("hr"),
    subject: refFor("a"),
  });
  t.onOrgAction({
    type: "org_action",
    action: "agent_created",
    by: refFor("cto"),
    subject: refFor("b"),
  });
  vi.advanceTimersByTime(2000);
  expect(notify.mock.calls.map((c) => c[0].text)).toEqual(["@hr created @a", "@cto created @b"]);
});

test("a frame after the window opens a new one", () => {
  const t = toasts();
  t.onOrgAction({
    type: "org_action",
    action: "agent_created",
    by: refFor("hr"),
    subject: refFor("a"),
  });
  vi.advanceTimersByTime(2000);
  t.onOrgAction({
    type: "org_action",
    action: "agent_created",
    by: refFor("hr"),
    subject: refFor("b"),
  });
  vi.advanceTimersByTime(2000);
  expect(notify).toHaveBeenCalledTimes(2);
});

test("dispose before the window ends cancels the pending toast", () => {
  const t = toasts();
  t.onOrgAction({
    type: "org_action",
    action: "agent_created",
    by: refFor("hr"),
    subject: refFor("dev"),
  });
  t.dispose();
  vi.advanceTimersByTime(5000);
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("several templates toast with the count and Open goes to the templates list", () => {
  const t = toasts();
  for (const subject of ["a", "b"])
    t.onOrgAction({ type: "org_action", action: "template_created", by: refFor("hr"), subject });
  vi.advanceTimersByTime(2000);
  const n = notify.mock.calls[0]?.[0];
  expect(n.text).toBe("@hr created 2 templates");
  n.action.run();
  expect(navigate).toHaveBeenCalledWith("/templates");
});
