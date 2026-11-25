import { z } from "zod";
import { agentOverlaySchema } from "./config.ts";
import { TEMPLATE_FILES } from "./templates.ts";

/**
 * MCP inputs of the org tools (I7 spec §7.1; snake_case like the task tools). Names stay loose strings: the services
 * judge them and answer with the same sentence a human gets. Parameter semantics only; rules live in CLAUDE.md.
 */
const ref = z.string().trim().min(1).max(80);
const slugRef = ref.describe("An agent's name (slug); a leading @ is fine");

export const getTemplateToolSchema = z.object({ name: ref.describe("The template's name") });

export const getAgentToolSchema = z.object({ slug: slugRef });

export const createAgentToolSchema = z.object({
  template: ref.describe("The template's name"),
  name: slugRef.describe("The new agent's name (slug)"),
  display_name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  manager: z
    .union([ref, z.null()])
    .optional()
    .describe('An agent name, "me" (the default), or null for top level'),
  credential: ref.describe("A credential's name"),
  projects: z.array(ref).optional().describe("Project names (default: the template's)"),
  config: agentOverlaySchema.optional().describe("The agent's overlay on its template"),
});

export const updateAgentToolSchema = z
  .object({
    slug: slugRef,
    display_name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    manager: z
      .union([ref, z.null()])
      .optional()
      .describe('An agent name, "me", or null for top level'),
    credential: ref.optional(),
    projects: z.array(ref).optional().describe("The full new list (replaces the old one)"),
    config: agentOverlaySchema
      .optional()
      .describe("The whole new overlay (replaces the old one); needs base_hash"),
    base_hash: z
      .string()
      .optional()
      .describe("The overlay_hash get_agent gave you; required with config"),
  })
  .refine((v) => v.config === undefined || v.base_hash !== undefined, {
    message: "base_hash is required with config; read it from get_agent.",
    path: ["base_hash"],
  });

export const listLibraryToolSchema = z.object({
  query: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Case-insensitive substring of a name or description"),
});

/** Every list in `list_library` is cut here, with `more: true` and a note to narrow `query`. */
export const LIBRARY_LIST_MAX = 200;

/** The files `get_template` returns and `write_template_file` accepts. */
export const ORG_TEMPLATE_FILES = TEMPLATE_FILES;
