import { expect, test } from "vitest";
import { clientMessageSchema, serverMessageSchema } from "./ws.ts";

test("parses client ping and rejects unknown types", () => {
  expect(clientMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
  expect(clientMessageSchema.safeParse({ type: "subscribe", topic: "x" }).success).toBe(false);
});

test("parses server messages", () => {
  expect(serverMessageSchema.parse({ type: "hello", userId: "u1" }).type).toBe("hello");
  expect(serverMessageSchema.parse({ type: "pong" }).type).toBe("pong");
  expect(serverMessageSchema.parse({ type: "error", code: "bad_message", message: "x" }).type).toBe(
    "error",
  );
});

test("subscribe frames and new server frames parse", () => {
  expect(clientMessageSchema.parse({ type: "subscribe", agent: "dev", afterSeq: 0 })).toEqual({
    type: "subscribe",
    agent: "dev",
    afterSeq: 0,
  });
  expect(
    clientMessageSchema.safeParse({ type: "subscribe", agent: "dev", afterSeq: -1 }).success,
  ).toBe(false);
  expect(
    serverMessageSchema.parse({
      type: "agent_status",
      agent: "dev",
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
      restartChanges: [],
    }).type,
  ).toBe("agent_status");
  expect(serverMessageSchema.parse({ type: "resync", agent: "dev" }).type).toBe("resync");
  expect(serverMessageSchema.parse({ type: "queue", agent: "dev", items: [] }).type).toBe("queue");
});

test("S10 frames parse", () => {
  for (const f of [
    { type: "settings_changed" },
    { type: "users_changed" },
    { type: "images_changed" },
    { type: "image_build", name: "pw", state: "building" },
    { type: "image_build", name: "pw", state: "failed", lines: ["x"] },
  ])
    expect(serverMessageSchema.parse(f).type).toBe(f.type);
});

test("live_snapshot client message parses", () => {
  expect(clientMessageSchema.parse({ type: "live_snapshot", agent: "dev" })).toEqual({
    type: "live_snapshot",
    agent: "dev",
  });
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

test("I2 config_changed frames parse with an agent, a template, and no other field", () => {
  for (const f of [
    { type: "config_changed", agent: "ana" },
    { type: "config_changed", template: "dev" },
  ])
    expect(serverMessageSchema.parse(f)).toEqual(f);
  // Names only: a frame never carries the change lines (they hold config names), the zod object strips extras.
  expect(
    serverMessageSchema.parse({ type: "config_changed", agent: "ana", changes: ["env X changed"] }),
  ).toEqual({ type: "config_changed", agent: "ana" });
});

test("library_changed is a server frame; unknown frame types are refused", () => {
  expect(serverMessageSchema.parse({ type: "library_changed" }).type).toBe("library_changed");
  expect(serverMessageSchema.safeParse({ type: "library_renamed" }).success).toBe(false);
});

test("library_changed carries the repo of a failed background add, and nothing else", () => {
  expect(
    serverMessageSchema.parse({ type: "library_changed", addFailed: "acme/x", extra: 1 }),
  ).toEqual({ type: "library_changed", addFailed: "acme/x" });
});
