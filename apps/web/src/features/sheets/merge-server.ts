const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A refreshed server copy: a field the user changed (differs from the previous base) is kept, the rest follow the server. */
export function mergeServer<T extends Record<string, unknown>>(prev: T, prevBase: T, server: T): T {
  const out = { ...prev };
  for (const k of Object.keys(server) as (keyof T)[])
    if (same(prev[k], prevBase[k])) out[k] = server[k];
  return out;
}
