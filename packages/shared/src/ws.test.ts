import { expect, test } from "vitest";
import { clientMessageSchema, serverMessageSchema } from "./ws.ts";

test("a subscribe client frame is refused", () => {
  expect(clientMessageSchema.safeParse({ type: "subscribe", topic: "x" }).success).toBe(false);
});

test("a subscribe with a negative afterSeq and a live_snapshot without an agent are refused", () => {
  expect(
    clientMessageSchema.safeParse({ type: "subscribe", agent: "dev", afterSeq: -1 }).success,
  ).toBe(false);
  expect(clientMessageSchema.safeParse({ type: "live_snapshot" }).success).toBe(false);
});

test("live frame: absent means unchanged, null means cleared", () => {
  const minimal = serverMessageSchema.parse({ type: "live", agent: "dev" });
  expect(minimal).toEqual({ type: "live", agent: "dev" });
  expect("toolInput" in minimal).toBe(false);
  expect("thinking" in minimal).toBe(false);

  const cleared = serverMessageSchema.parse({
    type: "live",
    agent: "dev",
    toolInput: null,
    thinking: null,
  });
  expect(cleared).toEqual({ type: "live", agent: "dev", toolInput: null, thinking: null });

  const full = {
    type: "live",
    agent: "dev",
    texts: [{ messageId: "msg_1", index: 1, offset: 0, append: "Hel", capped: false }],
    retire: ["msg_0:0"],
    toolInput: { toolUseId: "t1", name: "Write", bytes: 120, target: "a.md" },
    thinking: { tokens: 40 },
    subagents: [
      {
        toolUseId: "t2",
        description: "Look around",
        subagentType: "Explore",
        toolUses: 4,
        tokens: 23000,
        durationMs: 9000,
        lastTool: "Read",
      },
    ],
    reset: true,
  };
  expect(serverMessageSchema.parse(full)).toEqual(full);
});

test("live frame rejects bad shapes", () => {
  const bad = [
    { type: "live", agent: "dev", reset: false },
    { type: "live", agent: "dev", texts: [{ messageId: "m", index: 0.5, offset: 0, append: "" }] },
    { type: "live", agent: "dev", texts: [{ messageId: "m", index: 0, offset: 1.5, append: "" }] },
    { type: "live", agent: "dev", texts: [{ messageId: "m", index: -1, offset: 0, append: "" }] },
    { type: "live", agent: "dev", texts: [{ messageId: "m", index: 0, offset: -1, append: "" }] },
    { type: "live", agent: "dev", texts: null },
    { type: "live", agent: "dev", subagents: [{ toolUseId: "t" }] },
  ];
  for (const f of bad) expect(serverMessageSchema.safeParse(f).success).toBe(false);
});

test("a config_changed frame carries names only", () => {
  // Names only: a frame never carries the change lines (they hold config names), the zod object strips extras.
  expect(
    serverMessageSchema.parse({ type: "config_changed", agent: "ana", changes: ["env X changed"] }),
  ).toEqual({ type: "config_changed", agent: "ana" });
});

test("unknown frame types are refused", () => {
  expect(serverMessageSchema.safeParse({ type: "library_renamed" }).success).toBe(false);
});

test("library_changed carries the repo of a failed background add, and nothing else", () => {
  expect(
    serverMessageSchema.parse({ type: "library_changed", addFailed: "acme/x", extra: 1 }),
  ).toEqual({ type: "library_changed", addFailed: "acme/x" });
});

test("org_action frames parse for the four actions and reject anything else", () => {
  for (const action of ["agent_created", "agent_archived", "agent_unarchived", "template_created"])
    expect(
      serverMessageSchema.parse({ type: "org_action", action, by: "@hr", subject: "dev" }),
    ).toEqual({ type: "org_action", action, by: "@hr", subject: "dev" });
  expect(
    serverMessageSchema.safeParse({
      type: "org_action",
      action: "agent_moved",
      by: "@hr",
      subject: "dev",
    }).success,
  ).toBe(false);
  expect(
    serverMessageSchema.safeParse({ type: "org_action", action: "agent_created", subject: "dev" })
      .success,
  ).toBe(false);
});
