import type { MarketplaceRow } from "@open-factory/db";
import type { MarketplacesStore } from "../marketplaces-service.ts";

/** An in-memory `MarketplacesStore` for tests that run the rules without Postgres. */
export function memoryMarketplacesStore(): MarketplacesStore {
  const rows = new Map<string, MarketplaceRow>();
  return {
    all: async () => [...rows.values()].sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime()),
    insert: async (row) => {
      if (rows.has(row.name)) throw new Error("duplicate key");
      rows.set(row.name, { ...row });
    },
    update: async (name, patch) => {
      const cur = rows.get(name);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      rows.set(name, next);
      return { ...next };
    },
    delete: async (name) => {
      rows.delete(name);
    },
  };
}
