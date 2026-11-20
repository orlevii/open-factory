import { type Db, schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { EventStore } from "./event-store.ts";

/** Only while the server is stopped: the server is the only writer of an agent's events. */
export async function resetSession(db: Db, slug: string): Promise<void> {
  const [row] = await db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!row) throw new Error(`No agent named ${slug}`);
  await db
    .update(schema.agents)
    .set({ sessionId: null, status: "hibernated" })
    .where(eq(schema.agents.id, row.id));
  await new EventStore(db).append(row.id, null, {
    type: "session_reset",
    by: "reset-session script",
  });
}
