import type { AgentSummary } from "@open-factory/shared";
import { agentSummarySchema } from "@open-factory/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LiveLine, liveFact } from "./live-line";

const now = new Date(2026, 10, 21, 15, 0);
const at = (h: number, m: number, dayOffset = 0) =>
  new Date(2026, 10, 21 + dayOffset, h, m).toISOString();

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return agentSummarySchema.parse({
    slug: "dev",
    displayName: "Dev",
    description: "",
    status: "idle",
    turnOpen: false,
    runtime: "local",
    kind: "persistent",
    template: "dev",
    reportsTo: null,
    credential: null,
    projects: [],
    grantsOverridden: false,
    depth: 0,
    archivedAt: null,
    restartPending: false,
    restartWaitingOn: 0,
    ...over,
  });
}

const ctx = { slotsMax: 8, now };
const terminated = {
  status: "terminated" as const,
  terminatedAt: at(14, 32),
  terminatedBy: "lead",
};

describe("liveFact priority", () => {
  test("terminated beats errored", () => {
    const f = liveFact(agent({ ...terminated, lastError: "boom", errorKind: "crash" }), ctx);
    expect(f?.kind).toBe("terminated");
  });

  test("errored beats pulling and a pending restart; the first line shows, the full text is the title", () => {
    const f = liveFact(
      agent({
        status: "errored",
        lastError: "It broke\nstack trace here",
        errorKind: "crash",
        pulling: true,
        restartPending: true,
      }),
      ctx,
    );
    expect(f).toMatchObject({
      kind: "errored",
      text: "It broke",
      title: "It broke\nstack trace here",
    });
  });

  test("the first non-empty line of the error shows", () => {
    expect(
      liveFact(agent({ status: "errored", lastError: "\n  \n  Real one \nmore" }), ctx)?.text,
    ).toBe("Real one");
  });

  test("rate-limited alone has no fact: the badge says it", () => {
    expect(
      liveFact(agent({ status: "rate_limited", rateLimitedUntil: at(15, 30) }), ctx),
    ).toBeNull();
  });

  test("queued with every slot taken", () => {
    expect(liveFact(agent({ status: "queued" }), ctx)).toMatchObject({
      kind: "queued",
      text: "All 8 slots are in use.",
    });
    expect(liveFact(agent({ status: "queued" }), { ...ctx, slotsMax: 1 })?.text).toBe(
      "The only slot is in use.",
    );
  });

  test("queued while the cap is unknown says nothing", () => {
    expect(liveFact(agent({ status: "queued" }), { now })).toBeNull();
  });

  test("restart pending", () => {
    expect(liveFact(agent({ restartPending: true }), ctx)).toMatchObject({
      kind: "restart",
      text: "Restarts when idle",
    });
  });

  test("waiting on tasks: the first one, with +N for the rest", () => {
    const task = (id: string, d: string, h: number, m: number) => ({
      taskId: id,
      description: d,
      startedAt: at(h, m),
    });
    const f = liveFact(
      agent({
        status: "working",
        waitingOn: {
          tasks: [task("1", "pnpm test", 14, 2), task("2", "pnpm build", 14, 5)],
          crons: 0,
        },
      }),
      ctx,
    );
    expect(f).toMatchObject({ kind: "waiting", text: "pnpm test · since 14:02 +1" });
    expect(
      liveFact(agent({ waitingOn: { tasks: [task("1", "pnpm test", 14, 2)], crons: 0 } }), ctx)
        ?.text,
    ).toBe("pnpm test · since 14:02");
  });

  test("crons keep it awake", () => {
    expect(liveFact(agent({ waitingOn: { tasks: [], crons: 2 } }), ctx)).toMatchObject({
      kind: "crons",
      text: "Kept awake by 2 crons",
    });
    expect(liveFact(agent({ waitingOn: { tasks: [], crons: 1 } }), ctx)?.text).toBe(
      "Kept awake by 1 cron",
    );
  });

  test("tasks come before crons; restart before tasks", () => {
    const waitingOn = {
      tasks: [{ taskId: "1", description: "x", startedAt: at(14, 2) }],
      crons: 2,
    };
    expect(liveFact(agent({ waitingOn }), ctx)?.kind).toBe("waiting");
    expect(liveFact(agent({ waitingOn, restartPending: true }), ctx)?.kind).toBe("restart");
  });

  test("idle has no fact", () => {
    expect(liveFact(agent(), ctx)).toBeNull();
  });
});

describe("terminated wording", () => {
  test("by an agent, with the deletion day", () => {
    const f = liveFact(agent({ ...terminated, workspaceGraceEndsAt: at(21, 53, 2) }), ctx);
    expect(f?.text).toMatch(/^Terminated by @lead · 14:32 · deletes \w{3} 21:53$/);
  });
  test("pinned and deleted workspaces", () => {
    expect(liveFact(agent({ ...terminated, workspacePinned: true }), ctx)?.text).toBe(
      "Terminated by @lead · 14:32 · workspace pinned",
    );
    expect(liveFact(agent({ ...terminated, workspaceDeletedAt: at(14, 40) }), ctx)?.text).toBe(
      "Terminated by @lead · 14:32 · workspace deleted",
    );
  });
  test("by the inactivity TTL", () => {
    expect(liveFact(agent({ ...terminated, terminatedBy: "@factory" }), ctx)?.text).toMatch(
      /^Terminated after 3 days without activity · 14:32/,
    );
  });
});

test("times are absolute: never 'ago' or seconds", () => {
  const facts = [
    liveFact(agent({ ...terminated, workspaceGraceEndsAt: at(21, 53, 2) }), ctx),
    liveFact(
      agent({
        waitingOn: { tasks: [{ taskId: "1", description: "x", startedAt: at(14, 2) }], crons: 0 },
      }),
      ctx,
    ),
  ];
  for (const f of facts) {
    expect(f?.text).not.toMatch(/ago|\d+\s?s\b|:\d\d:\d\d/);
  }
});

describe("LiveLine", () => {
  test("shows the fact in a status region, with its title", () => {
    render(<LiveLine fact={{ kind: "errored", text: "It broke", title: "It broke\nmore" }} />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("It broke");
    expect(el).toHaveAttribute("title", "It broke\nmore");
  });

  test("no fact: an empty status region that takes no room", () => {
    render(<LiveLine fact={null} />);
    const el = screen.getByRole("status", { hidden: true });
    expect(el).toBeEmptyDOMElement();
    expect(el).toHaveClass("hidden");
  });
});
