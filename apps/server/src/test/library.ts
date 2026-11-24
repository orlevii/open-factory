import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MarketplaceRow, SkillSourceRow } from "@open-factory/db";
import { LibraryIndex } from "../library/library-index.ts";

/** A ready folder source row holding the given picked skills. */
export function folderSource(dir: string, skills: string[]): SkillSourceRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "folder",
    path: dir,
    repo: null,
    subpath: "",
    branch: null,
    commit: null,
    committedAt: null,
    subject: null,
    trees: null,
    updateCommit: null,
    updateAt: null,
    updateSubject: null,
    checkedAt: null,
    checkError: null,
    skills,
    state: "ready",
    startedAt: new Date(0),
    addedBy: "@or",
    addedAt: new Date(0),
    deletedAt: null,
  };
}

/** A ready marketplace row at `commit` (none for a directory); `over` overrides any column. */
export function marketplaceRow(
  name: string,
  source: MarketplaceRow["source"],
  over: Partial<MarketplaceRow> = {},
): MarketplaceRow {
  return {
    name,
    source,
    branch: source.source === "directory" ? null : "main",
    commit: null,
    committedAt: null,
    subject: null,
    updateCommit: null,
    updateAt: null,
    updateSubject: null,
    checkedAt: null,
    checkError: null,
    tags: {},
    state: "ready",
    startedAt: new Date(0),
    addedBy: "@or",
    addedAt: new Date(0),
    deletedAt: null,
    ...over,
  };
}

/**
 * A Library over the host's skills and the given sources (no agents, no templates), for tests that need no database
 * of their own.
 */
export function hostOnlyLibrary(
  hostClaudeDir: string,
  factoryHome: string,
  sources: SkillSourceRow[] = [],
  marketplaces: MarketplaceRow[] = [],
): LibraryIndex {
  return new LibraryIndex({
    db: undefined as never,
    store: {
      sources: async () => sources,
      agents: async () => [],
      marketplaces: async () => marketplaces,
    },
    hostClaudeDir,
    factoryHome,
    templates: () => ({
      names: async () => [],
      localSkillsOf: async () => [],
      lastValid: async () => null,
    }),
  });
}

/** `<hostClaudeDir>/skills/<name>/SKILL.md`, the minimum the Library accepts as a host skill. */
export function writeHostSkill(hostClaudeDir: string, name: string, extra = ""): string {
  const dir = path.join(hostClaudeDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n${extra}---\n# ${name}\n`,
  );
  return dir;
}
