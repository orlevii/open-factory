import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { cutGraphemes, HOST_SKILL_DESCRIPTION_MAX } from "@open-factory/shared";
import { parse } from "yaml";

const MAX_BYTES = 64 * 1024;

/** One command hook a skill declares in its frontmatter (spec §5.3, R12). */
export interface HookDecl {
  event: string;
  /** "" when the hook has no matcher. */
  matcher: string;
  command: string;
}

export interface SkillMd {
  name?: string;
  description?: string;
  hooks: HookDecl[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function hooksOf(raw: unknown): HookDecl[] {
  if (!isRecord(raw)) return [];
  const out: HookDecl[] = [];
  for (const [event, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isRecord(g) || !Array.isArray(g.hooks)) continue;
      const matcher = typeof g.matcher === "string" ? g.matcher : "";
      for (const h of g.hooks) {
        if (isRecord(h) && h.type === "command" && typeof h.command === "string") {
          out.push({ event, matcher, command: h.command });
        }
      }
    }
  }
  return out;
}

/** The frontmatter of a SKILL.md's text. Malformed or missing frontmatter gives no name, description or hooks. */
export function parseSkillMd(text: string): SkillMd {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { hooks: [] };
  let fm: unknown;
  try {
    fm = parse(m[1] as string);
  } catch {
    return { hooks: [] };
  }
  if (!isRecord(fm)) return { hooks: [] };
  const out: SkillMd = { hooks: hooksOf(fm.hooks) };
  if (typeof fm.name === "string") out.name = fm.name;
  if (typeof fm.description === "string") {
    out.description = cutGraphemes(
      fm.description.replace(/\s+/g, " ").trim(),
      HOST_SKILL_DESCRIPTION_MAX,
    );
  }
  return out;
}

/**
 * Reads `<dir>/SKILL.md` without following a link at the file itself (`dir` may be one), at most 64 KB.
 * Null when it is absent, a link, not a regular file or unreadable.
 */
export async function readSkillMd(dir: string): Promise<SkillMd | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path.join(dir, "SKILL.md"), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
    return parseSkillMd(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
