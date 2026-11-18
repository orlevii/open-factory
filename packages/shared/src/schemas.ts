import { z } from "zod";
import { handleSchema } from "./handle.ts";

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  handle: handleSchema,
  email: z.email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
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
