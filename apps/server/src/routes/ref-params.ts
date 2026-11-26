import { normaliseRef } from "@open-factory/shared";
import { z } from "zod";

/**
 * The `:ref` of an agent route. A typed or copied ref is normalised (case, i/l, o); one that isn't a ref at all
 * becomes `""`, which no agent has, so the lookup's 404 answers it like any unknown ref.
 */
export const refSchema = z.string().transform((s) => normaliseRef(s) ?? "");
export const refParams = z.object({ ref: refSchema });

export const NO_AGENT_AT_REF = "No agent at this ref";
