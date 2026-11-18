import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import { EventStore } from "./event-store.ts";
import { agentConfigDir, agentWorkdir } from "./runtime-spec.ts";

// Dev tooling for the S3 walking skeleton. S4 (templates and agent creation) deletes this file.
export const DEV_SLUG = "dev";
const AGENTS_MD = `# Dev agent

You are the dev agent of an Open Factory walking skeleton. Messages reach you wrapped in
<factory-message> envelopes; the \`from\` attribute says who wrote them. Reply in plain text.
`;

export async function seedDevAgent(db: Db, config: Config): Promise<AgentRow> {
  const work = agentWorkdir(config, DEV_SLUG);
  await mkdir(agentConfigDir(config, DEV_SLUG), { recursive: true });
  if (!existsSync(path.join(work, "AGENTS.md")))
    await writeFile(path.join(work, "AGENTS.md"), AGENTS_MD);
  await db
    .insert(schema.agents)
    .values({
      id: randomUUID(),
      slug: DEV_SLUG,
      displayName: "Dev agent",
      description: "The S3 walking-skeleton agent",
    })
    .onConflictDoNothing({ target: schema.agents.slug });
  const [row] = await db.select().from(schema.agents).where(eq(schema.agents.slug, DEV_SLUG));
  if (!row) throw new Error("seed failed");
  return row;
}

/** Only while the server is stopped: the server is the only writer of an agent's events. */
export async function resetDevSession(db: Db, config: Config): Promise<void> {
  const row = await seedDevAgent(db, config);
  await db
    .update(schema.agents)
    .set({ sessionId: null, status: "hibernated" })
    .where(eq(schema.agents.id, row.id));
  await new EventStore(db).append(row.id, null, { type: "session_reset", by: "seed script" });
}
