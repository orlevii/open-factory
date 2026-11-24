import { type Db, schema } from "@open-factory/db";
import { type ConfigDoc, type PolicyPlugins, pinOf } from "@open-factory/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { LibraryIndex } from "../library/library-index.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the agent policy and the local-runtime rule read from the database and the Library (spec §6.1, §6.2 rule 8). */
export class PolicyInputs {
  constructor(
    private readonly d: {
      db: Db;
      library: Pick<LibraryIndex, "marketplaces" | "catalogAt">;
    },
  ) {}

  /** The ready registry rows, plus the catalog at every pin the given docs declare (`after`, and `declaredBy` for overlays). */
  async plugins(docs: ConfigDoc[]): Promise<PolicyPlugins> {
    const rows = new Map(
      (await this.d.library.marketplaces())
        .filter((r) => r.state === "ready")
        .map((r) => [r.name, r]),
    );
    const catalogs = new Map<string, ReadonlySet<string>>();
    for (const doc of docs) {
      const declared = doc.settings.extraKnownMarketplaces;
      if (!isRec(declared)) continue;
      for (const [name, decl] of Object.entries(declared)) {
        const row = rows.get(name);
        if (!row) continue;
        const pin = pinOf(decl);
        const ref = pin.kind === "commit" ? pin.sha : pin.kind === "tag" ? pin.name : "";
        const key = `${name}@${ref}`;
        if (catalogs.has(key)) continue;
        const entries = await this.d.library.catalogAt(row, ref === "" ? undefined : ref);
        if (entries) catalogs.set(key, new Set(entries.map((e) => e.name)));
      }
    }
    return { marketplaces: rows, catalogs };
  }

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
