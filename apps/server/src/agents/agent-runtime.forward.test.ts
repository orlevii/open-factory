import { tagOf } from "@open-factory/shared/tags";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { testRef } from "../test/principals.ts";
import { CAP_BYTES } from "./cap.ts";
import { ev } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { deliverHuman, RuntimeHarness } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
const PEER = "peer-fwd";
beforeAll(async () => {
  await h.setup();
  await insertAgent(h.t.sql, { id: PEER, slug: "peerfwd" });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.makeRuntime();
  h.forwarded.length = 0;
});
afterEach(() => vi.useRealTimers());

async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
  h.forwarded.length = 0;
}
const facts = () => h.forwarded.map((f) => f.fact ?? "text");

test("top-level text is forwarded from the report; subagent text, tool calls and blank text are not", async () => {
  await idle();
  h.driver.last.emit(
    ev.turn(),
    ev.text("visible"),
    { type: "assistant_text", text: "nested", parentToolUseId: "t1" },
    { type: "tool_call", toolUseId: "t2", name: "Bash", input: { command: "ls" } },
    ev.text("   "),
    ev.usage(),
    ev.end(),
  );
  await h.rt.settled();
  expect(h.forwarded).toEqual([{ agentId: h.agentId, body: "visible" }]);
});

/** A human's request, written to the report now (into the open turn when one is open). */
async function request(body: string) {
  const row = await h.row(body);
  await deliverHuman(h.rt, row);
  await h.rt.settled();
  return { id: row.id, from: `<@${row.fromRef}>` };
}

/** A top-level tool call and its result: the boundary where Claude reads what was written mid-turn. */
const toolStep = (id: string) => [
  { type: "tool_call", toolUseId: id, name: "Bash", input: { command: "ls" } } as const,
  { type: "tool_result", toolUseId: id, content: "ok", isError: false } as const,
];

test("a forwarded text names the requests the report had read when it wrote it: a mid-turn one after the next tool step", async () => {
  await idle();
  const m1 = await request("fix the login bug");
  h.driver.last.emit(ev.turn(), ev.text("reading the login code"));
  await h.rt.settled();
  const m2 = await request("also update the README");
  h.driver.last.emit(ev.text("still on the login code"), ...toolStep("t1"));
  h.driver.last.emit(ev.text("the login bug is fixed"), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.forwarded).toEqual([
    { agentId: h.agentId, body: "reading the login code", re: [m1] },
    { agentId: h.agentId, body: "still on the login code", re: [m1] },
    { agentId: h.agentId, body: "the login bug is fixed", re: [m1, m2] },
  ]);
});

test("a request written after the turn's last tool step is the next turn's request", async () => {
  await idle();
  const m1 = await request("fix the login bug");
  h.driver.last.emit(ev.turn(), ...toolStep("t1"));
  await h.rt.settled();
  const m2 = await request("also update the README");
  h.driver.last.emit(ev.text("the login bug is fixed"), ev.usage(), ev.end());
  h.driver.last.emit(ev.turn(), ev.text("README updated"), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.forwarded).toEqual([
    { agentId: h.agentId, body: "the login bug is fixed", re: [m1] },
    { agentId: h.agentId, body: "README updated", re: [m2] },
  ]);
});

test("a peer note written with a request is not one of the turn's requests", async () => {
  await idle();
  await h.rt.receive(
    await h.store.createOrgRow({
      kind: "peer_joined",
      toAgentId: h.agentId,
      subjectAgentId: PEER,
      notice: "peer",
      body: "@peerfwd joined as your peer.",
    }),
  );
  const m1 = await request("status?");
  expect(h.driver.last.sent.at(-1)?.map((m) => m.kind)).toEqual(["message", "peer_joined"]);
  h.driver.last.emit(ev.turn(), ev.text("all good"), ev.usage(), ev.end());
  await h.rt.settled();
  expect(h.forwarded).toEqual([{ agentId: h.agentId, body: "all good", re: [m1] }]);
});

test("text over 64 KB is truncated", async () => {
  await idle();
  h.driver.last.emit(ev.turn(), ev.text("x".repeat(CAP_BYTES + 10)), ev.usage(), ev.end());
  await h.rt.settled();
  const body = h.forwarded[0]?.body ?? "";
  expect(body.endsWith("[truncated]")).toBe(true);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(CAP_BYTES);
});

test("errors and denials are factory facts about the report", async () => {
  await idle();
  h.driver.last.emit(
    ev.turn(),
    { type: "error", source: "api", message: "overloaded" },
    {
      type: "permission_denied",
      toolName: "Bash",
      toolUseId: "t9",
      reasonType: "classifier",
      reason: "risky",
    },
    ev.usage(),
    ev.end({ isError: true }),
  );
  await h.rt.settled();
  expect(facts()).toEqual(["turn_failed", "denied"]);
  const me = tagOf(testRef(h.rt.agent.id));
  expect(h.forwarded[1]?.body).toBe(
    `Bash was denied for ${me}. The reason, reported by ${me}:\n> risky`,
  );
});

test("a recoverable crash is crashed, never errored; errored is forwarded once per episode, not per failed attempt", async () => {
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  expect(facts()).toEqual(["crashed"]);
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(facts()).toEqual(["crashed", "errored"]);
  const me = tagOf(testRef(h.rt.agent.id));
  expect(h.forwarded[1]?.body).toBe(
    `${me} is errored and needs a human. Reported by ${me}:\n> Exited unexpectedly (code 1)`,
  );
  // A human message makes one more attempt (S5); its failure is the same episode: nothing new.
  await h.send("are you there");
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(facts()).toEqual(["crashed", "errored"]);
});

test("R4: no errored fact for a crash the automatic attempt recovers; the next episode's errored once, then recovered", async () => {
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  h.driver.last.emit(ev.session(), ev.turn(), ev.end()); // the automatic attempt succeeds
  await h.rt.settled();
  // A new crash whose automatic attempt fails: errored, an episode starts.
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  // A human retry fails inside the same episode; the next one succeeds and ends it.
  await h.send("retry");
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1);
  await h.rt.settled();
  await h.send("retry again");
  h.driver.last.emit(ev.session(), ev.turn(), ev.end());
  await h.rt.settled();
  expect(facts()).toEqual(["crashed", "recovered", "crashed", "errored", "recovered"]);
});

test("a successful attempt forwards recovered; Start a new session forwards recovered", async () => {
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  h.driver.last.emit(ev.session(), ev.turn(), ev.end());
  await h.rt.settled();
  expect(facts()).toEqual(["crashed", "recovered"]);

  await h.makeRuntime({
    status: "errored",
    sessionId: "sess-gone",
    errorKind: "resume_unrecoverable",
  });
  h.forwarded.length = 0;
  await h.rt.resetSession({ by: "<@or>" });
  await h.rt.settled();
  expect(facts()).toEqual(["recovered"]);
});

test("a start failure is errored, once per episode", async () => {
  h.startError = new Error("no credential");
  await h.send("hi").catch(() => {});
  await h.rt.settled();
  expect(facts()).toEqual(["errored"]);
  expect(h.forwarded[0]?.body).toContain(`Reported by ${tagOf(testRef(h.rt.agent.id))}`);
  await h.send("again").catch(() => {}); // a human retry inside the episode
  await h.rt.settled();
  expect(facts()).toEqual(["errored"]);
});

test("a failed forwarding insert stops the report like a failed event write (spec §16)", async () => {
  await idle();
  const p = h.driver.last;
  h.forwardError = new Error("db down");
  p.emit(ev.turn(), ev.text("progress"));
  await h.rt.settled();
  expect(p.stopped).toBe(true);
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "internal" });
});

test("lost background work is forwarded with its descriptions quoted", async () => {
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await h.rt.settled();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(facts()).toContain("work_lost");
  expect(h.forwarded.find((f) => f.fact === "work_lost")?.body).toContain("> pnpm test");
});

test("a recoverable crash whose attempt can't begin (closing) is errored, not crashed", async () => {
  let closing = false;
  await h.makeRuntime({ slots: Object.assign(new RecordingSlots(), { closing: () => closing }) });
  await idle();
  closing = true;
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  expect(facts()).toEqual(["errored"]);
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "crash" });
});

test("a crash recovery whose wake is dropped ends its attempt errored, reported once", async () => {
  let wake: "granted" | "dropped" = "granted";
  await h.makeRuntime({ slots: Object.assign(new RecordingSlots(), { requestWake: () => wake }) });
  await idle();
  wake = "dropped";
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  expect(facts()).toEqual(["crashed", "errored"]);
  expect(h.rt.live().status).toBe("errored");
});

test("a failed errored insert reports nothing, so a later errored path in the episode retries it", async () => {
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(137);
  await h.rt.settled();
  h.forwardError = new Error("db down");
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1); // the automatic attempt fails; its errored insert fails too
  await h.rt.settled();
  expect(facts()).toEqual(["crashed"]);
  h.forwardError = undefined;
  await h.send("are you there");
  h.driver.last.emit(ev.session(), ev.turn());
  h.driver.last.exit(1); // a human retry fails: the episode is reported now, once
  await h.rt.settled();
  expect(facts()).toEqual(["crashed", "errored"]);
});

test("Start a new session still makes its attempt when forwarding recovered fails", async () => {
  await h.makeRuntime({
    status: "errored",
    sessionId: "sess-gone",
    errorKind: "resume_unrecoverable",
    seed: async (id) => {
      await h.store.createMessage({
        from: { userId: "u1" },
        toAgentId: id,
        recipientIds: [id],
        body: "pending",
        urgent: false,
      });
    },
  });
  const starts = h.driver.starts.length;
  h.forwardError = new Error("db down");
  await h.rt.resetSession({ by: "<@or>" });
  await h.rt.settled();
  expect(h.driver.starts.length).toBe(starts + 1);
  expect(h.driver.last.sent.flat().map((m) => m.body)).toContain("pending");
});
