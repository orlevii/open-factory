export type KeyPrefix = "T" | "S";

/** "S-3", "s-3" and "3" all mean 3; the other prefix, zero and non-numbers are null. */
export function parseKey(prefix: KeyPrefix, raw: string): number | null {
  const m = new RegExp(`^(?:${prefix}-)?([1-9][0-9]{0,8})$`, "i").exec(raw.trim());
  return m ? Number(m[1]) : null;
}

export const formatKey = (prefix: KeyPrefix, n: number) => `${prefix}-${n}`;
