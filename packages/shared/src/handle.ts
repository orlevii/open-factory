import { z } from "zod";

/** Addresses the product uses (@humans, @me, @scheduler, @factory). Specs that add an address add it here. */
export const RESERVED_HANDLES = ["humans", "me", "scheduler", "factory"] as const;

export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Must stay synchronous: better-auth's additionalFields validator rejects async schemas.
export const handleSchema = z
  .string()
  .min(2, "Handle must be at least 2 characters")
  .max(32, "Handle must be at most 32 characters")
  .regex(HANDLE_PATTERN, "Use lowercase letters, digits and inner hyphens")
  .refine((h) => !(RESERVED_HANDLES as readonly string[]).includes(h), "This handle is reserved");
