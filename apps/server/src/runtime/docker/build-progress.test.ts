import { expect, test } from "vitest";
import { buildProgress } from "./build-progress.ts";

const run = (events: object[], err: Error | null = null) => {
  const lines: string[] = [];
  const p = buildProgress((l) => lines.push(l));
  for (const e of events) p.push(e);
  return { lines, result: p.end(err) };
};

test("stream text becomes lines, split on newlines and joined across chunks", () => {
  const { lines, result } = run([
    { stream: "Step 1/2 : FROM ghcr.io/orlevii/open-factory/base:latest\n" },
    { stream: " ---> 1a2b3c\nStep 2/2 : RUN " },
    { stream: "true\n" },
    { stream: "Successfully tagged of-gate:1" },
  ]);
  expect(lines).toEqual([
    "Step 1/2 : FROM ghcr.io/orlevii/open-factory/base:latest",
    " ---> 1a2b3c",
    "Step 2/2 : RUN true",
    "Successfully tagged of-gate:1",
  ]);
  expect(result).toEqual({ ok: true });
});

test("pull status lines are kept, progress ticks and aux are not", () => {
  const { lines } = run([
    { status: "latest: Pulling from orlevii/open-factory/base" },
    {
      status: "Downloading",
      progressDetail: { current: 1, total: 2 },
      progress: "[=>  ]",
      id: "a1",
    },
    { status: "Pull complete", id: "a1" },
    { aux: { ID: "sha256:abc" } },
  ]);
  expect(lines).toEqual(["latest: Pulling from orlevii/open-factory/base", "a1: Pull complete"]);
});

// Live gate V1 (b): followProgress's err is null, the failure is in the stream.
test("an error event in the stream fails the build with its message", () => {
  const msg = "The command '/bin/bash -o pipefail -c false' returned a non-zero code: 1";
  const { lines, result } = run([
    { stream: "Step 2/2 : RUN false\n" },
    { error: msg, errorDetail: { code: 1, message: msg } },
  ]);
  expect(result).toEqual({ ok: false, error: msg });
  expect(lines).toEqual(["Step 2/2 : RUN false", msg]);
});

test("a stream error from followProgress fails the build", () => {
  expect(run([], new Error("socket hang up")).result).toEqual({
    ok: false,
    error: "socket hang up",
  });
});
