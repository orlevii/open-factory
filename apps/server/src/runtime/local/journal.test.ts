import { expect, test } from "vitest";
import { descendants, ProcessJournal, parsePs } from "./journal.ts";

test("parsePs and descendants walk the tree including setsid children", () => {
  const rows = parsePs(
    " 10 1 Wed Nov 19 10:00:00 2026\n 11 10 Wed Nov 19 10:00:01 2026\n 12 11 Wed Nov 19 10:00:02 2026\n 13 1 Wed Nov 19 10:00:03 2026\n",
  );
  expect(descendants(rows, 10).map((r) => r.pid)).toEqual([11, 12]);
});

test("parsePs normalizes the padded day and skips junk lines", () => {
  expect(parsePs("  7   1 Sun Nov  9 08:00:00 2026\n\nnot a row\n")).toEqual([
    { pid: 7, ppid: 1, start: "Sun Nov 9 08:00:00 2026" },
  ]);
});

test("descendants survives a ppid cycle", () => {
  const rows = [
    { pid: 11, ppid: 12, start: "S" },
    { pid: 12, ppid: 11, start: "S" },
    { pid: 13, ppid: 10, start: "S" },
  ];
  expect(descendants(rows, 10).map((r) => r.pid)).toEqual([13]);
});

test("snapshot records Claude and its tree with start times", async () => {
  const j = new ProcessJournal({
    parentPid: 5,
    ps: async () =>
      " 10 5 Wed Nov 19 10:00:00 2026\n 11 10 Wed Nov 19 10:00:01 2026\n 20 1 X\n 30 1 Y\n 31 30 Z\n",
  });
  expect(await j.snapshot(10)).toEqual({
    claude: { pid: 10, start: "Wed Nov 19 10:00:00 2026" },
    descendants: [{ pid: 11, start: "Wed Nov 19 10:00:01 2026" }],
  });
  await expect(j.snapshot(99)).rejects.toThrow("not running");
  // Claude's pid reused by a process that isn't the server's child: never journaled.
  await expect(j.snapshot(30)).rejects.toThrow("not the server's child");
});

test("reap never signals a pid whose start time changed", async () => {
  const kills: [number, string][] = [];
  const j = new ProcessJournal({
    startOf: async (p) => (p === 11 ? "OTHER" : "S"),
    kill: (p, s) => kills.push([p, s]),
    sleep: async () => {},
  });
  await j.reap({ claude: { pid: 10, start: "S" }, descendants: [{ pid: 11, start: "S" }] });
  expect(kills.map((k) => k[0])).not.toContain(11);
});

test("reap: SIGTERM, 3 s, then SIGKILL only the survivors that still match", async () => {
  const kills: [number, string][] = [];
  const sleeps: number[] = [];
  let afterWait = false;
  const j = new ProcessJournal({
    // 11 exits on SIGTERM; 12 survives; 13 is gone after the wait and its pid reused
    startOf: async (p) => {
      if (!afterWait) return "S";
      return p === 12 ? "S" : p === 13 ? "REUSED" : undefined;
    },
    kill: (p, s) => kills.push([p, s]),
    sleep: async (ms) => {
      sleeps.push(ms);
      afterWait = true;
    },
  });
  const n = await j.reap({
    descendants: [
      { pid: 11, start: "S" },
      { pid: 12, start: "S" },
      { pid: 13, start: "S" },
    ],
  });
  expect(n).toBe(3);
  expect(sleeps).toEqual([3000]);
  expect(kills).toEqual([
    [11, "SIGTERM"],
    [12, "SIGTERM"],
    [13, "SIGTERM"],
    [12, "SIGKILL"],
  ]);
});

test("reap fails closed: no start time, an unknown pid, init or the server itself are never signalled", async () => {
  const kills: number[] = [];
  const sleeps: number[] = [];
  const j = new ProcessJournal({
    startOf: async (p) => (p === 50 ? undefined : "S"),
    kill: (p) => kills.push(p),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const n = await j.reap({
    claude: { pid: 50, start: "S" },
    descendants: [
      { pid: 1, start: "S" },
      { pid: 0, start: "S" },
      { pid: -10, start: "S" },
      { pid: process.pid, start: "S" },
      { pid: 60, start: "" },
    ],
  });
  expect(n).toBe(0);
  expect(kills).toEqual([]);
  expect(sleeps).toEqual([]); // nothing signalled: no wait
});

test("reap counts only pids the signal reached", async () => {
  const j = new ProcessJournal({
    startOf: async () => "S",
    kill: (p) => {
      if (p === 11) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    sleep: async () => {},
  });
  expect(
    await j.reap({
      descendants: [
        { pid: 11, start: "S" },
        { pid: 12, start: "S" },
        { pid: 12, start: "S" },
      ],
    }),
  ).toBe(1);
});
