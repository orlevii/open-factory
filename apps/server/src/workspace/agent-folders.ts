/**
 * The agent's own folders at a start (spec §6.4, §7.3 step 3, §7.10). The workdir is agent-writable, so the start
 * checks what Claude Code would load from it that can run code or change factory-owned settings, and fails closed
 * rather than rewrite the agent's files. Every read of a file the agent may have planted is bounded and never blocks.
 */
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { reservedKeysIn } from "@open-factory/shared";
import { parseFrontmatter } from "../library/skill-md.ts";
import { SafeFs, UnsafePathError, WorkspaceError } from "./safe-fs.ts";

const CLAUDE = ".claude";
const USER_LEVEL = [".claude-config/skills", ".claude-config/agents", ".claude-config/commands"];
/** Larger than any real settings file or frontmatter; a bigger one can't be checked, so it fails. */
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 5;

/**
 * Empties `.claude-config/{skills,agents,commands}` (R12): the factory never writes there, and Claude Code loads
 * user-level skills, subagents and commands from them (skills-directory plugins too). A link is removed as a link.
 */
export async function scrubAgentFolders(workdir: string): Promise<void> {
  const safe = new SafeFs(workdir);
  for (const rel of USER_LEVEL) await safe.emptyDir(rel);
}

/** The text of a regular file, following links like Claude Code does; undefined when absent or not a regular file. */
async function readText(abs: string, label: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK keeps a planted FIFO from blocking the open.
    fh = await open(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    if (st.size > MAX_BYTES)
      throw new WorkspaceError(
        `${label} is larger than 256 KB, so it can't be checked; shrink it.`,
      );
    return (await fh.readFile()).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The names in one `.claude/<sub>` folder; a link in the folder's place fails (the check can't vouch for its target). */
async function entriesOf(workdir: string, rel: string): Promise<string[]> {
  const st = await new SafeFs(workdir).entry(rel);
  if (!st) return [];
  const abs = path.join(workdir, rel);
  if (st.isSymbolicLink()) throw new UnsafePathError(abs);
  if (!st.isDirectory()) throw new WorkspaceError(`${abs} isn't a folder; move it away.`);
  return (await readdir(abs)).sort();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `<workdir>/.claude/settings.json` and `settings.local.json` (R11). Claude Code ranks them above user settings, so a
 * reserved key there would override the factory's. A link at either path fails; so does a reserved key (naming the file
 * and the key) and a file that isn't a JSON object. Nothing is stripped: the start fails instead.
 */
export async function checkProjectSettings(workdir: string): Promise<void> {
  const safe = new SafeFs(workdir);
  for (const file of ["settings.json", "settings.local.json"]) {
    const rel = path.join(CLAUDE, file);
    const abs = path.join(workdir, rel);
    const st = await safe.entry(rel);
    if (!st) continue;
    if (st.isSymbolicLink())
      throw new WorkspaceError(`${abs} is a link, which agents can't use; remove it.`);
    const tooLarge = (): never => {
      throw new WorkspaceError(`${abs} is larger than 256 KB, so it can't be checked; shrink it.`);
    };
    const raw = await safe.readIfRegular(rel, { maxBytes: MAX_BYTES, onTooLarge: tooLarge });
    if (raw === undefined) continue;
    if (raw.length > MAX_BYTES) tooLarge();
    const text = raw.toString("utf8");
    if (!text.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WorkspaceError(
        `${abs} isn't valid JSON, so it can't be checked; fix or remove it.`,
      );
    }
    if (!isRecord(parsed))
      throw new WorkspaceError(
        `${abs} isn't a JSON object, so it can't be checked; fix or remove it.`,
      );
    const [key] = reservedKeysIn(parsed);
    if (key) throw new WorkspaceError(`${abs} sets ${key}, which agents can't set; remove it.`);
  }
}

const OPENING = /^---[ \t]*\r?\n/;
const EMPTY_BLOCK = /^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The top-level frontmatter keys of a markdown file. A file with no frontmatter has none. A file that opens a `---` block
 * that doesn't parse to a map fails the start: Claude Code may read what this parser can't, so the file can't be vouched
 * for. A BOM and leading blank lines are tolerated, as they may be by Claude Code.
 */
async function frontmatterKeys(abs: string, label: string): Promise<Set<string>> {
  const raw = await readText(abs, label);
  if (raw === undefined) return new Set();
  const text = raw.replace(/^\uFEFF/, "").replace(/^(?:[ \t]*\r?\n)+/, "");
  if (!OPENING.test(text) || EMPTY_BLOCK.test(text)) return new Set();
  const fm = parseFrontmatter(text);
  if (!fm)
    throw new WorkspaceError(
      `${label} has frontmatter that can't be read, so it can't be checked; fix or remove it.`,
    );
  return new Set(Object.keys(fm));
}

const isErr = (err: unknown, ...codes: string[]) =>
  codes.includes((err as NodeJS.ErrnoException).code ?? "");

/**
 * Every `.md` under `.claude/<sub>`, directories and links to them followed (each real folder once), at most MAX_DEPTH
 * levels deep: deeper fails rather than skips. A missing folder is fine; any other read error fails.
 */
async function checkMarkdownTree(
  workdir: string,
  sub: "agents" | "commands",
  banned: string[],
): Promise<void> {
  const root = path.join(CLAUDE, sub);
  await entriesOf(workdir, root);
  const seen = new Set<string>();
  const walk = async (rel: string, depth: number): Promise<void> => {
    const abs = path.join(workdir, rel);
    const real = await realpath(abs).catch((err) => {
      if (isErr(err, "ENOENT", "ENOTDIR")) return undefined;
      throw err;
    });
    if (!real || seen.has(real)) return;
    seen.add(real);
    if (depth > MAX_DEPTH)
      throw new WorkspaceError(
        `${path.relative(CLAUDE, rel)} is nested too deep to be checked; move it up.`,
      );
    let names: string[];
    try {
      names = await readdir(abs);
    } catch (err) {
      if (isErr(err, "ENOENT")) return;
      throw err;
    }
    for (const name of names.sort()) {
      const childRel = path.join(rel, name);
      const st = await stat(path.join(workdir, childRel)).catch((err) => {
        // A dangling link loads nothing.
        if (isErr(err, "ENOENT", "ENOTDIR")) return undefined;
        throw err;
      });
      if (!st) continue;
      if (st.isDirectory()) {
        await walk(childRel, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(name)) continue;
      const label = path.relative(CLAUDE, childRel);
      const keys = await frontmatterKeys(path.join(workdir, childRel), label);
      for (const key of banned)
        if (keys.has(key))
          throw new WorkspaceError(
            `${label} declares ${key}, which agents can't set; remove them.`,
          );
    }
  };
  await walk(root, 0);
}

/**
 * Agent-written skills, subagents and commands (R12). Skill and subagent frontmatter can declare `hooks`, and subagents
 * `mcpServers`. Entries of `.claude/skills/` the factory linked (`factoryLinks`, the names it just linked) may declare
 * hooks: they are human-registered and shown under "Runs code". Template `files/` can't write under `.claude`, so
 * everything else there is agent-written.
 */
export async function checkAgentFrontmatter(
  workdir: string,
  factoryLinks: Set<string>,
): Promise<void> {
  for (const name of await entriesOf(workdir, path.join(CLAUDE, "skills"))) {
    if (factoryLinks.has(name)) continue;
    const label = `skills/${name}`;
    const keys = await frontmatterKeys(
      path.join(workdir, CLAUDE, "skills", name, "SKILL.md"),
      label,
    );
    if (keys.has("hooks"))
      throw new WorkspaceError(`${label} declares hooks, which agents can't set; remove them.`);
  }
  await checkMarkdownTree(workdir, "agents", ["hooks", "mcpServers"]);
  await checkMarkdownTree(workdir, "commands", ["hooks"]);
}

/**
 * Every entry of `.claude/skills/` (R3, R12): a factory link, a link the agent made, or a folder it wrote. `stat` follows
 * the entry, as Claude Code does; one that holds `.claude-plugin` is a plugin, which would load outside the store.
 */
export async function checkSkillPlugins(workdir: string): Promise<void> {
  for (const name of await entriesOf(workdir, path.join(CLAUDE, "skills"))) {
    const found = await stat(path.join(workdir, CLAUDE, "skills", name, ".claude-plugin")).then(
      () => true,
      (err) => {
        // Only "nothing there" clears an entry; an unreadable one can't be vouched for.
        if (isErr(err, "ENOENT", "ENOTDIR")) return false;
        throw err;
      },
    );
    if (found)
      throw new WorkspaceError(
        `skills/${name} is a plugin, so it can't load as a skill; move it away.`,
      );
  }
}
