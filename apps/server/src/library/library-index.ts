/**
 * The Library's skills, discovered live on every call (spec §5.2, §5.3): host, registered sources,
 * template-local folders, and names that resolve nowhere. No cache, no watcher.
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type Db, type SkillSourceRow, schema } from "@open-factory/db";
import {
  type AgentOverlay,
  type ConfigDoc,
  HOST_SKILL_PATTERN,
  type skillGroupSchema,
} from "@open-factory/shared";
import { and, asc, isNull } from "drizzle-orm";
import type { z } from "zod";
import { readSkillMd } from "./skill-md.ts";

export type SkillGroup = z.infer<typeof skillGroupSchema>;
type SkillRow = SkillGroup["skills"][number];

export type ResolveFail = "not_added" | "missing" | "unusable";
export type Resolved =
  | { ok: true; name: string; dir: string; ref: string }
  | { ok: false; reason: ResolveFail; detail?: string };

/**
 * What the Library reads from the template side. `TemplateIndex` validates through the Library, so this
 * is a lazy port wired in app.ts once both exist.
 */
export interface TemplatesPort {
  /** Every template's name. */
  names(): Promise<string[]>;
  /** The real folder names under a valid template's `skills/` (empty for an invalid template). */
  localSkillsOf(name: string): Promise<string[]>;
  /** The last parse without errors, from the database. */
  lastValid(name: string): Promise<ConfigDoc | null>;
}

export interface AgentUse {
  slug: string;
  template: string;
  config: AgentOverlay;
}

/** The database reads, behind a seam so the rules run without Postgres. */
export interface LibraryStore {
  /** Live (not soft-deleted) skill sources, oldest first. */
  sources(): Promise<SkillSourceRow[]>;
  /** Non-archived, non-terminated agents. */
  agents(): Promise<AgentUse[]>;
}

export function dbStore(db: Pick<Db, "select">): LibraryStore {
  return {
    sources: () =>
      db
        .select()
        .from(schema.skillSources)
        .where(isNull(schema.skillSources.deletedAt))
        .orderBy(asc(schema.skillSources.addedAt)),
    agents: () =>
      db
        .select({
          slug: schema.agents.slug,
          template: schema.agents.template,
          config: schema.agents.config,
        })
        .from(schema.agents)
        .where(and(isNull(schema.agents.archivedAt), isNull(schema.agents.terminatedAt))),
  };
}

/** What one skill folder is, before it is placed in a group. */
type Found = {
  state: "ok" | "missing" | "unusable";
  detail?: string;
  dir: string;
  description: string;
};

const isDir = async (p: string) => (await stat(p).catch(() => undefined))?.isDirectory() ?? false;

/** The rules every live skill folder meets: SKILL.md present, its name equals the folder's, no `.claude-plugin/`. */
async function inspect(name: string, dir: string, missing = "Missing"): Promise<Found> {
  const md = await readSkillMd(dir);
  if (!md) return { state: "missing", detail: missing, dir, description: "" };
  const description = md.description ?? "";
  if (md.name !== undefined && md.name !== name) {
    return { state: "unusable", detail: `SKILL.md names it ${md.name}`, dir, description };
  }
  if (await isDir(path.join(dir, ".claude-plugin"))) {
    return {
      state: "unusable",
      detail: "It's a plugin; add it through a marketplace",
      dir,
      description,
    };
  }
  return { state: "ok", dir, description };
}

const sourceLabel = (s: SkillSourceRow) => (s.kind === "github" ? (s.repo ?? "") : (s.path ?? ""));

export class LibraryIndex {
  private readonly store: LibraryStore;
  private readonly hostSkillsDir: string;
  private readonly factoryHome: string;
  private readonly templates: () => TemplatesPort;

  constructor(d: {
    db: Db;
    /** Test seam: the database reads; `dbStore(db)` when absent. */
    store?: LibraryStore;
    hostClaudeDir: string;
    factoryHome: string;
    templates: () => TemplatesPort;
  }) {
    this.store = d.store ?? dbStore(d.db);
    this.hostSkillsDir = path.join(d.hostClaudeDir, "skills");
    this.factoryHome = d.factoryHome;
    this.templates = d.templates;
  }

  /** The host skills: directories (links followed) with a SKILL.md and a valid name, sorted. */
  private async hostNames(): Promise<string[]> {
    const out: string[] = [];
    for (const n of (await readdir(this.hostSkillsDir).catch(() => [] as string[])).sort()) {
      if (!HOST_SKILL_PATTERN.test(n)) continue;
      if (await readSkillMd(path.join(this.hostSkillsDir, n))) out.push(n);
    }
    return out;
  }

  private async host(name: string): Promise<Found> {
    const dir = await realpath(path.join(this.hostSkillsDir, name)).catch(() => undefined);
    return dir
      ? inspect(name, dir)
      : { state: "missing", detail: "Missing", dir: "", description: "" };
  }

  /** One picked skill of a registered source, with its ref. */
  private async registered(s: SkillSourceRow, name: string): Promise<Found & { ref: string }> {
    if (s.kind === "folder") {
      const root = s.path ?? "";
      const oneSkill = (await readSkillMd(root)) !== null;
      const dir = oneSkill ? root : path.join(root, name);
      // Edits inside a picked skill are live, but the pick itself must still be a real folder.
      const st = await lstat(dir).catch(() => undefined);
      if (!st) return { state: "missing", detail: "Missing", dir, description: "", ref: "folder" };
      if (st.isSymbolicLink()) {
        return { state: "unusable", detail: "It's a link", dir, description: "", ref: "folder" };
      }
      return { ...(await inspect(name, dir)), ref: "folder" };
    }
    const sha = s.commit ?? "";
    const root = path.join(this.factoryHome, "state", "library", "github", s.id, sha);
    const ref = `github:${sha}`;
    if (!(await isDir(root))) {
      return { state: "missing", detail: "Fetch again", dir: root, description: "", ref };
    }
    const dir = (await readSkillMd(root)) ? root : path.join(root, name);
    return { ...(await inspect(name, dir, "Fetch again")), ref };
  }

  async resolveSkill(name: string): Promise<Resolved> {
    for (const s of await this.store.sources()) {
      if (s.state !== "ready" || !s.skills.includes(name)) continue;
      const f = await this.registered(s, name);
      if (f.state !== "ok") return { ok: false, reason: f.state, detail: f.detail };
      const dir = await realpath(f.dir).catch(() => undefined);
      if (!dir) return { ok: false, reason: "missing", detail: f.detail };
      return { ok: true, name, dir, ref: f.ref };
    }
    if (
      !(HOST_SKILL_PATTERN.test(name) && (await readSkillMd(path.join(this.hostSkillsDir, name))))
    ) {
      return { ok: false, reason: "not_added" };
    }
    const f = await this.host(name);
    if (f.state !== "ok") return { ok: false, reason: f.state, detail: f.detail };
    return { ok: true, name, dir: f.dir, ref: "host" };
  }

  /** Who lists each name: template names and agent slugs, by effective skills. */
  private async usage(): Promise<Map<string, { templates: Set<string>; agents: Set<string> }>> {
    const port = this.templates();
    const listed = new Map<string, string[]>();
    for (const t of await port.names()) {
      const skills = (await port.lastValid(t))?.template.skills;
      if (Array.isArray(skills))
        listed.set(
          t,
          skills.filter((x): x is string => typeof x === "string"),
        );
    }
    const out = new Map<string, { templates: Set<string>; agents: Set<string> }>();
    const of = (n: string) => {
      const have = out.get(n);
      if (have) return have;
      const fresh = { templates: new Set<string>(), agents: new Set<string>() };
      out.set(n, fresh);
      return fresh;
    };
    for (const [t, skills] of listed) for (const n of skills) of(n).templates.add(t);
    for (const a of await this.store.agents()) {
      const effective = a.config.template?.skills ?? listed.get(a.template) ?? [];
      for (const n of effective) of(n).agents.add(a.slug);
    }
    return out;
  }

  async usedBy(name: string): Promise<{ templates: string[]; agents: string[] }> {
    const u = (await this.usage()).get(name);
    return { templates: [...(u?.templates ?? [])].sort(), agents: [...(u?.agents ?? [])].sort() };
  }

  async skills(): Promise<SkillGroup[]> {
    const usage = await this.usage();
    const usedBy = (n: string) => ({
      templates: usage.get(n)?.templates.size ?? 0,
      agents: usage.get(n)?.agents.size ?? 0,
    });
    const none = { templates: 0, agents: 0 };
    const row = (name: string, f: Found, hidden?: string, local = false): SkillRow => ({
      name,
      description: f.description,
      state: hidden ? "hidden" : f.state,
      ...(hidden ? { stateDetail: hidden } : f.detail ? { stateDetail: f.detail } : {}),
      // A template-local skill is not in the Library namespace, so a same-named entry's users aren't its users.
      usedBy: local ? none : usedBy(name),
    });

    const sources = await this.store.sources();
    const registeredBy = new Map<string, SkillSourceRow>();
    for (const s of sources)
      for (const n of s.skills) if (!registeredBy.has(n)) registeredBy.set(n, s);

    const known = new Set<string>(registeredBy.keys());
    const groups: SkillGroup[] = [];

    const hostRows: SkillRow[] = [];
    for (const n of await this.hostNames()) {
      known.add(n);
      const s = registeredBy.get(n);
      hostRows.push(row(n, await this.host(n), s && `the name is used by ${sourceLabel(s)}`));
    }
    groups.push({ group: "host", kind: "host", skills: hostRows });

    for (const s of sources) {
      const rows: SkillRow[] = [];
      if (s.state === "ready") {
        for (const n of s.skills) rows.push(row(n, await this.registered(s, n)));
      }
      groups.push({
        group: `source:${s.id}`,
        kind: "source",
        source: {
          id: s.id,
          kind: s.kind,
          path: s.path,
          repo: s.repo,
          subpath: s.subpath,
          branch: s.branch,
          pin: s.commit,
          state: s.state,
          skillCount: s.skills.length,
        },
        skills: rows,
      });
    }

    const port = this.templates();
    for (const t of await port.names()) {
      const rows: SkillRow[] = [];
      for (const n of (await port.localSkillsOf(t)).sort()) {
        rows.push(
          row(
            n,
            await inspect(n, path.join(this.factoryHome, "templates", t, "skills", n)),
            undefined,
            true,
          ),
        );
      }
      if (rows.length > 0) {
        groups.push({ group: `template:${t}`, kind: "template", template: t, skills: rows });
      }
    }

    const unknown = [...usage.keys()]
      .filter((n) => !known.has(n))
      .sort()
      .map((n) => row(n, { state: "missing", dir: "", description: "" }));
    if (unknown.length > 0) groups.push({ group: "unknown", kind: "unknown", skills: unknown });
    return groups;
  }
}
