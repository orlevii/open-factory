import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  HOST_SKILL_DESCRIPTION_MAX,
  HOST_SKILL_PATTERN,
  hostSkillsResponseSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { parse } from "yaml";
import { requireUser } from "../auth/require-user.ts";
import { hostSkillsDirOf } from "../config.ts";

/** The `description` of a SKILL.md's frontmatter on one line, cut to the limit; empty when there is none. */
export function skillDescription(text: string): string {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return "";
  let fm: unknown;
  try {
    fm = parse(m[1] as string);
  } catch {
    return "";
  }
  const d =
    typeof fm === "object" && fm !== null ? (fm as Record<string, unknown>).description : "";
  return typeof d === "string"
    ? d.replace(/\s+/g, " ").trim().slice(0, HOST_SKILL_DESCRIPTION_MAX)
    : "";
}

/** I2 §12.1: the host skills dir's folders with a `SKILL.md`, read live (links are followed, as Claude Code does). */
export const hostSkillsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", requireUser);
  app.get(
    "/api/host-skills",
    { schema: { response: { 200: hostSkillsResponseSchema } } },
    async () => {
      const dir = hostSkillsDirOf(app.config);
      const skills: { name: string; description: string }[] = [];
      for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
        if (!HOST_SKILL_PATTERN.test(name)) continue;
        const file = path.join(dir, name, "SKILL.md");
        if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
        skills.push({ name, description: skillDescription(await readFile(file, "utf8")) });
      }
      return { dir, skills };
    },
  );
};
