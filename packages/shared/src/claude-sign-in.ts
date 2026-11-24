import { z } from "zod";
import { nameSchema } from "./names.ts";

export const SIGN_IN_STATES = [
  "starting",
  "awaiting_code",
  "submitting",
  "exchanging",
  "verifying",
  "settled",
] as const;
export type SignInState = (typeof SIGN_IN_STATES)[number];

export const attemptViewSchema = z.strictObject({
  attemptId: z.string().min(1),
  state: z.enum(SIGN_IN_STATES),
  url: z.string().optional(),
  codeDeadline: z.string().optional(),
  purpose: z.enum(["create", "replace"]),
  name: z.string().optional(),
});
export type AttemptView = z.infer<typeof attemptViewSchema>;

export const signInStatusSchema = z.object({
  available: z.boolean(),
  attempt: attemptViewSchema.nullable(),
});
export const attemptResponseSchema = z.object({ attempt: attemptViewSchema });
export const startSignInBodySchema = z.strictObject({ replace: nameSchema.optional() });
export const submitCodeBodySchema = z.strictObject({
  attemptId: z.string().min(1).max(64),
  code: z.string().max(4096),
  name: z.string().max(200).optional(),
});
export const waitBodySchema = z.strictObject({ attemptId: z.string().min(1).max(64) });

/** Removes every whitespace character (a pasted newline would submit early, D5); 1–512 printable ASCII or undefined. */
export function normalizeSignInCode(raw: string): string | undefined {
  const code = raw.replace(/\s+/g, "");
  return /^[\x21-\x7E]{1,512}$/.test(code) ? code : undefined;
}
