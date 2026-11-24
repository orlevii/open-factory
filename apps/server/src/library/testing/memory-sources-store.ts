import type { SkillSourceRow } from "@open-factory/db";
import type { SourcesStore } from "../sources-service.ts";

/** An in-memory `SourcesStore` for tests that run the rules without Postgres. */
export function memorySourcesStore(): SourcesStore {
  const rows = new Map<string, SkillSourceRow>();
  return {
    all: async () => [...rows.values()].sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime()),
    insert: async (row) => {
      rows.set(row.id, { ...row });
    },
    update: async (id, patch) => {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      rows.set(id, next);
      return { ...next };
    },
    delete: async (id) => {
      rows.delete(id);
    },
  };
}
