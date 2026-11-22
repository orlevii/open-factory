import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness, sendAs } from "./testing/runtime-harness.ts";

// U3 §13.3 (dispatch), Q39: a slash command is held like a compact, written raw on its own, and is a barrier until its
// turn ends. Its sender may cancel it while it is still queued (no restore).
const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
beforeEach(async () => {
  await h.makeRuntime();
});

const send = (body: string) =>
  sendAs(h.store, h.rt, { fromUserId: "u1", fromHandle: "or", body, urgent: false });
const run = (name: string, args = "", userId = "u1") =>
  h.rt.command({ name, args, userId, byHandle: "or" });
const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const commandWrites = () => h.driver.last.writes.filter((w) => w.kind === "command");

async function startedIdle() {
  await send("boot");
  h.driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
}

test("held while a turn is open, written raw on its own, and nothing is written behind it until its turn ends", async () => {
  await startedIdle();
  await send("long task");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const item = await run("code-review", "src/");
  expect(item).toMatchObject({
    kind: "command",
    body: "/code-review src/",
    from: "@or",
    waitReason: "turn",
  });
  await send("after the command");
  expect(commandWrites()).toEqual([]);
  expect(h.rt.queueItems().map((q) => q.kind)).toEqual(["command", "message"]);

  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  // The exact raw line, never batched with the message queued behind it.
  expect(commandWrites()).toEqual([{ kind: "command", text: "/code-review src/" }]);
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["long task"]);
  expect(h.rt.queueItems().map((q) => q.kind)).toEqual(["message"]);
  expect(h.rt.live().status).toBe("working");
  expect((await events()).filter((e) => e.type === "control")).toEqual([
    { type: "control", cmd: "command", arg: "/code-review src/", by: "@or" },
  ]);

  // A self-started turn ending meanwhile does not release it.
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["long task"]);

  // Its own turn ends: the message goes.
  h.driver.last.emit(ev.turn(), ev.text("review done"), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["after the command"]);
});

test("written at once when idle; a local command's turn_end (no turn_started) releases it", async () => {
  await startedIdle();
  await run("context");
  expect(commandWrites()).toEqual([{ kind: "command", text: "/context" }]);
  await send("next");
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["boot"]);
  h.driver.last.emit(
    { type: "command_output", command: "context", text: "## Context" },
    ev.end({ command: "context", numTurns: 0 }),
  );
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["next"]);
});

test("a hibernated agent wakes for it with the reason command", async () => {
  await run("init");
  expect(h.driver.starts).toHaveLength(1);
  expect(commandWrites()).toEqual([{ kind: "command", text: "/init" }]);
  expect(await events()).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "command" }),
  );
});

test("the process exiting clears it, so later messages are written by the next process", async () => {
  await startedIdle();
  await run("code-review");
  expect(commandWrites()).toHaveLength(1);
  h.driver.last.exit(1);
  await h.rt.settled();
  await send("after the crash");
  await h.rt.settled();
  expect(h.driver.starts.length).toBeGreaterThan(1);
  expect(h.driver.last.sent.flat().map((m) => m.body)).toContain("after the crash");
});

test("your own held command cancels (removed, never written); another user's is not_sender", async () => {
  await startedIdle();
  await send("long task");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const item = await run("code-review", "src/");
  await expect(h.rt.cancelQueued(item.id, "u2")).rejects.toMatchObject({ code: "not_sender" });
  expect(h.rt.queueItems().map((q) => q.id)).toEqual([item.id]);
  const cancelled = await h.rt.cancelQueued(item.id, "u1");
  expect(cancelled).toMatchObject({ id: item.id, kind: "command", body: "/code-review src/" });
  expect(h.rt.queueItems()).toEqual([]);
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(commandWrites()).toEqual([]);
  // No restore: a command id is not a message.
  await expect(h.rt.restoreQueued(item.id, "u1")).rejects.toMatchObject({ code: "not_sender" });
});

test("a written command can't be cancelled: already_delivered for its sender, not_sender for anyone else", async () => {
  await startedIdle();
  const item = await run("context");
  expect(commandWrites()).toHaveLength(1);
  await expect(h.rt.cancelQueued(item.id, "u1")).rejects.toMatchObject({
    code: "already_delivered",
  });
  await expect(h.rt.cancelQueued(item.id, "u2")).rejects.toMatchObject({ code: "not_sender" });
});

test("a retried dispatch with the same clientMessageId is the same queued item", async () => {
  await startedIdle();
  await send("long task");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  const id = crypto.randomUUID();
  const a = await h.rt.command({
    name: "init",
    args: "",
    userId: "u1",
    byHandle: "or",
    clientMessageId: id,
  });
  const b = await h.rt.command({
    name: "init",
    args: "",
    userId: "u1",
    byHandle: "or",
    clientMessageId: id,
  });
  expect(b.id).toBe(a.id);
  expect(a.clientMessageId).toBe(id);
  expect(h.rt.queueItems()).toHaveLength(1);
});

test("a passive notice at the head never holds a command back", async () => {
  await startedIdle();
  await h.rt.postNotice("crons_stopped", "stopped");
  await run("init");
  expect(commandWrites()).toEqual([{ kind: "command", text: "/init" }]);
});
