import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One namespace for agent slugs and user handles: a handle is claimed once, by an agent or a user. */
export const handles = pgTable(
  "handles",
  {
    handle: text("handle").primaryKey(),
    kind: text("kind").notNull().$type<"agent" | "user">(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("handles_kind", sql`${t.kind} IN ('agent','user')`)],
);
