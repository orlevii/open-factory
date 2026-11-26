import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { testRef } from "../test/principals.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness, sendAs } from "./testing/runtime-harness.ts";

// I1 §5.1: raw input is held like a compact, written as one unwrapped user line on its own, and is a barrier until its
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
  h.rt.rawInput({ text: args ? `/${name} ${args}` : `/${name}`, userId, by: "<@or>" });
const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const commandWrites = () => h.driver.last.writes.filter((w) => w.kind === "raw");

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
    kind: "raw",
    body: "/code-review src/",
    from: "<@or>",
    fromKind: "human",
    waitReason: "turn",
  });
  await send("after the command");
  expect(commandWrites()).toEqual([]);
  expect(h.rt.queueItems().map((q) => q.kind)).toEqual(["raw", "message"]);

  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  // The exact raw line, never batched with the message queued behind it.
  expect(commandWrites()).toEqual([{ kind: "raw", text: "/code-review src/" }]);
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["long task"]);
  expect(h.rt.queueItems().map((q) => q.kind)).toEqual(["message"]);
  expect(h.rt.live().status).toBe("working");
  expect((await events()).filter((e) => e.type === "control")).toEqual([]);
  expect((await events()).filter((e) => e.type === "operator_input")).toEqual([
    expect.objectContaining({
      type: "operator_input",
      text: "/code-review src/",
      by: "<@or>",
      byKind: "human",
    }),
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
  expect(commandWrites()).toEqual([{ kind: "raw", text: "/context" }]);
  await send("next");
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["boot"]);
  h.driver.last.emit(
    { type: "command_output", command: "context", text: "## Context" },
    ev.end({ command: "context", numTurns: 0 }),
  );
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["next"]);
});

test("a hibernated agent wakes for it with the reason raw", async () => {
  await run("init");
  expect(h.driver.starts).toHaveLength(1);
  expect(commandWrites()).toEqual([{ kind: "raw", text: "/init" }]);
  expect(await events()).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "raw" }),
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
  expect(cancelled).toMatchObject({ id: item.id, kind: "raw", body: "/code-review src/" });
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
  const a = await h.rt.rawInput({ text: "/init", userId: "u1", by: "<@or>", clientMessageId: id });
  const b = await h.rt.rawInput({ text: "/init", userId: "u1", by: "<@or>", clientMessageId: id });
  expect(b.id).toBe(a.id);
  expect(a.clientMessageId).toBe(id);
  expect(h.rt.queueItems()).toHaveLength(1);
});

test("a passive notice at the head never holds a command back", async () => {
  await startedIdle();
  await h.rt.postNotice("crons_stopped", "stopped");
  await run("init");
  expect(commandWrites()).toEqual([{ kind: "raw", text: "/init" }]);
});

test("a retry with the same clientMessageId after the write returns the earlier item and writes nothing", async () => {
  await startedIdle();
  const id = crypto.randomUUID();
  const dispatch = () =>
    h.rt.rawInput({ text: "/code-review", userId: "u1", by: "<@or>", clientMessageId: id });
  const a = await dispatch();
  expect(commandWrites()).toHaveLength(1);
  const b = await dispatch();
  expect(b.id).toBe(a.id);
  expect(commandWrites()).toHaveLength(1);
  expect(h.rt.queueItems()).toEqual([]);
  // Another sender's same id is their own command.
  await h.rt.rawInput({ text: "/init", userId: "u2", by: "<@sam>", clientMessageId: id });
  expect(h.rt.queueItems().map((q) => q.body)).toEqual(["/init"]);
});

test("two commands back to back: the second waits for the first one's turn_end", async () => {
  await startedIdle();
  await run("code-review", "a/");
  await run("security-review");
  expect(commandWrites().map((w) => w.text)).toEqual(["/code-review a/"]);
  expect(h.rt.queueItems().map((q) => q.body)).toEqual(["/security-review"]);
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  expect(commandWrites().map((w) => w.text)).toEqual(["/code-review a/", "/security-review"]);
});

test("an urgent message during a command's turn interrupts it and goes once that turn ends", async () => {
  await startedIdle();
  await run("code-review");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await sendAs(h.store, h.rt, { fromUserId: "u1", fromHandle: "or", body: "STOP", urgent: true });
  expect(h.driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["boot"]);
  h.driver.last.emit(ev.usage(), ev.end({ terminalReason: "aborted_streaming" }));
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["STOP"]);
});

test("Stop clears a command barrier that never opened a turn (no turn_end will come)", async () => {
  await startedIdle();
  await run("context");
  await send("held behind it");
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["boot"]);
  await h.rt.interrupt({ by: "<@or>" });
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["held behind it"]);
  expect((await events()).filter((e) => e.type === "control").at(-1)).toEqual({
    type: "control",
    cmd: "interrupt",
    by: "<@or>",
  });
  // Nothing in flight and no turn open: Stop is refused again.
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await h.rt.settled();
  await expect(h.rt.interrupt({ by: "<@or>" })).rejects.toMatchObject({
    name: "NoOpenTurnError",
  });
});

test("a turn_end that names compact still ends a command's barrier", async () => {
  await startedIdle();
  await run("code-review");
  await send("next");
  h.driver.last.emit(ev.turn(), ev.usage(), ev.end({ command: "compact" }));
  await h.rt.settled();
  expect(h.driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["next"]);
});

test("a process that can't run commands refuses the dispatch: nothing queued, nothing dropped silently", async () => {
  await startedIdle();
  Reflect.set(h.driver.last, "raw", undefined);
  await expect(run("code-review")).rejects.toMatchObject({ code: "commands_unsupported" });
  expect(h.rt.queueItems()).toEqual([]);
});

test("plain text is written as one user line with no envelope, and operator_input records who and which send", async () => {
  await startedIdle();
  const clientMessageId = crypto.randomUUID();
  const item = await h.rt.rawInput({
    text: "just a note",
    userId: "u1",
    by: "<@or>",
    clientMessageId,
  });
  expect(item).toMatchObject({ kind: "raw", body: "just a note", clientMessageId });
  expect(commandWrites()).toEqual([{ kind: "raw", text: "just a note" }]);
  expect((await events()).filter((e) => e.type === "operator_input")).toEqual([
    {
      type: "operator_input",
      text: "just a note",
      by: "<@or>",
      byKind: "human",
      clientMessageId,
      entryId: item.id,
    },
  ]);
});

test("an errored agent holds raw input and does not start a recovery", async () => {
  await h.makeRuntime({ status: "errored", sessionId: "sess-1" });
  const item = await h.rt.rawInput({ text: "hello", userId: "u1", by: "<@or>" });
  await h.rt.settled();
  expect(h.driver.starts).toHaveLength(0);
  expect(h.rt.acceptsWake("raw")).toBe(false);
  expect(h.rt.queueItems().map((q) => q.id)).toEqual([item.id]);
});

test("subscribers are told once the agent's command list is stored", async () => {
  h.driver.commandList = [{ name: "context", description: "Context", argumentHint: "" }];
  await send("boot");
  await vi.waitFor(async () =>
    expect(await h.store.agentCommands(h.agentId)).toMatchObject({
      commands: [expect.objectContaining({ name: "context" })],
    }),
  );
  await vi.waitFor(() =>
    expect(h.frames).toContainEqual({
      type: "agent_commands_changed",
      agent: testRef(h.rt.agent.id),
    }),
  );
});
