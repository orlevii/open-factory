import { z } from "zod";
import { MSG } from "./messages.ts";

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const HOST_SKILL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

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
  "OPEN_FACTORY_",
];
export const isReservedSecretName = (n: string) =>
  RESERVED_SECRET_EXACT.has(n) || RESERVED_SECRET_PREFIXES.some((p) => n.startsWith(p));

const lengthRules = (min: number, max: number, msg: string) =>
  z.string().min(min, msg).max(max, msg);
const charRules = (schema: z.ZodString, pattern: RegExp) =>
  schema
    .regex(/^[a-z]/, MSG.startLetter)
    .regex(/^[a-z0-9-]+$/, MSG.nameChars)
    .regex(/[^-]$/, MSG.noTrailingHyphen)
    .regex(pattern, MSG.nameChars);

export const nameSchema = charRules(lengthRules(2, 40, MSG.nameLength), NAME_PATTERN);
export const secretNameSchema = z
  .string()
  .regex(SECRET_NAME_PATTERN, MSG.secretChars)
  .refine((n) => !isReservedSecretName(n), MSG.nameReserved);
export const hostSkillSchema = z
  .string()
  .regex(HOST_SKILL_PATTERN, "Not a valid skill folder name.");
