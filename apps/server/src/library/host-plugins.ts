/**
 * Plugins installed on the host (spec §7.6): `<FACTORY_HOST_CLAUDE_DIR>/plugins/installed_plugins.json` and
 * `known_marketplaces.json`, read with `lstat` and a size cap, and nothing else outside the confined contents read.
 * The only action is Add its marketplace: the host's own record of the marketplace's source goes through the §7.1
 * input rules, then through the ordinary preview and add. Nothing is installed, copied or linked out of the host.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  checkGitUrl,
  isHostPathShape,
  normalizeRepo,
  PLUGIN_REF_PATTERN,
} from "@open-factory/shared";
import { ApiError } from "../errors.ts";
import { isRecord } from "./common.ts";
import { checkSkillFolder, type ForbiddenContext } from "./forbidden.ts";
import type {
  MarketplaceBody,
  MarketplaceDetail,
  MarketplacePreview,
} from "./marketplaces-service.ts";
import { type PluginContents, readContents } from "./plugin-contents.ts";

const MAX_BYTES = 256 * 1024;
const MAX_KEYS = 500;

export const HOST_MSG = {
  outside: "Can't show: outside the host's plugin folder.",
  missing: "Can't show: the host's copy is missing.",
  unreadable: "Can't show: the host's copy can't be read.",
  recordUnusable: (mkt: string, reason: string) =>
    `The host's record for ${mkt} can't be used: ${reason}.`,
  noRecord: "the host has no record of it",
  notFound: "Not on this host.",
} as const;

/** One plugin as the host lists it: the newest install of its key. */
export interface HostPluginEntry {
  key: string;
  name: string;
  marketplace: string;
  version: string | null;
  lastUpdated: string | null;
  installPath: string;
}

/** An entry with what the factory may show of it: its contents, or why not; and whether its marketplace can be added. */
export interface HostPluginListing extends HostPluginEntry {
  contents: PluginContents | null;
  cantShow?: string;
  addRefusedReason?: string;
}

export interface HostPluginsDeps {
  /** `FACTORY_HOST_CLAUDE_DIR`. */
  hostClaudeDir: string;
  /** The names of the registered (live) marketplaces. */
  registered: () => Promise<string[]>;
  marketplaces: {
    preview(b: MarketplaceBody): Promise<MarketplacePreview>;
    add(
      previewId: string,
      by: string,
    ): Promise<{ status: 201 | 202; marketplace: MarketplaceDetail }>;
  };
  /** Folders a host directory marketplace may not name (the §6.1 list), so its root can't widen the confined read. */
  forbidden: ForbiddenContext;
  log?: (message: string, err: unknown) => void;
}

/** A regular file of at most 256 KB, parsed; undefined for anything else (a link, a big file, bad JSON). */
async function readJson(file: string): Promise<unknown> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

const insideOf = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const time = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
};

type Verdict = { ok: true; body: MarketplaceBody } | { ok: false; reason: string };

/**
 * The host's record of one marketplace through the §7.1 input rules: `github`, `git` (https only, no userinfo,
 * query or fragment) or `directory`, and no `ref` or `path` beside them.
 */
export function hostSourceVerdict(record: unknown): Verdict {
  const src = isRecord(record) && isRecord(record.source) ? record.source : undefined;
  if (!src) return { ok: false, reason: "it has no source" };
  const kind = src.source;
  const own = kind === "github" ? "repo" : kind === "git" ? "url" : "path";
  const allowed = new Set(["source", own]);
  for (const key of Object.keys(src)) {
    if (allowed.has(key)) continue;
    if (key === "ref") return { ok: false, reason: "its source has a ref" };
    if (key === "path") return { ok: false, reason: "its source has a path" };
    return { ok: false, reason: "its source has options Open Factory doesn't use" };
  }
  if (kind === "github") {
    const repo = str(src.repo);
    return repo && normalizeRepo(repo)
      ? { ok: true, body: { kind: "github", repo } }
      : { ok: false, reason: "its repo isn't owner/repo" };
  }
  if (kind === "git") {
    const url = str(src.url);
    if (url === null || !url.startsWith("https://")) {
      return { ok: false, reason: "its URL isn't an https URL" };
    }
    return checkGitUrl(url)
      ? { ok: true, body: { kind: "git", url } }
      : { ok: false, reason: "its URL has credentials, a query or a fragment" };
  }
  if (kind === "directory") {
    const dir = str(src.path);
    return dir && isHostPathShape(dir)
      ? { ok: true, body: { kind: "directory", path: dir } }
      : { ok: false, reason: "its folder isn't an absolute path" };
  }
  return { ok: false, reason: "its source type isn't supported" };
}

export class HostPlugins {
  constructor(private readonly d: HostPluginsDeps) {}

  private get pluginsDir(): string {
    return path.join(this.d.hostClaudeDir, "plugins");
  }

  /** `known_marketplaces.json`: the marketplace names the host knows, with their records. */
  private async known(): Promise<Record<string, unknown>> {
    const doc = await readJson(path.join(this.pluginsDir, "known_marketplaces.json"));
    return isRecord(doc) ? doc : {};
  }

  /** Every distinct key of `installed_plugins.json` (`{ version: 2, plugins: { key: [install] } }`), newest install each. */
  private async all(): Promise<HostPluginEntry[]> {
    const doc = await readJson(path.join(this.pluginsDir, "installed_plugins.json"));
    const plugins = isRecord(doc) && isRecord(doc.plugins) ? doc.plugins : {};
    const out: HostPluginEntry[] = [];
    for (const [key, installs] of Object.entries(plugins).slice(0, MAX_KEYS)) {
      if (!PLUGIN_REF_PATTERN.test(key) || !Array.isArray(installs)) continue;
      let newest: Record<string, unknown> | undefined;
      for (const i of installs) {
        if (!isRecord(i) || typeof i.installPath !== "string") continue;
        if (!newest || time(i.lastUpdated) >= time(newest.lastUpdated)) newest = i;
      }
      if (!newest) continue;
      const at = key.lastIndexOf("@");
      out.push({
        key,
        name: key.slice(0, at),
        marketplace: key.slice(at + 1),
        version: str(newest.version),
        lastUpdated: str(newest.lastUpdated),
        installPath: newest.installPath as string,
      });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * The real folder of an entry's contents: inside `realpath(<hostdir>/plugins/cache)` or a host directory
   * marketplace. A reason otherwise.
   */
  private async confined(
    e: HostPluginEntry,
    known: Record<string, unknown>,
  ): Promise<{ dir: string } | { cantShow: string }> {
    const real = await realpath(e.installPath).catch(() => undefined);
    if (!real) return { cantShow: HOST_MSG.missing };
    const roots: string[] = [];
    const cache = await realpath(path.join(this.pluginsDir, "cache")).catch(() => undefined);
    if (cache) roots.push(cache);
    const record = known[e.marketplace];
    const src = isRecord(record) && isRecord(record.source) ? record.source : undefined;
    if (src?.source === "directory" && typeof src.path === "string" && isHostPathShape(src.path)) {
      const folder = await realpath(src.path).catch(() => undefined);
      // `/`, the home and its ancestors, the factory's folders: the same refusals as a skill folder.
      const ok =
        folder &&
        (await checkSkillFolder(folder, this.d.forbidden).then(
          () => true,
          () => false,
        ));
      if (folder && ok) roots.push(folder);
    }
    return roots.some((r) => insideOf(r, real)) ? { dir: real } : { cantShow: HOST_MSG.outside };
  }

  /** The versions of every host key, registered marketplaces included ("Also on this host (1.2.0)"). */
  async versions(): Promise<Map<string, string | null>> {
    return new Map((await this.all()).map((e) => [e.key, e.version]));
  }

  private async show(
    entry: HostPluginEntry,
    known: Record<string, unknown>,
  ): Promise<{ dir: string | null; contents: PluginContents | null; note?: string }> {
    const at = await this.confined(entry, known);
    if ("cantShow" in at) return { dir: null, contents: null, note: at.cantShow };
    try {
      return { dir: at.dir, contents: await readContents(at.dir) };
    } catch (e) {
      this.d.log?.(`reading host plugin ${entry.key} failed`, e);
      return { dir: at.dir, contents: null, note: HOST_MSG.unreadable };
    }
  }

  /** One host entry, its confined folder or the reason there is none, and its contents; undefined when the key isn't on the host. */
  async entry(
    key: string,
  ): Promise<
    | { entry: HostPluginEntry; dir: string | null; contents: PluginContents | null; note?: string }
    | undefined
  > {
    const entry = (await this.all()).find((e) => e.key === key);
    if (!entry) return undefined;
    return { entry, ...(await this.show(entry, await this.known())) };
  }

  /** The host's plugins whose marketplace isn't registered, one per key (spec §7.6). Each JSON file is read once. */
  async list(): Promise<HostPluginListing[]> {
    const registered = new Set(await this.d.registered());
    const known = await this.known();
    const out: HostPluginListing[] = [];
    for (const entry of await this.all()) {
      if (registered.has(entry.marketplace)) continue;
      const shown = await this.show(entry, known);
      const verdict = hostSourceVerdict(known[entry.marketplace]);
      out.push({
        ...entry,
        contents: shown.contents,
        ...(shown.note ? { cantShow: shown.note } : {}),
        ...(verdict.ok
          ? {}
          : {
              addRefusedReason: HOST_MSG.recordUnusable(
                entry.marketplace,
                known[entry.marketplace] === undefined ? HOST_MSG.noRecord : verdict.reason,
              ),
            }),
      });
    }
    return out;
  }

  /** Add its marketplace: the host's record through the input rules, then the §7.1 preview and add. */
  async addMarketplace(
    key: string,
    by: string,
  ): Promise<{ status: 201 | 202; marketplace: MarketplaceDetail }> {
    const entry = (await this.all()).find((e) => e.key === key);
    if (!entry) throw new ApiError(404, "not_found", HOST_MSG.notFound);
    const mkt = entry.marketplace;
    const record = (await this.known())[mkt];
    const verdict =
      record === undefined
        ? ({ ok: false, reason: HOST_MSG.noRecord } as const)
        : hostSourceVerdict(record);
    if (!verdict.ok) {
      throw new ApiError(400, "host_record_unusable", HOST_MSG.recordUnusable(mkt, verdict.reason));
    }
    // A registered name with another source is refused by the preview (409 name_taken).
    const preview = await this.d.marketplaces.preview(verdict.body);
    if (preview.name !== mkt) {
      throw new ApiError(
        400,
        "host_record_unusable",
        HOST_MSG.recordUnusable(mkt, `its catalog is named ${preview.name}`),
      );
    }
    return this.d.marketplaces.add(preview.previewId, by);
  }
}
