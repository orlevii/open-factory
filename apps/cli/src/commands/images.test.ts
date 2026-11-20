import { expect, test } from "vitest";
import { type Io, run } from "../commands.ts";

const list = {
  imagesDir: "/data/images",
  baseImage: "base:1",
  images: [
    { name: "smoke", status: "not_built", usedBy: ["dev"] },
    { name: "ok", status: "built", builtAt: "2026-11-20T10:00:00.000Z", usedBy: [] },
    { name: "bad", status: "failed", usedBy: ["a", "b"] },
  ],
};

interface Call {
  url: string;
  method: string;
  accept: string | null;
  body: unknown;
}

function harness(
  opts: { token?: string; builds?: Record<string, string[]>; images?: unknown[] } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const env: Record<string, string | undefined> = {
    OPEN_FACTORY_URL: "http://of.test",
    OPEN_FACTORY_TOKEN: "token" in opts ? opts.token : "tok",
    XDG_CONFIG_HOME: "/nonexistent-of-cli",
  };
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      accept: headers.get("accept"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/api/images"))
      return Response.json(opts.images ? { ...list, images: opts.images } : list);
    const m = /\/api\/images\/([^/]+)\/build$/.exec(url);
    const lines = m && opts.builds?.[m[1] as string];
    if (lines) {
      // Split the body at arbitrary byte boundaries to exercise the reader.
      const text = `${lines.join("\n")}\n`;
      const mid = Math.floor(text.length / 2);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(text.slice(0, mid)));
            c.enqueue(enc.encode(text.slice(mid)));
            c.close();
          },
        }),
      );
    }
    return Response.json({ error: { code: "not_found", message: "nope" } }, { status: 404 });
  }) as typeof fetch;
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ask: async () => "",
    askHidden: async () => "",
    env,
    fetch: fetchStub,
  };
  return { io, out, err, calls };
}

const ok = (...l: string[]) => [
  ...l.map((line) => JSON.stringify({ line })),
  '{"state":"succeeded"}',
];

test("images prints a table", async () => {
  const h = harness();
  expect(await run(["images"], h.io)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toMatch(/NAME\s+STATUS\s+BUILT\s+USED BY/);
  expect(text).toMatch(/smoke\s+not_built\s+-\s+dev/);
  expect(text).toMatch(/ok\s+built\s+2026-11-20T10:00:00.000Z\s+-/);
  expect(text).toMatch(/bad\s+failed\s+-\s+a, b/);
});

test("images build streams lines and exits 0 on succeeded", async () => {
  const h = harness({ builds: { smoke: ok("Step 1", "Step 2") } });
  expect(await run(["images", "build", "smoke"], h.io)).toBe(0);
  expect(h.out).toEqual(["Step 1", "Step 2", "Built smoke"]);
  expect(h.calls.find((c) => c.method === "POST")).toMatchObject({
    url: "http://of.test/api/images/smoke/build",
    method: "POST",
    accept: "application/x-ndjson",
    body: { pull: true },
  });
});

test("images build exits 1 and prints the error on failed", async () => {
  const h = harness({
    builds: { smoke: ['{"line":"boom"}', '{"state":"failed","error":"exit 2"}'] },
  });
  expect(await run(["images", "build", "smoke"], h.io)).toBe(1);
  expect(h.out).toContain("boom");
  expect(h.err.join("\n")).toContain("exit 2");
});

test("--no-pull sends pull:false", async () => {
  const h = harness({ builds: { smoke: ok() } });
  expect(await run(["images", "build", "smoke", "--no-pull"], h.io)).toBe(0);
  expect(h.calls.find((c) => c.method === "POST")?.body).toEqual({ pull: false });
});

test("--all builds every image that is not built, in order, and exits 1 if any failed", async () => {
  const h = harness({
    builds: { smoke: ok("a"), bad: ['{"state":"failed","error":"x"}'], ok: ok() },
  });
  expect(await run(["images", "build", "--all"], h.io)).toBe(1);
  const builds = h.calls.filter((c) => c.method === "POST").map((c) => c.url.split("/")[5]);
  expect(builds).toEqual(["smoke", "bad"]);
});

test("--all exits 0 when every build succeeds", async () => {
  const h = harness({ builds: { smoke: ok(), bad: ok() } });
  expect(await run(["images", "build", "--all"], h.io)).toBe(0);
});

test("not logged in", async () => {
  const h = harness({ token: undefined });
  expect(await run(["images"], h.io)).toBe(1);
  expect(h.err.join("\n")).toMatch(/Not logged in.*open-factory login/);
  expect(h.calls).toEqual([]);
});

test("unknown subcommand prints usage and exits 2", async () => {
  const h = harness();
  expect(await run(["images", "frob"], h.io)).toBe(2);
  expect(h.err).toContain(
    "Usage: open-factory images | open-factory images build (<name>|--all) [--no-pull]",
  );
  expect(await run(["images", "build"], h.io)).toBe(2);
  expect(h.calls).toEqual([]);
});

test("--all skips folders without a Dockerfile and says so", async () => {
  const h = harness({
    images: [...list.images, { name: "empty", status: "no_dockerfile", usedBy: [] }],
    builds: { smoke: ok(), bad: ok() },
  });
  expect(await run(["images", "build", "--all"], h.io)).toBe(0);
  const builds = h.calls.filter((c) => c.method === "POST").map((c) => c.url.split("/")[5]);
  expect(builds).toEqual(["smoke", "bad"]);
  expect(h.out).toContain("Skipping empty: no Dockerfile in /data/images/empty");
});

test("--all with nothing to build says every image is built", async () => {
  const h = harness({ images: [{ name: "ok", status: "built", usedBy: [] }] });
  expect(await run(["images", "build", "--all"], h.io)).toBe(0);
  expect(h.out).toEqual(["All images are built."]);
  expect(h.calls.filter((c) => c.method === "POST")).toEqual([]);
});

test("a stream line that isn't a build message fails the build with a plain message", async () => {
  for (const lines of [
    ['{"line":"a"}', "{not json"],
    ['{"line":"a"}', '{"what":1}'],
  ]) {
    const h = harness({ builds: { smoke: lines } });
    expect(await run(["images", "build", "smoke"], h.io)).toBe(1);
    expect(h.err).toEqual(["Build of smoke failed: unexpected response"]);
  }
});

test("an unknown flag prints usage and exits 2", async () => {
  const h = harness();
  expect(await run(["images", "build", "smoke", "--foo"], h.io)).toBe(2);
  expect(h.err.join("\n")).toMatch(/Usage: open-factory images/);
  expect(h.calls).toEqual([]);
});
