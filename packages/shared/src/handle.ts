import { z } from "zod";
import { MSG } from "./messages.ts";

/** Addresses the product uses (@humans, @me, @scheduler, @factory, @all, @system). Specs that add an address add it here. */
// "unknown" is how a dangling tag renders.
export const RESERVED_HANDLES = [
  "humans",
  "me",
  "scheduler",
  "factory",
  "all",
  "system",
  "unknown",
] as const;

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Must stay synchronous: better-auth's additionalFields validator rejects async schemas.
export const handleSchema = z
  .string()
  .min(2, MSG.handleLength)
  .max(40, MSG.handleLength)
  .regex(HANDLE_PATTERN, MSG.nameChars)
  .refine((h) => !(RESERVED_HANDLES as readonly string[]).includes(h), MSG.handleReserved);
