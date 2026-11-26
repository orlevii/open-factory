import { PassThrough } from "node:stream";
import type { AgentRuntimeSpec } from "@open-factory/harness";
import { expect, test, vi } from "vitest";
import type { DockerClient, ExecStream } from "./client.ts";
import type { ContainerManager } from "./containers.ts";
import {
  CLAUDE_PID_FILE,
  CLAUDE_WRAPPER,
  dockerTransport,
  parsePid,
  TERMINATE_BOUND_MS,
} from "./exec-transport.ts";

type Exec = { cmd: string[]; user: string };
type StreamCall = { id: string; cmd: string[]; user: string; workdir: string; env: string[] };

/** A scripted exec stream: tests feed stdout/stderr and end it with an exit code. */
function fakeStream() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
  let resolveExit!: (code: number | null) => void;
  const exit = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const stream: ExecStream = {
    stdin,
    stdout,
    stderr,
    closeStdin: vi.fn(() => stdin.end()),
    exit,
  };
  return {
    stream,
    stdout,
    stderr,
    written,
    finish(code: number | null) {
      stdout.end();
      stderr.end();
      resolveExit(code);
    },
  };
}

function fakeDocker(o: { pidFile?: string; comm?: string; killCode?: number; execError?: Error }) {
  const execs: Exec[] = [];
  const streams: StreamCall[] = [];
  const s = fakeStream();
  const client: Partial<DockerClient> = {
    async execRun(_id, e) {
      execs.push({ cmd: e.cmd, user: e.user });
      if (e.cmd[0] === "cat" && e.cmd[1] === CLAUDE_PID_FILE)
        return { code: 0, stdout: o.pidFile ?? "" };
      if (e.cmd[0] === "cat" && e.cmd[1]?.startsWith("/proc/"))
        return { code: 0, stdout: o.comm ?? "" };
      if (e.cmd[0] === "kill") return { code: o.killCode ?? 0, stdout: "" };
      return { code: 1, stdout: "" };
    },
    async execStream(id, e) {
      streams.push({ id, ...e });
      if (o.execError) throw o.execError;
      return s.stream;
    },
  };
  const stops: { agentId: string; ref: string }[] = [];
  const containers = {
    async stop(agentId: string, ref: string) {
      stops.push({ agentId, ref });
    },
  } as unknown as ContainerManager;
  return { client: client as DockerClient, containers, execs, streams, stops, s };
}

const spec: AgentRuntimeSpec = {
  agentId: "a1",
  ref: "dev",
  cwd: "/home/agent/workspace",
  env: { CLAUDE_CONFIG_DIR: "/home/agent/workspace/.claude-config", OPEN_FACTORY_URL: "http://x" },
  claudeBin: "/usr/local/bin/claude",
  runtime: "docker",
  permissionMode: "auto",
  mounts: [],
  docker: { containerId: "c1", claudeBin: "claude" },
};

const transport = (d: ReturnType<typeof fakeDocker>, args: string[] = ["-p"]) =>
  dockerTransport({ docker: d.client, containers: d.containers })(spec, args);

test.each(["abc", "0", "-5", "12345678901", "12 34", "", "42; kill 1", "0x2a", "042"])(
  "pid file %j: no kill exec, terminate false",
  async (content) => {
    const d = fakeDocker({ pidFile: content, comm: "claude\n" });
    expect(await transport(d).terminate()).toBe(false);
    expect(d.execs.some((e) => e.cmd[0] === "kill")).toBe(false);
  },
);

test("parsePid accepts 1..10 digits without a leading zero, trimmed", () => {
  expect(parsePid("42\n")).toBe(42);
  expect(parsePid(" 1 ")).toBe(1);
  expect(parsePid("4294967295")).toBe(4294967295);
  expect(parsePid("0")).toBeUndefined();
  expect(parsePid("1.5")).toBeUndefined();
});

test.each(["sh\n", "claude-x\n", "", "node\n"])(
  "comm %j: no kill exec, terminate false",
  async (comm) => {
    const d = fakeDocker({ pidFile: "42\n", comm });
    expect(await transport(d).terminate()).toBe(false);
    expect(d.execs.some((e) => e.cmd[0] === "kill")).toBe(false);
    expect(d.execs.at(-1)).toEqual({ cmd: ["cat", "/proc/42/comm"], user: "agent" });
  },
);

test("good pid: kill -TERM as agent, argv only", async () => {
  const d = fakeDocker({ pidFile: "42\n", comm: "claude\n" });
  expect(await transport(d).terminate()).toBe(true);
  expect(d.execs).toEqual([
    { cmd: ["cat", "/tmp/open-factory-claude.pid"], user: "agent" },
    { cmd: ["cat", "/proc/42/comm"], user: "agent" },
    { cmd: ["kill", "-TERM", "42"], user: "agent" },
  ]);
});

test("a failed kill or a failing exec reports false (fails closed)", async () => {
  const d = fakeDocker({ pidFile: "42\n", comm: "claude\n", killCode: 1 });
  expect(await transport(d).terminate()).toBe(false);

  const e = fakeDocker({});
  e.client.execRun = async () => {
    throw new Error("daemon gone");
  };
  expect(await transport(e).terminate()).toBe(false);
});

test("a daemon that never answers: terminate reports false after the bound", async () => {
  vi.useFakeTimers();
  try {
    const d = fakeDocker({});
    d.client.execRun = () => new Promise(() => {});
    const r = transport(d).terminate();
    await vi.advanceTimersByTimeAsync(TERMINATE_BOUND_MS);
    expect(await r).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("an exec that never starts: terminate reports false after the bound, with no exec", async () => {
  vi.useFakeTimers();
  try {
    const d = fakeDocker({ pidFile: "42\n", comm: "claude\n" });
    let start!: (s: ExecStream) => void;
    d.client.execStream = async (id, e) => {
      d.streams.push({ id, ...e });
      return new Promise<ExecStream>((r) => {
        start = r;
      });
    };
    const t = transport(d);
    const r = t.terminate();
    await vi.advanceTimersByTimeAsync(TERMINATE_BOUND_MS);
    expect(await r).toBe(false);
    // A daemon that answers late gets no exec from the expired terminate.
    start(d.s.stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.execs).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("terminate after exit signals nothing", async () => {
  const d = fakeDocker({ pidFile: "42\n", comm: "claude\n" });
  const t = transport(d);
  d.s.finish(0);
  await t.exit;
  expect(await t.terminate()).toBe(false);
  expect(d.execs).toEqual([]);
});

test("exec Cmd uses the fixed wrapper and argv args; Env is the spec env", async () => {
  const d = fakeDocker({});
  const t = transport(d, ["--model", "haiku; rm -rf /", "$(id)"]);
  d.s.finish(0);
  await t.exit;
  expect(CLAUDE_WRAPPER).toBe('echo $$ > /tmp/open-factory-claude.pid && exec "$0" "$@"');
  expect(d.streams).toEqual([
    {
      id: "c1",
      cmd: ["sh", "-c", CLAUDE_WRAPPER, "claude", "--model", "haiku; rm -rf /", "$(id)"],
      user: "agent",
      workdir: "/home/agent/workspace",
      env: ["CLAUDE_CONFIG_DIR=/home/agent/workspace/.claude-config", "OPEN_FACTORY_URL=http://x"],
    },
  ]);
  expect(t.pid).toBeUndefined();
});

test("stdin writes lines; stdout/stderr are line iterables drained before exit", async () => {
  const d = fakeDocker({});
  const t = transport(d);
  await t.write('{"a":1}');
  expect(d.s.written).toEqual(['{"a":1}\n']);
  d.s.stdout.write("one\ntw");
  d.s.stdout.write("o\n");
  d.s.stderr.write("err\n");
  const out: string[] = [];
  const err: string[] = [];
  const pump = Promise.all([
    (async () => {
      for await (const l of t.stdout) out.push(l);
    })(),
    (async () => {
      for await (const l of t.stderr) err.push(l);
    })(),
  ]);
  d.s.finish(3);
  expect(await t.exit).toEqual({ code: 3, signal: null });
  await pump;
  expect(out).toEqual(["one", "two"]);
  expect(err).toEqual(["err"]);
});

test("endInput half-closes; exit code from inspect; write after exit rejects", async () => {
  const d = fakeDocker({});
  const t = transport(d);
  t.endInput();
  await vi.waitFor(() => expect(d.s.stream.closeStdin).toHaveBeenCalledTimes(1));
  await expect(t.write("x")).rejects.toMatchObject({ name: "ProcessNotRunningError" });
  // Half-close: output keeps flowing after stdin EOF.
  d.s.stdout.write("after eof\n");
  const out: string[] = [];
  const pump = (async () => {
    for await (const l of t.stdout) out.push(l);
  })();
  d.s.finish(null);
  expect(await t.exit).toEqual({ code: null, signal: null });
  await pump;
  expect(out).toEqual(["after eof"]);
  await expect(t.write("x")).rejects.toMatchObject({ name: "ProcessNotRunningError" });
});

test("a failed exec settles exit with a spawn error", async () => {
  const d = fakeDocker({ execError: new Error("no such container") });
  const t = transport(d);
  expect(await t.exit).toEqual({
    code: null,
    signal: null,
    spawnError: { message: "no such container" },
  });
  expect(await t.terminate()).toBe(false);
  await expect(t.write("x")).rejects.toMatchObject({ name: "ProcessNotRunningError" });
});

test("a spec without a container settles with a spawn error and never execs", async () => {
  const d = fakeDocker({});
  const { docker: _, ...noDocker } = spec;
  const t = dockerTransport({ docker: d.client, containers: d.containers })(noDocker, []);
  expect((await t.exit).spawnError?.message).toMatch(/container/);
  expect(d.streams).toEqual([]);
});

test("forceKill stops the agent's container (t: 5 via ContainerManager); not after exit", async () => {
  const d = fakeDocker({});
  const t = transport(d);
  await t.forceKill();
  expect(d.stops).toEqual([{ agentId: "a1", ref: "dev" }]);
  d.s.finish(137);
  await t.exit;
  await t.forceKill();
  expect(d.stops).toHaveLength(1);
});
