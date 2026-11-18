import type { AnyEvent } from "@open-factory/shared";

export const CAP_BYTES = 64 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

/** Cut to at most CAP_BYTES of UTF-8 without splitting a code point. */
function cut(s: string): string {
  const bytes = enc.encode(s);
  let end = CAP_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--; // back off continuation bytes
  return dec.decode(bytes.subarray(0, end));
}

/** One rule for every event type (spec §6.4): any string over 64 KiB is cut and recorded by path. */
export function capPayload(event: AnyEvent): {
  payload: Record<string, unknown>;
  truncated?: Record<string, number>;
} {
  const truncated: Record<string, number> = {};
  const walk = (v: unknown, p: string): unknown => {
    if (typeof v === "string") {
      const n = enc.encode(v).length;
      if (n <= CAP_BYTES) return v;
      truncated[p] = n;
      return cut(v);
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}.${i}`));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x, p ? `${p}.${k}` : k)]),
      );
    return v;
  };
  const { type: _type, ...rest } = event;
  const payload = walk(rest, "") as Record<string, unknown>;
  return Object.keys(truncated).length ? { payload, truncated } : { payload };
}
