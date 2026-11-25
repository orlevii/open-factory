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
  type skillDetailSchema,
  type skillGroupSchema,
} from "@open-factory/shared";
import { and, asc, isNull } from "drizzle-orm";
import type { z } from "zod";
import { hostSkillsDirOf } from "../config.ts";
import { ApiError } from "../errors.ts";
import { listSkillFiles, readSkillFile, readSkillMdText } from "./skill-files.ts";
import { readSkillMd } from "./skill-md.ts";

export type SkillGroup = z.infer<typeof skillGroupSchema>;
export type SkillDetail = z.infer<typeof skillDetailSchema>;
type SkillRow = SkillGroup["skills"][number];

export type ResolveFail = "not_added" | "missing" | "unusable";
export type Resolved =
  | { ok: true; name: string; dir: string; ref: string }
  | { ok: false; reason: ResolveFail; detail?: string };

/** What a skill that doesn't resolve is called in a start or validation error (spec §6.6). */
export function skillProblem(name: string, fail: Extract<Resolved, { ok: false }>): string {
  if (fail.reason === "not_added") return `Skill ${name} hasn't been added in Skills.`;
  if (fail.reason === "missing") return `Skill ${name} is missing from its folder.`;
  return `Skill ${name} is unusable: ${fail.detail ?? "it can't be used"}.`;
}

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
export type Found = {
  state: "ok" | "missing" | "unusable";
  detail?: string;
  /** A GitHub cache with no code yet; the row says so for the page's Fetch again. */
  fetchAgain?: true;
  dir: string;
  description: string;
};

const isDir = async (p: string) => (await stat(p).catch(() => undefined))?.isDirectory() ?? false;

/** The rules every live skill folder meets: SKILL.md present, its name equals the folder's. */
export async function inspect(name: string, dir: string, missing = "Missing"): Promise<Found> {
  const md = await readSkillMd(dir);
  if (!md) return { state: "missing", detail: missing, dir, description: "" };
  const description = md.description ?? "";
  if (md.name !== undefined && md.name !== name) {
    return { state: "unusable", detail: `SKILL.md names it ${md.name}`, dir, description };
  }
  return { state: "ok", dir, description };
}

const sourceLabel = (s: SkillSourceRow) => (s.kind === "github" ? (s.repo ?? "") : (s.path ?? ""));

export class LibraryIndex {
  private readonly store: LibraryStore;
  private readonly hostSkillsDir: string;
  private readonly factoryHome: string;
  private readonly templates: () => TemplatesPort;
  private readonly checkingSince: (id: string) => string | undefined;

  constructor(d: {
    db: Db;
    /** Test seam: the database reads; `dbStore(db)` when absent. */
    store?: LibraryStore;
    hostClaudeDir: string;
    factoryHome: string;
    templates: () => TemplatesPort;
    /** When a check was queued for a source, while one is queued or running (the sources service's). */
    checkingSince?: (id: string) => string | undefined;
  }) {
    this.store = d.store ?? dbStore(d.db);
    this.hostSkillsDir = hostSkillsDirOf(d);
    this.factoryHome = d.factoryHome;
    this.templates = d.templates;
    this.checkingSince = d.checkingSince ?? (() => undefined);
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
      return {
        state: "missing",
        detail: "Fetch again",
        fetchAgain: true,
        dir: root,
        description: "",
        ref,
      };
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

  /**
   * Where a factory link to a Library skill can point (spec §6.4): the host skills folder and the real folder of each
   * host skill (a host entry may itself be a link), every folder source (as configured and as resolved), and the GitHub
   * cache root. The drop-unlisted pass of the link sync removes only links that point at or under one of these.
   */
  async linkPrefixes(): Promise<string[]> {
    const out = new Set<string>([this.hostSkillsDir]);
    const add = async (p: string) => {
      out.add(p);
      const real = await realpath(p).catch(() => undefined);
      if (real) out.add(real);
    };
    await add(this.hostSkillsDir);
    for (const n of await this.hostNames()) await add(path.join(this.hostSkillsDir, n));
    for (const s of await this.store.sources())
      if (s.kind === "folder" && s.path) await add(s.path);
    out.add(path.join(this.factoryHome, "state", "library", "github"));
    return [...out];
  }

  /** Who lists each name: template names and agent slugs, by effective skills. */
  private async usage(): Promise<
    Map<
      string,
      { templates: Set<string>; agents: Set<string>; agentsByTemplate: Map<string, number> }
    >
  > {
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
    const out = new Map<
      string,
      { templates: Set<string>; agents: Set<string>; agentsByTemplate: Map<string, number> }
    >();
    const of = (n: string) => {
      const have = out.get(n);
      if (have) return have;
      const fresh = {
        templates: new Set<string>(),
        agents: new Set<string>(),
        agentsByTemplate: new Map<string, number>(),
      };
      out.set(n, fresh);
      return fresh;
    };
    for (const [t, skills] of listed) for (const n of skills) of(n).templates.add(t);
    for (const a of await this.store.agents()) {
      // Overlay arrays union with the template's (config-merge), so an own skill never hides a template one.
      const effective = new Set([
        ...(listed.get(a.template) ?? []),
        ...(a.config.template?.skills ?? []),
      ]);
      for (const n of effective) {
        const u = of(n);
        u.agents.add(a.slug);
        u.agentsByTemplate.set(a.template, (u.agentsByTemplate.get(a.template) ?? 0) + 1);
      }
    }
    return out;
  }

  async usedBy(name: string): Promise<{ templates: string[]; agents: string[] }> {
    const u = (await this.usage()).get(name);
    return { templates: [...(u?.templates ?? [])].sort(), agents: [...(u?.agents ?? [])].sort() };
  }

  /** Who lists any of `names` (one usage pass): sorted template names and agent slugs, each once. */
  async usedByAny(names: string[]): Promise<{ templates: string[]; agents: string[] }> {
    const usage = await this.usage();
    const templates = new Set<string>();
    const agents = new Set<string>();
    for (const n of names) {
      for (const t of usage.get(n)?.templates ?? []) templates.add(t);
      for (const a of usage.get(n)?.agents ?? []) agents.add(a);
    }
    return { templates: [...templates].sort(), agents: [...agents].sort() };
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
      ...(!hidden && f.fetchAgain ? { fetchAgain: true } : {}),
      // A template-local skill is not in the Library namespace, so a same-named entry's users aren't its users.
      usedBy: local ? none : usedBy(name),
    });

    const sources = await this.store.sources();
    const registeredBy = new Map<string, SkillSourceRow>();
    const known = new Set<string>();
    for (const s of sources)
      for (const n of s.skills) {
        known.add(n);
        if (s.state === "ready" && !registeredBy.has(n)) registeredBy.set(n, s);
      }
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
      const checkingSince = this.checkingSince(s.id);
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
          since: s.state === "adding" ? s.startedAt.toISOString() : null,
          checking: checkingSince ? { since: checkingSince } : null,
          update: s.updateCommit !== null,
          checkFailed: s.checkError !== null,
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

  /**
   * The real folder of skill `name` in `group` (`host`, `source:<id>`, `template:<name>`), only when it is
   * usable: a missing, unusable or linked skill has none, so its files are never read.
   */
  private async dirOf(group: string, name: string): Promise<string | undefined> {
    let f: Found | undefined;
    if (group === "host") {
      if ((await this.hostNames()).includes(name)) f = await this.host(name);
    } else if (group.startsWith("source:")) {
      const s = (await this.store.sources()).find((x) => `source:${x.id}` === group);
      if (s?.state === "ready" && s.skills.includes(name)) f = await this.registered(s, name);
    } else if (group.startsWith("template:")) {
      const t = group.slice("template:".length);
      const port = this.templates();
      if ((await port.localSkillsOf(t)).includes(name)) {
        f = await inspect(name, path.join(this.factoryHome, "templates", t, "skills", name));
      }
    }
    if (f?.state !== "ok") return undefined;
    return realpath(f.dir).catch(() => undefined);
  }

  /** One skill with its files and `SKILL.md` (spec §9.1); a 404 when the group has no such skill. */
  async detail(group: string, name: string): Promise<SkillDetail> {
    const row = (await this.skills())
      .find((g) => g.group === group)
      ?.skills.find((r) => r.name === name);
    if (!row) throw new ApiError(404, "not_found", "Not found");
    const dir = await this.dirOf(group, name);
    // A template-local skill is outside the Library namespace: nobody "uses" it by name.
    const use = group.startsWith("template:") ? undefined : (await this.usage()).get(name);
    const templates = new Set([...(use?.templates ?? []), ...(use?.agentsByTemplate.keys() ?? [])]);
    const md = dir ? await readSkillMdText(dir) : { text: "", cut: false };
    return {
      ...row,
      group,
      hooks: dir ? ((await readSkillMd(dir))?.hooks ?? []) : [],
      usedByTemplates: [...templates]
        .sort()
        .map((t) => ({ name: t, agents: use?.agentsByTemplate.get(t) ?? 0 })),
      files: dir ? await listSkillFiles(dir) : [],
      skillMd: md.text,
      skillMdCut: md.cut,
    };
  }

  /** One text file of a usable skill (spec §9.1). */
  async fileText(group: string, name: string, rel: string): Promise<string> {
    const dir = await this.dirOf(group, name);
    if (!dir) throw new ApiError(404, "not_found", "Not found");
    return readSkillFile(dir, rel);
  }
}
