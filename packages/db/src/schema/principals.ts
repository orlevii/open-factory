import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Every agent and human is a principal: a stable id, an 8-char ref derived from it, and a changeable handle.
 * `agents.id` and `users.id` reference it, so a handle is held by exactly one principal (spec §4.1).
 */
export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().$type<"agent" | "human">(),
    handle: text("handle").notNull(),
    ref: text("ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("principals_handle_unique").on(t.handle),
    uniqueIndex("principals_ref_unique").on(t.ref),
    check("principals_kind", sql`${t.kind} IN ('agent','human')`),
  ],
);
