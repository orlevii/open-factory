import { z } from "zod";
import { handleSchema } from "./handle.ts";
import { MSG } from "./messages.ts";

/** Input limits only: longer values already stored stay readable (spec §13.2). */
export const USER_NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const NAME_TOO_LONG_MESSAGE = `Keep your name to ${USER_NAME_MAX} characters or fewer.`;
export const EMAIL_TOO_LONG_MESSAGE = `Keep your email to ${EMAIL_MAX} characters or fewer.`;

export const signUpSchema = z.object({
  name: z.string().trim().min(1, MSG.nameRequired).max(USER_NAME_MAX, NAME_TOO_LONG_MESSAGE),
  handle: handleSchema,
  email: z.email(MSG.email).max(EMAIL_MAX, EMAIL_TOO_LONG_MESSAGE),
  password: z.string().min(8, MSG.passwordLength),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  handle: z.string(),
});
export type Me = z.infer<typeof meSchema>;

export const statusSchema = z.object({ version: z.string(), db: z.enum(["ok", "error"]) });
export type Status = z.infer<typeof statusSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
