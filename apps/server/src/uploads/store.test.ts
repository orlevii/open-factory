import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildRuntimeSpec } from "../agents/runtime-spec.ts";
import { buildMounts } from "../workspace/mounts.ts";
import { UnsafePathError } from "../workspace/safe-fs.ts";
import { png } from "./fixtures.ts";
import { UploadExistsError, UploadStore, UploadTooLargeError } from "./store.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function* chunks(...parts: Buffer[]) {
  for (const p of parts) yield p;
}
const uploadsOf = (wd: string) => path.join(wd, ".factory/uploads");

let umask: number;
beforeEach(() => {
  // A restrictive server umask: modes must still come out 0644 and 0755.
  umask = process.umask(0o077);
});
afterEach(() => {
  process.umask(umask);
});

test("writes into .factory/uploads with 0644 files and 0755 folders whatever the umask", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const data = png(10, 10);
  const r = await store.write(chunks(data), { storedName: "20261122-a-x.png", name: "x.png" });
  if ("status" in r) throw new Error("refused");
  expect(r).toMatchObject({
    rel: ".factory/uploads/20261122-a-x.png",
    bytes: data.length,
    sha256: sha(data),
  });
  expect(r.sniffed).toMatchObject({ kind: "image", mime: "image/png" });
  const file = path.join(uploadsOf(wd), "20261122-a-x.png");
  expect(readFileSync(file)).toEqual(data);
  expect(statSync(file).mode & 0o777).toBe(0o644);
  expect(statSync(path.join(wd, ".factory")).mode & 0o777).toBe(0o755);
  expect(statSync(uploadsOf(wd)).mode & 0o777).toBe(0o755);
  // No temp file is left behind.
  expect(readdirSync(uploadsOf(wd))).toEqual(["20261122-a-x.png"]);
});

test("a symlinked .factory is refused and nothing is written outside the workspace", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  symlinkSync(outside, path.join(wd, ".factory"));
  const store = await UploadStore.open(wd);
  await expect(
    store.write(chunks(Buffer.from("hi")), { storedName: "a.txt", name: "a.txt" }),
  ).rejects.toBeInstanceOf(UnsafePathError);
  expect(readdirSync(outside)).toEqual([]);
});

test("a symlinked .factory/uploads is refused and nothing is written outside the workspace", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  mkdirSync(path.join(wd, ".factory"));
  symlinkSync(outside, uploadsOf(wd));
  const store = await UploadStore.open(wd);
  await expect(
    store.write(chunks(Buffer.from("hi")), { storedName: "a.txt", name: "a.txt" }),
  ).rejects.toBeInstanceOf(UnsafePathError);
  expect(readdirSync(outside)).toEqual([]);
});

test("a workdir that is itself a symlink is refused (realpath containment)", async () => {
  const real = tmp("real-");
  const parent = tmp("parent-");
  symlinkSync(real, path.join(parent, "dev"));
  await expect(UploadStore.open(path.join(parent, "dev"))).rejects.toBeInstanceOf(UnsafePathError);
  expect(readdirSync(real)).toEqual([]);
});

test("an existing file or link at the target is refused (O_EXCL), never replaced or followed", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  await store.ensureDir();
  writeFileSync(path.join(uploadsOf(wd), "taken.txt"), "original");
  await expect(
    store.write(chunks(Buffer.from("new")), { storedName: "taken.txt", name: "taken.txt" }),
  ).rejects.toBeInstanceOf(UploadExistsError);
  expect(readFileSync(path.join(uploadsOf(wd), "taken.txt"), "utf8")).toBe("original");
  const secret = path.join(tmp("secret-"), "key");
  writeFileSync(secret, "secret");
  symlinkSync(secret, path.join(uploadsOf(wd), "link.txt"));
  await expect(
    store.write(chunks(Buffer.from("new")), { storedName: "link.txt", name: "link.txt" }),
  ).rejects.toBeInstanceOf(UploadExistsError);
  expect(readFileSync(secret, "utf8")).toBe("secret");
  expect(readdirSync(uploadsOf(wd)).sort()).toEqual(["link.txt", "taken.txt"]);
});

test("a stored name that could leave the folder is refused before anything is opened", async () => {
  const store = await UploadStore.open(tmp("wd-"));
  for (const storedName of ["../x.txt", "a/b.txt", "..", ""])
    await expect(
      store.write(chunks(Buffer.from("x")), { storedName, name: "x" }),
    ).rejects.toThrow();
});

test("a stream crossing the limit throws and deletes the temp file", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const err = await store
    .write(chunks(Buffer.alloc(6, 0x61), Buffer.alloc(6, 0x61)), {
      storedName: "big.txt",
      name: "big.txt",
      limit: 10,
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(UploadTooLargeError);
  expect(readdirSync(uploadsOf(wd))).toEqual([]);
});

test("an aborted stream deletes the temp file", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  async function* aborted() {
    yield Buffer.from("partial");
    throw new Error("aborted");
  }
  await expect(store.write(aborted(), { storedName: "a.txt", name: "a.txt" })).rejects.toThrow(
    "aborted",
  );
  expect(readdirSync(uploadsOf(wd))).toEqual([]);
});

test("a refused type returns the refusal and leaves no file", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const r = await store.write(chunks(Buffer.from("<svg>")), { storedName: "a.svg", name: "a.svg" });
  expect(r).toMatchObject({ status: 415 });
  expect(readdirSync(uploadsOf(wd))).toEqual([]);
});

test("read checks size and sha256 and refuses a swapped, resized, linked or hardlinked file", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const data = Buffer.from("hello world\n");
  const r = await store.write(chunks(data), { storedName: "a.txt", name: "a.txt" });
  if ("status" in r) throw new Error("refused");
  const expected = { bytes: r.bytes, sha256: r.sha256 };
  expect(await store.read(r.rel, expected)).toEqual(data);
  const file = path.join(wd, r.rel);

  writeFileSync(file, "hello world!\n"); // resized
  expect(await store.read(r.rel, expected)).toBeUndefined();
  writeFileSync(file, "HELLO WORLD\n"); // same size, other bytes
  expect(await store.read(r.rel, expected)).toBeUndefined();

  const secret = path.join(tmp("secret-"), "key");
  writeFileSync(secret, data);
  const { rmSync } = await import("node:fs");
  rmSync(file);
  symlinkSync(secret, file); // a planted link, even to identical bytes
  expect(await store.read(r.rel, expected)).toBeUndefined();

  rmSync(file);
  const other = path.join(wd, "other.txt");
  writeFileSync(other, data);
  linkSync(other, file); // a hardlink swap, even to identical bytes
  expect(await store.read(r.rel, expected)).toBeUndefined();
});

test("read refuses a symlinked uploads folder", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const data = Buffer.from("x\n");
  const r = await store.write(chunks(data), { storedName: "a.txt", name: "a.txt" });
  if ("status" in r) throw new Error("refused");
  const { renameSync } = await import("node:fs");
  const moved = path.join(tmp("moved-"), "uploads");
  renameSync(uploadsOf(wd), moved);
  symlinkSync(moved, uploadsOf(wd));
  await expect(store.read(r.rel, { bytes: r.bytes, sha256: r.sha256 })).rejects.toBeInstanceOf(
    UnsafePathError,
  );
});

test("remove deletes the file; a planted link is removed itself, never its target", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const r = await store.write(chunks(Buffer.from("x\n")), { storedName: "a.txt", name: "a.txt" });
  if ("status" in r) throw new Error("refused");
  await store.remove(r.rel);
  expect(existsSync(path.join(wd, r.rel))).toBe(false);
  await store.remove(r.rel); // missing is fine
  const secret = path.join(tmp("secret-"), "key");
  writeFileSync(secret, "secret");
  symlinkSync(secret, path.join(wd, r.rel));
  await store.remove(r.rel);
  expect(lstatSync(path.dirname(path.join(wd, r.rel))).isDirectory()).toBe(true);
  expect(existsSync(path.join(wd, r.rel))).toBe(false);
  expect(readFileSync(secret, "utf8")).toBe("secret");
});

test("remove refuses a symlinked .factory: the target outside is untouched", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  mkdirSync(path.join(outside, "uploads"));
  writeFileSync(path.join(outside, "uploads/a.txt"), "keep");
  symlinkSync(outside, path.join(wd, ".factory"));
  const store = await UploadStore.open(wd);
  await expect(store.remove(".factory/uploads/a.txt")).rejects.toBeInstanceOf(UnsafePathError);
  expect(readFileSync(path.join(outside, "uploads/a.txt"), "utf8")).toBe("keep");
});

// §22 (R3): the dev's automated evidence that a Docker agent can read what the server wrote. No container starts.
test("Docker: the stored file is under the workdir mount the container sees and is readable by another uid", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const r = await store.write(chunks(png(20, 20)), {
    storedName: "20261122-id-shot.png",
    name: "shot.png",
  });
  if ("status" in r) throw new Error("refused");
  const mounts = buildMounts({
    workdir: wd,
    grantedPaths: [],
    hostSkillPaths: [],
    templateSkillPaths: [],
    declaredMarketplaceDirs: [],
    pluginsDir: "/host/plugins",
    cliBundle: "/host/cli",
  });
  const spec = buildRuntimeSpec({
    agentId: "a1",
    slug: "dev",
    workdir: wd,
    env: {},
    claudeBin: "/usr/local/bin/claude",
    config: { runtime: "docker", permissionMode: "auto" } as Parameters<
      typeof buildRuntimeSpec
    >[0]["config"],
    mounts,
  });
  expect(spec.runtime).toBe("docker");
  // The `[attached: …]` path, resolved against the cwd the container's process runs in.
  const inContainer = path.posix.resolve(spec.cwd, r.rel);
  const mount = spec.mounts.find(
    (m) => inContainer === m.target || inContainer.startsWith(`${m.target}/`),
  );
  expect(mount).toMatchObject({ source: wd, target: wd, readOnly: false });
  // The container path maps back to the very file the server wrote.
  const onHost = path.join(mount?.source ?? "", path.relative(mount?.target ?? "", inContainer));
  expect(onHost).toBe(path.join(wd, r.rel));
  // Readable (and its folders traversable) by a uid other than the server's.
  expect(statSync(onHost).mode & 0o004).toBe(0o004);
  for (const dir of [path.join(wd, ".factory"), uploadsOf(wd)])
    expect(statSync(dir).mode & 0o005).toBe(0o005);
});

// Review I1: Node has no openat, so a swap between the lstat walk and the open must be caught after the open.
test("a .factory swapped for a link between the walk and the open is refused before any byte, nothing outside", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  mkdirSync(path.join(outside, "uploads"));
  const { renameSync } = await import("node:fs");
  const store = await UploadStore.open(wd, {
    beforeOpen: async () => {
      renameSync(path.join(wd, ".factory"), path.join(wd, ".factory-real"));
      symlinkSync(outside, path.join(wd, ".factory"));
    },
  });
  await expect(
    store.write(chunks(Buffer.from("secret bytes")), { storedName: "a.txt", name: "a.txt" }),
  ).rejects.toBeInstanceOf(UnsafePathError);
  expect(readdirSync(path.join(outside, "uploads"))).toEqual([]);
  expect(readdirSync(path.join(wd, ".factory-real/uploads"))).toEqual([]);
});

test("a folder moved out between the write and the link is refused, and our files there are removed", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  const { renameSync } = await import("node:fs");
  const store = await UploadStore.open(wd, {
    beforeLink: async () => {
      renameSync(path.join(wd, ".factory"), path.join(outside, "fac"));
      symlinkSync(path.join(outside, "fac"), path.join(wd, ".factory"));
    },
  });
  await expect(
    store.write(chunks(Buffer.from("secret bytes")), { storedName: "a.txt", name: "a.txt" }),
  ).rejects.toBeInstanceOf(UnsafePathError);
  expect(readdirSync(path.join(outside, "fac/uploads"))).toEqual([]);
});

test("ensureDir refuses a .factory/uploads swapped for a link after its mkdir", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  mkdirSync(path.join(wd, ".factory"));
  const store = await UploadStore.open(wd);
  // An existing link is caught by the walk; the post-open fstat/realpath check is the second line.
  symlinkSync(outside, uploadsOf(wd));
  await expect(store.ensureDir()).rejects.toBeInstanceOf(UnsafePathError);
  expect(readdirSync(outside)).toEqual([]);
});

// Review I3: the spec resolves the workdir with realpath; a symlinked FACTORY_HOME must work.
test("a workdir reached through a symlinked parent is resolved and used at its real path", async () => {
  const home = tmp("home-");
  mkdirSync(path.join(home, "agents/dev"), { recursive: true });
  const alias = path.join(tmp("alias-"), "home");
  symlinkSync(home, alias);
  const store = await UploadStore.open(path.join(alias, "agents/dev"));
  expect(store.root).toBe(path.join(home, "agents/dev"));
  const r = await store.write(chunks(Buffer.from("hi\n")), { storedName: "a.txt", name: "a.txt" });
  expect(r).toMatchObject({ rel: ".factory/uploads/a.txt" });
  expect(readFileSync(path.join(home, "agents/dev/.factory/uploads/a.txt"), "utf8")).toBe("hi\n");
});

// Review M3.
test("read never reads past the row's size", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  const r = await store.write(chunks(Buffer.from("abc\n")), { storedName: "a.txt", name: "a.txt" });
  if ("status" in r) throw new Error("refused");
  expect(await store.read(r.rel, { bytes: r.bytes, sha256: r.sha256 })).toEqual(
    Buffer.from("abc\n"),
  );
  expect(await store.read(r.rel, { bytes: r.bytes - 1, sha256: r.sha256 })).toBeUndefined();
});

// Review M2.
test("sweepFiles deletes unreferenced old upload files and stale temp files, regular files only", async () => {
  const wd = tmp("wd-");
  const store = await UploadStore.open(wd);
  await store.ensureDir();
  const { utimesSync } = await import("node:fs");
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const old = new Date(Date.now() - 48 * 3_600_000);
  const files = {
    orphan: `20261120-${id(1)}-a.txt`,
    known: `20261120-${id(2)}-b.txt`,
    fresh: `20261122-${id(3)}-c.txt`,
    tmpOld: `.tmp-${id(4)}`,
    foreign: "notes.txt",
  };
  for (const f of Object.values(files)) writeFileSync(path.join(uploadsOf(wd), f), "x");
  for (const f of [files.orphan, files.known, files.tmpOld, files.foreign])
    utimesSync(path.join(uploadsOf(wd), f), old, old);
  const secret = path.join(tmp("secret-"), "key");
  writeFileSync(secret, "secret");
  symlinkSync(secret, path.join(uploadsOf(wd), `20261120-${id(5)}-link.txt`));
  const n = await store.sweepFiles({
    known: new Set([id(2)]),
    orphanBefore: new Date(Date.now() - 24 * 3_600_000),
    tmpBefore: new Date(Date.now() - 3_600_000),
  });
  expect(n).toBe(2);
  expect(readdirSync(uploadsOf(wd)).sort()).toEqual(
    [files.known, files.fresh, files.foreign, `20261120-${id(5)}-link.txt`].sort(),
  );
  expect(readFileSync(secret, "utf8")).toBe("secret");
});

// Review m1 (PR5 final).
test("remove and the file sweep refuse an uploads folder swapped between the walk and the unlink", async () => {
  const wd = tmp("wd-");
  const outside = tmp("outside-");
  const { renameSync } = await import("node:fs");
  const name = "20261120-00000000-0000-4000-8000-000000000001-a.txt";
  mkdirSync(path.join(outside, "uploads"));
  writeFileSync(path.join(outside, "uploads", name), "victim");
  let swapped = false;
  const swap = async () => {
    if (swapped) return;
    swapped = true;
    renameSync(path.join(wd, ".factory"), path.join(wd, ".factory-moved"));
    symlinkSync(outside, path.join(wd, ".factory"));
  };
  const store = await UploadStore.open(wd, { beforeUnlink: swap });
  await store.ensureDir();
  writeFileSync(path.join(uploadsOf(wd), name), "mine");
  await expect(store.remove(`.factory/uploads/${name}`)).rejects.toBeInstanceOf(UnsafePathError);
  expect(readFileSync(path.join(outside, "uploads", name), "utf8")).toBe("victim");

  const wd2 = tmp("wd-");
  swapped = false;
  const sweeper = await UploadStore.open(wd2, {
    beforeUnlink: async () => {
      if (swapped) return;
      swapped = true;
      renameSync(path.join(wd2, ".factory"), path.join(wd2, ".factory-moved"));
      symlinkSync(outside, path.join(wd2, ".factory"));
    },
  });
  await sweeper.ensureDir();
  const { utimesSync } = await import("node:fs");
  writeFileSync(path.join(uploadsOf(wd2), name), "orphan");
  const old = new Date(Date.now() - 48 * 3_600_000);
  utimesSync(path.join(uploadsOf(wd2), name), old, old);
  expect(
    await sweeper.sweepFiles({
      known: new Set(),
      orphanBefore: new Date(Date.now() - 24 * 3_600_000),
      tmpBefore: new Date(),
    }),
  ).toBe(0);
  expect(readFileSync(path.join(outside, "uploads", name), "utf8")).toBe("victim");
});
