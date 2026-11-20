import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, expect, test } from "vitest";
import { createFakeClaude } from "../testing/index.ts";

const runs: Array<() => void> = [];
afterEach(() => {
  for (const r of runs.splice(0)) r();
});

function run(bin: string, args: string[] = []) {
  const child = spawn(
    bin,
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...args],
    { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  runs.push(() => child.kill("SIGTERM"));
  const lines: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout }).on("line", (l) => lines.push(JSON.parse(l)));
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = async (pred: (l: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (lines.some(pred)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timeout");
  };
  return { child, lines, send, waitFor, exited, stderr: () => stderr };
}
const user = (content: string) => ({ type: "user", message: { role: "user", content } });

test("replays a reply turn with this run's session id and logs stdin", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = run(fake.bin);
  p.send(user("hi"));
  await p.waitFor((l) => l.type === "result");
  const ids = new Set(p.lines.map((l) => l.session_id).filter(Boolean));
  expect(ids.size).toBe(1);
  p.child.stdin.end();
  expect(await p.exited).toBe(0);
  const log = fake.log();
  expect(log[0]).toMatchObject({ kind: "start" });
  expect(log.find((e) => e.kind === "stdin")).toMatchObject({ line: JSON.stringify(user("hi")) });
});

test("resume of a known session keeps the id; unknown id fails like Claude", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const first = run(fake.bin);
  first.send(user("hi"));
  await first.waitFor((l) => l.type === "result");
  const id = String(first.lines[0]?.session_id);
  first.child.stdin.end();
  await first.exited;

  const resumed = run(fake.bin, ["--resume", id]);
  resumed.send(user("again"));
  await resumed.waitFor((l) => l.type === "result");
  expect(resumed.lines[0]?.session_id).toBe(id);
  resumed.child.stdin.end();
  await resumed.exited;

  const bad = run(fake.bin, ["--resume", "00000000-0000-4000-8000-000000000001"]);
  await bad.waitFor((l) => l.type === "result");
  expect(bad.lines[0]).toMatchObject({
    type: "result",
    subtype: "error_during_execution",
    num_turns: 0,
  });
  bad.child.stdin.end();
  expect(await bad.exited).toBe(1);
  expect(bad.stderr()).toMatch(/No conversation found/);
});

test("interrupt during a long tool: control_response, then the interrupted result", async () => {
  const fake = createFakeClaude({ scenario: "long-tool" });
  const p = run(fake.bin);
  p.send(user("run ping"));
  await p.waitFor((l) => l.type === "assistant");
  p.send({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
  await p.waitFor((l) => l.type === "result");
  expect(p.lines.find((l) => l.type === "control_response")).toBeTruthy();
  expect(p.lines.at(-1)).toMatchObject({ type: "result", terminal_reason: "aborted_tools" });
});

test("a malformed stdin line exits 1 with nothing on stdout", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = run(fake.bin);
  p.child.stdin.write("not json\n");
  expect(await p.exited).toBe(1);
  expect(p.lines).toEqual([]);
  expect(p.stderr()).toMatch(/Error parsing streaming input line/);
});

test("SIGTERM exits 143", async () => {
  const fake = createFakeClaude({ scenario: "long-tool" });
  const p = run(fake.bin);
  p.send(user("run ping"));
  await p.waitFor((l) => l.type === "assistant");
  p.child.kill("SIGTERM");
  expect(await p.exited).toBe(143);
});

test("knownSession makes an id resumable and stateDir is exposed", async () => {
  const fake = createFakeClaude({ scenario: "orphans-then-reply" });
  const id = "11111111-1111-4111-8111-111111111111";
  fake.knownSession(id);
  expect(fake.stateDir).toContain(fake.dir);
  const p = run(fake.bin, ["--resume", id]);
  await p.waitFor((l) => l.type === "result");
  expect(p.lines.every((l) => !l.session_id || l.session_id === id)).toBe(true);
  expect(p.lines[0]).toMatchObject({ subtype: "task_notification" });
});
