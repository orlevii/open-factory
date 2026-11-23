/** Postgres error code anywhere on the error or its cause chain (Drizzle wraps driver errors). */
export function pgCode(e: unknown, code: string): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x)
    if (x.code === code) return true;
  return false;
}

/** `@a, @b`: how API messages name agents. */
export const tags = (slugs: string[]) => slugs.map((s) => `@${s}`).join(", ");

/**
 * A delete was blocked because something still uses the row: ON DELETE RESTRICT reports 23001, a plain FK 23503, and the
 * credential delete (`ON DELETE SET NULL` against the `agents_live_credential` CHECK) 23514.
 */
export const inUseViolation = (e: unknown) =>
  pgCode(e, "23001") || pgCode(e, "23503") || pgCode(e, "23514");

/** A unique violation on an agent's slug (the `agents.slug` index), as opposed to any other unique index. */
export function isSlugUnique(e: unknown): boolean {
  for (let x = e as { code?: string; constraint_name?: string; cause?: unknown } | undefined; x; ) {
    if (x.code === "23505" && (x.constraint_name ?? "").includes("slug")) return true;
    x = x.cause as typeof x;
  }
  return false;
}
