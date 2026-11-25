import { type Db, schema } from "@open-factory/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

/** What the agent policy and the local-runtime rule read from the database (spec §6.1, §6.2 rule 7). */
export class PolicyInputs {
  constructor(
    private readonly d: {
      db: Db;
    },
  ) {}

  /**
   * Each name's runtime from `templates.last_valid` (docker by default), in order. A name with no valid parse counts as
   * local: the policy fails closed. A database read only, so it never takes a template lock.
   */
  async templateRuntimes(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const found = await this.d.db
      .select({ name: schema.templates.name, doc: schema.templates.lastValid })
      .from(schema.templates)
      .where(inArray(schema.templates.name, names));
    const runtimeOf = new Map(
      found.map((r) => [
        r.name,
        r.doc
          ? typeof r.doc.template.runtime === "string"
            ? r.doc.template.runtime
            : "docker"
          : "local",
      ]),
    );
    return names.map((n) => runtimeOf.get(n) ?? "local");
  }

  /** Whether any non-terminated agent on the template (archived included) runs with the local runtime (R9). */
  async templateHasLocalAgents(name: string): Promise<boolean> {
    const [row] = await this.d.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.template, name),
          eq(schema.agents.runtime, "local"),
          isNull(schema.agents.terminatedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
