import { z } from "zod";
import { RESERVED_HANDLES } from "./handle.ts";

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const HOST_SKILL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
export const RESERVED_SLUGS = [...RESERVED_HANDLES, "all", "system"] as const;

const RESERVED_SECRET_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "NODE_OPTIONS",
]);
const RESERVED_SECRET_PREFIXES = [
  "LC_",
  "LD_",
  "DYLD_",
  "CLAUDE_",
  "ANTHROPIC_",
  "GIT_AUTHOR_",
  "GIT_COMMITTER_",
];
export const isReservedSecretName = (n: string) =>
  RESERVED_SECRET_EXACT.has(n) || RESERVED_SECRET_PREFIXES.some((p) => n.startsWith(p));

export const slugSchema = z
  .string()
  .regex(
    SLUG_PATTERN,
    "Use 3–40 lowercase letters, numbers and inner hyphens, starting with a letter.",
  )
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), "That slug is reserved.");
export const nameSchema = z
  .string()
  .regex(
    NAME_PATTERN,
    "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter.",
  );
export const secretNameSchema = z
  .string()
  .regex(SECRET_NAME_PATTERN, "Use uppercase letters, numbers and underscores, like GH_TOKEN.")
  .refine((n) => !isReservedSecretName(n), "That name is reserved for the agent's environment.");
export const hostSkillSchema = z
  .string()
  .regex(HOST_SKILL_PATTERN, "Not a valid skill folder name.");
