import { MAX_BODY_BYTES, MAX_FOCUS_CHARS } from "@open-factory/shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

// U3 §13.3 (dispatch), Q39: POST /api/agents/:slug/commands and the command entries of DELETE /queue/:id.
describe("U3 §13.3: dispatch, hold and cancel a slash command", () => {
  let s: Awaited<ReturnType<typeof makeTestApp>>;
  const drv = new FakeDriver();
  let or: { cookie: string };
  let sam: { cookie: string };
  const list = [
    { name: "research", description: "Research (project)", argumentHint: "[topic]" },
    // A skill alias naming a refused built-in never resolves (the allowlist drops it).
    { name: "triage", description: "Triage (project)", argumentHint: "", aliases: ["model"] },
    { name: "code-review", description: "Review", argumentHint: "", builtin: true },
    {
      name: "usage",
      description: "Cost",
      argumentHint: "",
      builtin: true,
      aliases: ["cost", "stats"],
    },
    { name: "compact", description: "Compact", argumentHint: "", builtin: true },
    { name: "clear", description: "Clear", argumentHint: "", builtin: true },
    { name: "model", description: "Model", argumentHint: "", builtin: true },
    { name: "batch", description: "Batch", argumentHint: "", builtin: true },
  ];
  beforeAll(async () => {
    s = await makeTestApp({ harnessDriver: drv });
    await s.seedAgent();
    or = { cookie: (await s.signUpUser({ handle: "orc" })).cookie };
    sam = { cookie: (await s.signUpUser({ handle: "samc" })).cookie };
    drv.commandList = list;
    // Start the agent and leave a turn open, so dispatched commands are held.
    await call(or, "POST", "/api/agents/dev/messages", { body: "work", urgent: false });
    drv.last.emit(ev.session(), ev.turn());
    await settled();
    // The list is stored after the start, off the job queue.
    for (let i = 0; i < 100; i++) {
      if ((await call(or, "GET", "/api/agents/dev/commands")).json().source === "session") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterAll(() => s.close());

  const call = (
    who: { cookie: string } | undefined,
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    s.app.inject({
      method,
      url,
      headers: { ...(who ? { cookie: who.cookie } : {}), ...headers },
      ...(payload ? { payload } : {}),
    });
  const settled = async () => (await s.app.runtimes.bySlug("dev"))?.settled();
  const dispatch = (payload: object, who: { cookie: string } | undefined = or) =>
    call(who, "POST", "/api/agents/dev/commands", payload);
  const queue = async () => (await call(or, "GET", "/api/agents/dev")).json().queue;
  const commandWrites = () => drv.last.writes.filter((w) => w.kind === "command");

  test("humans only: signed out and an agent's own token are refused, and nothing is queued", async () => {
    const signedOut = await call(undefined, "POST", "/api/agents/dev/commands", {
      name: "code-review",
    });
    expect(signedOut.statusCode).toBe(401);
    const token = drv.last.spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
    expect(token).toBeTruthy();
    const res = await call(
      undefined,
      "POST",
      "/api/agents/dev/commands",
      { name: "code-review" },
      { authorization: `Bearer ${token}` },
    );
    // The REST API never consults agent tokens (AC 6): an agent has no session, so it is refused before the route.
    expect(res.statusCode).toBe(401);
    expect(await queue()).toEqual([]);
  });

  test("an unknown agent is 404", async () => {
    const res = await call(or, "POST", "/api/agents/nope/commands", { name: "code-review" });
    expect(res.statusCode).toBe(404);
  });

  test.each([
    "model",
    "Model",
    "MODEL",
    "batch",
    "COMPACT",
    "Code-Review",
    "nope",
    "/code-review",
    "code-review src/",
    "__proto__",
    "constructor",
  ])("%j is 422 unknown_command and writes nothing", async (name) => {
    const res = await dispatch({ name, args: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("unknown_command");
    expect(await queue()).toEqual([]);
  });

  test("a skill alias that names a refused built-in is 422, never sent as /model", async () => {
    const res = await dispatch({ name: "model", args: "opus" });
    expect(res.statusCode).toBe(422);
    expect(commandWrites().map((w) => w.text)).not.toContainEqual(expect.stringMatching(/model/));
  });

  test.each(["src/\n/model opus", "a\rb", "a\u2028b", "a\u0000b"])(
    "args %j with a line break or control character are 400 and queue nothing",
    async (args) => {
      const res = await dispatch({ name: "code-review", args });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
      expect(await queue()).toEqual([]);
    },
  );

  test("over 64 KB as `/name args` is 413 too_large", async () => {
    // "/code-review " is 13 bytes: exactly at the limit is accepted, one byte over is not.
    const over = await dispatch({ name: "code-review", args: "a".repeat(MAX_BODY_BYTES - 12) });
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe("too_large");
    expect(await queue()).toEqual([]);
    const at = await dispatch({ name: "code-review", args: "a".repeat(MAX_BODY_BYTES - 13) });
    expect(at.statusCode).toBe(202);
    expect(
      (await call(or, "DELETE", `/api/agents/dev/queue/${at.json().item.id}`)).statusCode,
    ).toBe(200);
  });

  test("held while the turn is open; an alias is sent by its canonical name; your own cancels, another user's is 403", async () => {
    const res = await dispatch({ name: "review", args: "  src/  " });
    expect(res.statusCode).toBe(202);
    const item = res.json().item;
    expect(item).toMatchObject({
      kind: "command",
      body: "/code-review src/",
      from: "@orc",
      waitReason: "turn",
    });
    expect(await queue()).toEqual([expect.objectContaining({ id: item.id, kind: "command" })]);
    expect(commandWrites()).toEqual([]);

    const other = await call(sam, "DELETE", `/api/agents/dev/queue/${item.id}`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("not_sender");
    const mine = await call(or, "DELETE", `/api/agents/dev/queue/${item.id}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().item).toMatchObject({ id: item.id, kind: "command" });
    expect(await queue()).toEqual([]);
  });

  test("compact runs the compact flow with args as its focus; a focus over the limit is 400", async () => {
    const tooLong = await dispatch({ name: "compact", args: "f".repeat(MAX_FOCUS_CHARS + 1) });
    expect(tooLong.statusCode).toBe(400);
    expect(await queue()).toEqual([]);
    const res = await dispatch({ name: "compact", args: "keep the API" });
    expect(res.statusCode).toBe(202);
    expect(res.json().item).toMatchObject({ kind: "compact", focus: "keep the API", from: "@orc" });
  });

  test("clear runs the reset flow, with its refusals", async () => {
    const rt = await s.app.runtimes.bySlug("dev");
    if (!rt) throw new Error("no runtime");
    const refused = await dispatch({ name: "new" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("reset_not_allowed");
    const spy = vi.spyOn(rt, "resetSession").mockResolvedValueOnce();
    const ok = await dispatch({ name: "clear", args: "ignored" });
    expect(ok.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith({ byHandle: "orc" });
    spy.mockRestore();
  });

  test("written raw when the turn ends, then the event; a written command can't be cancelled", async () => {
    // Clear the compact queued above: its own turn_end releases it.
    drv.last.emit(ev.usage(), ev.end());
    await settled();
    drv.last.emit(ev.turn(), ev.usage(), ev.end({ command: "compact", numTurns: 0 }));
    await settled();
    const res = await dispatch({ name: "usage" });
    expect(res.statusCode).toBe(202);
    await settled();
    expect(commandWrites().at(-1)).toEqual({ kind: "command", text: "/usage" });
    const page = (await call(or, "GET", "/api/agents/dev/events")).json();
    expect(page.events.map((e: { event: unknown }) => e.event)).toContainEqual({
      type: "control",
      cmd: "command",
      arg: "/usage",
      by: "@orc",
    });
    const del = await call(or, "DELETE", `/api/agents/dev/queue/${res.json().item.id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("already_delivered");
  });
});
