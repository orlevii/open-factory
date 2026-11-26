import { z } from "zod";
import { avatarColorSchema } from "./avatar.ts";
import { handleSchema } from "./handle.ts";

export const principalStateSchema = z.enum(["live", "archived", "terminated", "disabled"]);
export type PrincipalState = z.infer<typeof principalStateSchema>;

/** What a tag chip needs to draw one principal; `avatar` is what `AgentAvatar` takes, null for a human. */
export const principalItemSchema = z.object({
  id: z.string(),
  ref: z.string(),
  kind: z.enum(["agent", "human"]),
  handle: z.string(),
  name: z.string(),
  state: principalStateSchema,
  avatar: z
    .object({
      template: z.string(),
      avatarVersion: z.string().nullable(),
      color: avatarColorSchema.nullable(),
    })
    .nullable(),
});
export type PrincipalItem = z.infer<typeof principalItemSchema>;

export const principalsResponseSchema = z.object({ principals: z.array(principalItemSchema) });
export type PrincipalsResponse = z.infer<typeof principalsResponseSchema>;

export const MAX_PRINCIPAL_REFS = 100;
/** `?refs=a,b`: the refs to list; absent lists everyone. */
export const principalsQuerySchema = z.object({
  refs: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.string()).max(MAX_PRINCIPAL_REFS))
    .optional(),
});

/** `PATCH /api/me`: the signed-in person's own name and handle; either or both. */
export const patchMeBodySchema = z
  .strictObject({
    name: z.string().trim().min(1, "Enter a name").max(80, "Use up to 80 characters"),
    handle: handleSchema,
  })
  .partial();
export type PatchMeBody = z.infer<typeof patchMeBodySchema>;
