/** Postgres error code anywhere on the error or its cause chain (Drizzle wraps driver errors). */
export function pgCode(e: unknown, code: string): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x)
    if (x.code === code) return true;
  return false;
}

/** `@a, @b`: how API messages name agents. */
export const tags = (slugs: string[]) => slugs.map((s) => `@${s}`).join(", ");

/** A foreign key blocked the statement: ON DELETE RESTRICT reports 23001, a plain FK 23503. */
export const fkViolation = (e: unknown) => pgCode(e, "23001") || pgCode(e, "23503");
