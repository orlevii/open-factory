/**
 * The Plugins view (spec §9.1, §9.3): the catalog of each registered marketplace at the Library's commit or at a pin,
 * each entry's contents, users and pin, contents diffs between two commits, and the on-demand read of an external
 * plugin source. The factory reads checkouts only; nothing here runs Claude Code.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { MarketplaceRow } from "@open-factory/db";
import type {
  marketplacesResponseSchema,
  pluginDetailSchema,
  pluginDiffSchema,
  pluginEntrySchema,
  pluginsResponseSchema,
} from "@open-factory/shared";
import type { z } from "zod";
import { ApiError, FieldError } from "../errors.ts";
import { redactOutput } from "../redact.ts";
import { COMMIT_PATTERN, tagSha } from "./common.ts";
import type { HostPlugins } from "./host-plugins.ts";
import type { LibraryIndex } from "./library-index.ts";
import {
  type CatalogEntry,
  type MarketplaceDetail,
  type MarketplacesService,
  previewPluginOf,
  readCatalog,
} from "./marketplaces-service.ts";
import {
  type ContentsDiff,
  diffContents,
  type PluginContents,
  readContents,
} from "./plugin-contents.ts";
import { hasRangedDependency, readManifest } from "./plugin-settings.ts";
import {
  cachedPluginSource,
  classifyPluginSource,
  type ExternalSource,
  readPluginSource,
} from "./plugin-sources.ts";
import { type Declarations, marketplaceUsers, pluginUsers } from "./plugin-usage.ts";
import { readSkillFile } from "./skill-files.ts";

export type PluginEntryView = z.infer<typeof pluginEntrySchema>;
export type PluginsResponse = z.infer<typeof pluginsResponseSchema>;
export type MarketplacesResponse = z.infer<typeof marketplacesResponseSchema>;
export type PluginDetail = z.infer<typeof pluginDetailSchema>;
export type PluginDiff = z.infer<typeof pluginDiffSchema>;

export const PLUGIN_MSG = {
  notRead: "Contents not read yet",
  archive: "Open Factory doesn't read archive sources.",
  followsSource: "Can't show: it follows its own source.",
  missing: "Can't show: the plugin's folder is missing from the marketplace.",
  outside: "Can't show: the plugin's folder is outside the marketplace.",
  unreadable: "Can't show: its contents can't be read.",
  notFile: "Not a file this plugin's hooks or servers use.",
  noSource: "This plugin has no external source to read.",
  fetchFailed: "Couldn't read this plugin's source.",
  skillsHasntRead: (mkt: string, ref: string) =>
    `Skills hasn't read ${mkt} at ${ref.length === 40 ? ref.slice(0, 7) : ref}.`,
} as const;

const CONCURRENCY = 8;

export interface PluginsIndexDeps {
  library: Pick<LibraryIndex, "marketplaces" | "marketplaceDir" | "declarations">;
  marketplaces: Pick<MarketplacesService, "detailOf">;
  host: Pick<HostPlugins, "list" | "versions" | "entry">;
  factoryHome: string;
  /** `FACTORY_GITHUB_URL`. */
  githubUrl: string;
  gitBin?: string;
  /** The `library_changed` frame: reading a plugin source changes what the peek shows. */
  publish?: () => void;
  log: (message: string, err: unknown) => void;
}

/** One catalog entry at one checkout, and where its code can be read from. */
interface Located {
  row: MarketplaceRow;
  entry: CatalogEntry;
  key: string;
  mdir: string;
  /** The commit the marketplace was read at (null for a live folder). */
  sha: string | null;
  ext?: { source: ExternalSource; sha: string };
  state: PluginEntryView["state"];
  /** A dependency names a version range, so the plugin can't be held by a pin (spec §7.4). */
  ranged: boolean;
  source: PluginDetail["source"];
  /** The readable root of the plugin's code. */
  dir: string | null;
  /** Why there are no contents. */
  note: string | null;
  canRead: boolean;
}

const emptyContents = (): PluginContents => ({
  manifest: {
    name: null,
    version: null,
    description: null,
    author: null,
    homepage: null,
    repository: null,
  },
  hooks: [],
  mcp: [],
  dependencies: [],
  codeParts: [],
  needs: [],
  provides: { skills: [], commands: [], agents: [], outputStyles: [] },
  unshown: [],
  files: [],
  summary: {
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
  },
});

const insideOrSame = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const splitKey = (key: string) => {
  const at = key.lastIndexOf("@");
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
};

export class PluginsIndex {
  constructor(private readonly d: PluginsIndexDeps) {}

  private get opts() {
    return { factoryHome: this.d.factoryHome, githubUrl: this.d.githubUrl, gitBin: this.d.gitBin };
  }

  // Locating ------------------------------------------------------------------------------

  /** Where one catalog entry's code is, without fetching anything. */
  private async resolve(
    row: MarketplaceRow,
    mdir: string,
    entry: CatalogEntry,
    sha: string | null,
  ): Promise<Located> {
    const key = `${entry.name}@${row.name}`;
    const info = classifyPluginSource(entry.raw);
    const base = {
      row,
      entry,
      key,
      mdir,
      sha,
      dir: null,
      note: null,
      canRead: false,
      ranged: false,
    };
    if (info.kind === "refused") {
      return {
        ...base,
        state: "refused",
        source: { kind: "refused", detail: info.label },
        note: previewPluginOf(row.name, entry).refusedReason ?? null,
      };
    }
    if (info.kind === "relative") {
      const source = {
        kind: "relative" as const,
        detail: info.path === "" ? "./" : `./${info.path}`,
      };
      const [real, root] = await Promise.all([
        realpath(path.join(mdir, info.path)).catch(() => undefined),
        realpath(mdir).catch(() => undefined),
      ]);
      if (!real || !root) return { ...base, state: "missing", source, note: PLUGIN_MSG.missing };
      if (!insideOrSame(root, real)) {
        return { ...base, state: "missing", source, note: PLUGIN_MSG.outside };
      }
      const ranged = hasRangedDependency(await readManifest(real));
      return { ...base, state: ranged ? "cant_pin" : "ok", ranged, source, dir: real };
    }
    const ext = info.source;
    const detail = ext.source === "github" ? ext.repo : ext.url;
    const source = { kind: "external" as const, detail: `${ext.source}: ${detail}` };
    const state = info.pinnable ? ("ok" as const) : ("cant_pin" as const);
    if (ext.source === "archive") return { ...base, state, source, note: PLUGIN_MSG.archive };
    if (ext.sha === undefined) {
      return { ...base, state, source, note: PLUGIN_MSG.followsSource };
    }
    const cached = await cachedPluginSource(ext, ext.sha, this.opts);
    const ranged = cached !== null && hasRangedDependency(await readManifest(cached));
    return {
      ...base,
      state: ranged ? ("cant_pin" as const) : state,
      ranged,
      source,
      ext: { source: ext, sha: ext.sha },
      dir: cached,
      note: cached ? null : PLUGIN_MSG.notRead,
      canRead: cached === null,
    };
  }

  private async row(name: string): Promise<MarketplaceRow> {
    const row = (await this.d.library.marketplaces()).find((r) => r.name === name);
    if (!row) throw new ApiError(404, "not_found", "Not found");
    return row;
  }

  /** The marketplace's checkout at `commit` (a sha, a recorded tag; default the Library's), or a 404 naming what isn't read. */
  private async checkout(row: MarketplaceRow, commit?: string) {
    const mdir = await this.d.library.marketplaceDir(row, commit);
    if (!mdir) {
      throw new ApiError(
        404,
        "not_read",
        PLUGIN_MSG.skillsHasntRead(row.name, commit ?? row.commit ?? ""),
      );
    }
    const want = commit ?? row.commit;
    const sha = want && (COMMIT_PATTERN.test(want) ? want : (tagSha(row.tags, want) ?? null));
    return { mdir, sha: row.source.source === "directory" ? null : sha };
  }

  private async locate(key: string, commit?: string): Promise<Located | undefined> {
    const { name, marketplace } = splitKey(key);
    const row = await this.row(marketplace);
    const { mdir, sha } = await this.checkout(row, commit);
    const entry = (await readCatalog(mdir)).plugins.find((p) => p.name === name);
    return entry ? this.resolve(row, mdir, entry, sha) : undefined;
  }

  private async locateOrFail(key: string, commit?: string): Promise<Located> {
    const l = await this.locate(key, commit);
    if (!l) throw new ApiError(404, "not_found", "Not found");
    return l;
  }

  /** The contents of a located plugin, or null (with the note's reason in `Located.note`, or `unreadable`). */
  private async contentsOf(
    l: Located,
  ): Promise<{ contents: PluginContents | null; note: string | null }> {
    if (!l.dir) return { contents: null, note: l.note };
    try {
      return { contents: await readContents(l.dir), note: null };
    } catch (e) {
      this.d.log(`reading the contents of ${l.key} failed`, e);
      return { contents: null, note: PLUGIN_MSG.unreadable };
    }
  }

  /** Fetches an external `git` source into its read-only cache (spec §7.5); the root of its code. */
  private async fetched(l: Located): Promise<string | null> {
    if (l.dir) return l.dir;
    if (!l.ext) return null;
    try {
      return await readPluginSource(l.ext.source, l.ext.sha, this.opts);
    } catch (e) {
      this.d.log(`reading the source of ${l.key} failed`, e);
      throw new ApiError(
        502,
        "fetch_failed",
        e instanceof Error && e.message.includes("50 MB")
          ? redactOutput(e.message)
          : PLUGIN_MSG.fetchFailed,
      );
    }
  }

  // Reads ---------------------------------------------------------------------------------

  private async entryView(l: Located, decl: Declarations): Promise<PluginEntryView> {
    const p = previewPluginOf(l.row.name, l.entry, l.ranged);
    const { contents } = await this.contentsOf(l);
    return {
      key: l.key,
      name: l.entry.name,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.version !== undefined ? { version: p.version } : {}),
      pinnable: p.pinnable,
      ...(p.refusedReason !== undefined ? { refusedReason: p.refusedReason } : {}),
      state: l.state,
      contentsSummary: contents?.summary ?? null,
      canRead: l.canRead,
      usedBy: pluginUsers(decl, l.key),
    };
  }

  /** The entries of one marketplace at the Library's commit. A marketplace that isn't readable has none. */
  private async entriesOf(row: MarketplaceRow, decl: Declarations): Promise<PluginEntryView[]> {
    const mdir = await this.d.library.marketplaceDir(row);
    if (!mdir) return [];
    const catalog = await readCatalog(mdir).catch((e) => {
      this.d.log(`reading the catalog of ${row.name} failed`, e);
      return undefined;
    });
    if (!catalog) return [];
    const sha = row.source.source === "directory" ? null : row.commit;
    const out: PluginEntryView[] = [];
    for (let i = 0; i < catalog.plugins.length; i += CONCURRENCY) {
      const batch = catalog.plugins.slice(i, i + CONCURRENCY);
      out.push(
        ...(await Promise.all(
          batch.map(async (e) => this.entryView(await this.resolve(row, mdir, e, sha), decl)),
        )),
      );
    }
    return out;
  }

  /** `GET /api/library/plugins`: each live marketplace's catalog, and the host's plugins whose marketplace isn't registered. */
  async list(): Promise<PluginsResponse> {
    const decl = await this.d.library.declarations();
    const marketplaces: PluginsResponse["marketplaces"] = [];
    for (const row of await this.d.library.marketplaces()) {
      marketplaces.push({
        name: row.name,
        commit: row.commit,
        state: row.state,
        since: row.state === "adding" ? row.startedAt.toISOString() : null,
        plugins: await this.entriesOf(row, decl),
      });
    }
    const host = (await this.d.host.list()).map((h) => ({
      key: h.key,
      name: h.name,
      marketplace: h.marketplace,
      version: h.version,
      lastUpdated: h.lastUpdated,
      contentsSummary: h.contents?.summary ?? null,
      ...(h.cantShow ? { cantShow: h.cantShow } : {}),
      ...(h.addRefusedReason ? { addRefusedReason: h.addRefusedReason } : {}),
    }));
    return { marketplaces, host };
  }

  /** `GET /api/library/marketplaces`: each live row with its plugins and users. */
  async marketplaces(): Promise<MarketplacesResponse> {
    const decl = await this.d.library.declarations();
    const out: MarketplacesResponse["marketplaces"] = [];
    for (const row of await this.d.library.marketplaces()) {
      const detail: MarketplaceDetail = await this.d.marketplaces.detailOf(row.name);
      out.push({
        ...detail,
        plugins: await this.entriesOf(row, decl),
        users: marketplaceUsers(decl, row.name),
      });
    }
    return { marketplaces: out };
  }

  /** `GET /api/library/plugins/:key`: the contents and provenance at `commit` (default the Library's), or the host's copy. */
  async detail(key: string, o: { commit?: string; from?: "host" } = {}): Promise<PluginDetail> {
    const hostVersions = await this.d.host.versions();
    if (o.from === "host") {
      const h = await this.d.host.entry(key);
      if (!h) throw new ApiError(404, "not_found", "Not found");
      return {
        key,
        name: h.entry.name,
        marketplace: h.entry.marketplace,
        from: "host",
        commit: null,
        version: h.entry.version ?? h.contents?.manifest.version ?? null,
        description: h.contents?.manifest.description ?? null,
        pinnable: false,
        state: "ok",
        source: { kind: "host", detail: "Installed on this host" },
        contents: h.contents,
        contentsNote: h.note ?? null,
        canRead: false,
        hostVersion: h.entry.version,
        usedBy: { templates: [], overlays: [] },
      };
    }
    const l = await this.locateOrFail(key, o.commit);
    return this.detailOf(l, hostVersions.get(key) ?? null);
  }

  private async detailOf(l: Located, hostVersion: string | null): Promise<PluginDetail> {
    const p = previewPluginOf(l.row.name, l.entry, l.ranged);
    const { contents, note } = await this.contentsOf(l);
    return {
      key: l.key,
      name: l.entry.name,
      marketplace: l.row.name,
      from: "library",
      commit: l.sha,
      version: p.version ?? contents?.manifest.version ?? null,
      description: p.description ?? contents?.manifest.description ?? null,
      pinnable: p.pinnable,
      ...(p.refusedReason !== undefined ? { refusedReason: p.refusedReason } : {}),
      state: l.state,
      source: l.source,
      contents,
      contentsNote: note,
      canRead: l.canRead,
      hostVersion,
      usedBy: pluginUsers(await this.d.library.declarations(), l.key),
    };
  }

  /** `GET /api/library/plugins/:key/file`: View file. Only a file the contents list names, as a text of at most 256 KB. */
  async fileText(
    key: string,
    rel: string,
    o: { commit?: string; from?: "host" } = {},
  ): Promise<string> {
    let dir: string | null;
    let contents: PluginContents | null;
    if (o.from === "host") {
      const h = await this.d.host.entry(key);
      if (!h) throw new ApiError(404, "not_found", "Not found");
      ({ dir, contents } = h);
    } else {
      const l = await this.locateOrFail(key, o.commit);
      dir = l.dir;
      contents = (await this.contentsOf(l)).contents;
    }
    if (!dir || !contents?.files.includes(rel)) throw new FieldError("path", PLUGIN_MSG.notFile);
    return readSkillFile(dir, rel);
  }

  // Mutations that fetch ------------------------------------------------------------------

  /** `POST /api/library/plugins/:key/read`: fetches an external `sha` source so its contents can be shown. */
  async read(key: string, commit?: string): Promise<PluginDetail> {
    const l = await this.locateOrFail(key, commit);
    if (!l.ext) {
      throw new ApiError(409, "nothing_to_read", PLUGIN_MSG.noSource);
    }
    const dir = await this.fetched(l);
    this.d.publish?.();
    const hostVersion = (await this.d.host.versions()).get(key) ?? null;
    return this.detailOf({ ...l, dir, note: null, canRead: false }, hostVersion);
  }

  /** `POST /api/library/plugins/:key/diff`: what moving the plugin between two commits of its marketplace changes (spec §7.5). */
  async diff(key: string, from: string, to: string): Promise<PluginDiff> {
    // Fetching an external source adds a cache the peeks read, so it publishes as `read` does.
    let fetchedAny = false;
    const side = async (ref: string) => {
      const { name, marketplace } = splitKey(key);
      const row = await this.row(marketplace);
      const { mdir, sha } = await this.checkout(row, ref);
      const entry = (await readCatalog(mdir)).plugins.find((p) => p.name === name);
      const l = entry ? await this.resolve(row, mdir, entry, sha) : undefined;
      const dir = l ? await this.fetched(l) : null;
      if (l && !l.dir && dir) fetchedAny = true;
      const read =
        l && dir ? await this.contentsOf({ ...l, dir }) : { contents: null, note: l?.note ?? null };
      return {
        commit: sha ?? ref,
        present: l !== undefined,
        version: l
          ? (previewPluginOf(row.name, l.entry, l.ranged).version ??
            read.contents?.manifest.version ??
            null)
          : null,
        contents: read.contents,
        note: read.note,
      };
    };
    const [a, b] = [await side(from), await side(to)];
    if (fetchedAny) this.d.publish?.();
    const diff: ContentsDiff = diffContents(
      a.contents ?? emptyContents(),
      b.contents ?? emptyContents(),
    );
    const view = (s: typeof a) => ({
      commit: s.commit,
      present: s.present,
      version: s.version,
      unshown: s.contents?.unshown ?? (s.note ? [s.note] : []),
    });
    return { key, from: view(a), to: view(b), diff };
  }
}
