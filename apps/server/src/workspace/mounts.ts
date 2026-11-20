import type { Mount } from "@open-factory/harness";

export function buildMounts(i: {
  workdir: string;
  grantedPaths: string[];
  hostSkillPaths: string[];
  tplSettings: Record<string, unknown>;
}): Mount[] {
  const all: Mount[] = [
    { source: i.workdir, target: i.workdir, readOnly: false },
    ...i.grantedPaths.map((p) => ({ source: p, target: p, readOnly: false })),
    ...i.hostSkillPaths.map((p) => ({ source: p, target: p, readOnly: true })),
  ];
  const mk = i.tplSettings.extraKnownMarketplaces;
  if (mk && typeof mk === "object" && !Array.isArray(mk)) {
    for (const entry of Object.values(mk as Record<string, unknown>)) {
      const src = (entry as { source?: { source?: unknown; path?: unknown } } | null)?.source;
      if (src?.source === "directory" && typeof src.path === "string")
        all.push({ source: src.path, target: src.path, readOnly: true });
    }
  }
  const seen = new Set<string>();
  return all.filter((m) => {
    if (seen.has(m.target)) return false;
    seen.add(m.target);
    return true;
  });
}
