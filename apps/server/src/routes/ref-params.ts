import { normaliseRef } from "@open-factory/shared";
import { z } from "zod";

/**
 * The `:ref` of an agent route. A typed or copied ref is normalised (case, i/l, o); one that isn't a ref at all
 * becomes `""`, which no agent has, so the lookup's 404 answers it like any unknown ref.
 */
export const refSchema = z.string().transform((s) => normaliseRef(s) ?? "");
export const refParams = z.object({ ref: refSchema });

export const NO_AGENT_AT_REF = "No agent at this ref";

/** A ref in a query string: normalised like a path's, but one that isn't a ref is refused (400) instead of matching nothing. */
export const refQuerySchema = z
  .string()
  .refine((s) => normaliseRef(s) !== undefined, "Not a ref.")
  .transform((s) => normaliseRef(s) as string);
