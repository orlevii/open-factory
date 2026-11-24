import type { SkillGroupsResponse } from "@open-factory/shared";

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
  update: false,
  checkFailed: false,
  checkedAt: null,
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
