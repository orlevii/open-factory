import { parseArgs } from "node:util";
import {
  ApiError,
  apiFetch,
  buildStreamLineSchema,
  type ImageItem,
  imagesListSchema,
} from "@open-factory/shared";
import { guardedFetch } from "../client.ts";
import type { Io } from "../commands.ts";
import { readConfig, resolveTarget } from "../config-store.ts";

const USAGE = "Usage: open-factory images [build <name>|--all] [--no-pull]";

function table(items: ImageItem[]): string[] {
  const rows = [
    ["NAME", "STATUS", "BUILT", "USED BY"],
    ...items.map((i) => [i.name, i.status, i.builtAt ?? "-", i.usedBy.join(", ") || "-"]),
  ];
  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => (r[c] as string).length)));
  return rows.map((r) =>
    r
      .map((cell, c) => (c < 3 ? cell.padEnd(widths[c] as number) : cell))
      .join("  ")
      .trimEnd(),
  );
}

/** Streams one build; resolves true on a final `succeeded`. */
async function build(
  name: string,
  pull: boolean,
  ctx: { url: string; token: string; fetchImpl: typeof fetch },
  io: Io,
): Promise<boolean> {
  const res = await ctx.fetchImpl(`${ctx.url}/api/images/${encodeURIComponent(name)}/build`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "content-type": "application/json",
      accept: "application/x-ndjson",
    },
    body: JSON.stringify({ pull }),
  });
  if (!res.ok || !res.body) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: { message?: string } };
      message = d.error?.message ?? message;
    } catch {}
    io.err(`Build of ${name} failed: ${message}`);
    return false;
  }
  let final: { state: "succeeded" | "failed"; error?: string } | undefined;
  const handle = (raw: string) => {
    if (!raw.trim()) return;
    const msg = buildStreamLineSchema.parse(JSON.parse(raw));
    if ("line" in msg) io.out(msg.line);
    else final = msg;
  };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  handle(buf + decoder.decode());
  if (final?.state === "succeeded") {
    io.out(`Built ${name}`);
    return true;
  }
  io.err(`Build of ${name} failed: ${final?.error ?? "the stream ended without a result"}`);
  return false;
}

export async function images(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== undefined && sub !== "build") {
    io.err(USAGE);
    return 2;
  }
  const { values, positionals: names } = parseArgs({
    args: rest,
    options: { all: { type: "boolean" }, "no-pull": { type: "boolean" } },
    allowPositionals: true,
  });
  const building = sub === "build";
  if (!building ? rest.length > 0 : values.all ? names.length > 0 : names.length !== 1) {
    io.err(USAGE);
    return 2;
  }
  const { url, token } = resolveTarget(io.env, await readConfig(io.env));
  if (!token) {
    io.err("Not logged in. Run: open-factory login");
    return 1;
  }
  const fetchImpl = guardedFetch(io.fetch, url);
  let list: Awaited<ReturnType<typeof fetchList>>;
  try {
    list = await fetchList();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      io.err("Not logged in. Run: open-factory login");
      return 1;
    }
    throw e;
  }
  function fetchList() {
    return apiFetch("/api/images", { baseUrl: url, token, schema: imagesListSchema, fetchImpl });
  }
  if (!building) {
    io.out(list.images.length ? table(list.images).join("\n") : `No images in ${list.imagesDir}`);
    return 0;
  }
  const targets = values.all
    ? list.images.filter((i) => i.status !== "built").map((i) => i.name)
    : names;
  const ctx = { url, token, fetchImpl };
  let failed = false;
  for (const name of targets) {
    if (!(await build(name, values["no-pull"] !== true, ctx, io))) failed = true;
  }
  return failed ? 1 : 0;
}
