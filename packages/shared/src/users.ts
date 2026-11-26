import { z } from "zod";

export const userAdminItemSchema = z.object({
  id: z.string(),
  /** The person's principal ref, what an agent's manager is named by. */
  ref: z.string(),
  name: z.string(),
  handle: z.string(),
  email: z.string(),
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
});
export type UserAdminItem = z.infer<typeof userAdminItemSchema>;
export const usersAdminListSchema = z.object({ users: z.array(userAdminItemSchema) });

export const inviteItemSchema = z.object({
  id: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type InviteItem = z.infer<typeof inviteItemSchema>;
export const createInviteResponseSchema = z.object({ invite: inviteItemSchema, link: z.string() });
export const signUpStateSchema = z.object({
  bootstrap: z.boolean(),
  invite: z.enum(["valid", "invalid", "missing"]),
});
export type SignUpState = z.infer<typeof signUpStateSchema>;
