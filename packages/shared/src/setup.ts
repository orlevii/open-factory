import { z } from "zod";

/** The first-run state the setup checklist reads (I8 §3): what exists, not whether it is valid. */
export const setupStatusSchema = z.object({
  hasCredential: z.boolean(),
  hasTemplate: z.boolean(),
  hasAgent: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;
