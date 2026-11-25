import { z } from "zod";

/** One project's result of a spawned agent's worktree cleanup (spec §7.5). */
export const projectResultSchema = z.object({
  project: z.string(),
  removed: z.boolean(),
  deleted: z.array(z.string()),
  kept: z.array(
    z.object({
      branch: z.string(),
      commits: z.number().int().optional(),
      reason: z.literal("elsewhere").optional(),
    }),
  ),
  /** The whole sentence after "<project>: " (e.g. "couldn't clean up: not a git repository"); the renderer adds only the project prefix. */
  error: z.string().optional(),
});
export type ProjectResult = z.infer<typeof projectResultSchema>;

/**
 * A spawned agent's `workspace_cleanup` result (I8 §7.5): the session event's payload and a `worktrees_kept` inbox
 * item's `cleanup` (§7.6). `host` is set when git is unavailable on the factory host, so no project could be checked.
 */
export const cleanupSchema = z.object({
  projects: z.array(projectResultSchema),
  host: z.enum(["missing", "too_old"]).optional(),
});
export type Cleanup = z.infer<typeof cleanupSchema>;
