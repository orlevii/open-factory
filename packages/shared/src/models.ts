import { z } from "zod";

/** `claude --model` aliases. Kept by hand. */
export const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
export const MODEL_IDS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;

export const MODEL_MSG = {
  chars: "Use letters, digits and . _ : - [ ]",
  dash: "Can't start with a dash.",
} as const;

/** Passed to the CLI as `--model <m>`: a leading dash could be read as another flag. */
export const modelSchema = z
  .string()
  .regex(/^[A-Za-z0-9._[\]:-]{1,100}$/, MODEL_MSG.chars)
  .refine((v) => !v.startsWith("-"), MODEL_MSG.dash);
