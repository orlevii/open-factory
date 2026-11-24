import type { SkillGroupsResponse } from "@open-factory/shared";
import type { MarketplacesResponse, PluginsResponse } from "@/lib/library";

type Group = SkillGroupsResponse["groups"][number];
type Skill = Group["skills"][number];
type SourceSummary = Extract<Group, { kind: "source" }>["source"];

export const skill = (name: string, o: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name} description`,
  state: "ok",
  usedBy: { templates: 0, agents: 0 },
  ...o,
});

export const source = (id: string, o: Partial<SourceSummary> = {}): SourceSummary => ({
  id,
  kind: "github",
  path: null,
  repo: `acme/${id}`,
  subpath: null,
  branch: "main",
  pin: "0123456789abcdef0123456789abcdef01234567",
  state: "ready",
  skillCount: 1,
  since: null,
  checking: null,
  update: false,
  checkFailed: false,
  ...o,
});

export const sourceGroup = (s: SourceSummary, skills: Skill[]): Group => ({
  group: `source:${s.id}`,
  kind: "source",
  source: s,
  skills,
});

export const hostGroup = (skills: Skill[] = []): Group => ({ group: "host", kind: "host", skills });

export const library = (groups: Group[], hostDir = "/home/me/.claude"): SkillGroupsResponse => ({
  hostDir,
  groups,
});

type PluginGroup = PluginsResponse["marketplaces"][number];
type PluginEntry = PluginGroup["plugins"][number];
type MarketplaceRow = MarketplacesResponse["marketplaces"][number];

export const NO_CONTENTS = {
  hooks: 0,
  mcp: 0,
  codeParts: 0,
  dependencies: 0,
  skills: 0,
  commands: 0,
  agents: 0,
  outputStyles: 0,
  needs: 0,
  unshown: 0,
};

/** A catalog entry `name@mkt`; a field in `o` replaces the default. */
export const plugin = (key: string, o: Partial<PluginEntry> = {}): PluginEntry => ({
  key,
  name: key.slice(0, key.lastIndexOf("@")),
  pinnable: true,
  state: "ok",
  contentsSummary: { ...NO_CONTENTS, skills: 1 },
  canRead: false,
  usedBy: { templates: [], overlays: [] },
  ...o,
});

export const pluginGroup = (
  name: string,
  commit: string | null,
  plugins: PluginEntry[],
  o: Partial<PluginGroup> = {},
): PluginGroup => ({ name, commit, state: "ready", plugins, ...o });

export const pluginsResponse = (
  marketplaces: PluginGroup[],
  host: PluginsResponse["host"] = [],
): PluginsResponse => ({ marketplaces, host });

export const marketplaceRow = (name: string, o: Partial<MarketplaceRow> = {}): MarketplaceRow => ({
  name,
  source: { source: "github", repo: `acme/${name}` },
  branch: "main",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  committedAt: "2026-11-20T10:00:00Z",
  subject: "Add the plugins",
  tags: {},
  state: "ready",
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  usedBy: { templates: 0, agents: 0 },
  plugins: [],
  users: { templates: [], agents: [] },
  ...o,
});
