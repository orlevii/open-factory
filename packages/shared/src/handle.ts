import { z } from "zod";
import { MSG } from "./messages.ts";

/** Addresses the product uses (@humans, @me, @scheduler, @factory, @all, @system). Specs that add an address add it here. */
export const RESERVED_HANDLES = [
  "humans",
  "me",
  "scheduler",
  "factory",
  "all",
  "system",
  "unknown", // how a dangling mention renders
] as const;

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Must stay synchronous: better-auth's additionalFields validator rejects async schemas.
export const handleSchema = z
  .string()
  .min(2, MSG.handleLength)
  .max(40, MSG.handleLength)
  .regex(/^[a-z0-9-]*$/, MSG.handleChars)
  .regex(HANDLE_PATTERN, MSG.handleEnds)
  .refine((h) => !(RESERVED_HANDLES as readonly string[]).includes(h), MSG.handleReserved);
