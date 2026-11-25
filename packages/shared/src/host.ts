import { z } from "zod";

/** `GET /api/host`: facts about the factory's machine, for path help (I6). `platform` is Node's `process.platform`. */
export const hostInfoSchema = z.object({
  platform: z.string(),
  hostname: z.string(),
  home: z.string(),
});

/** A host path the factory accepts: absolute, `~`, or `~/…` (expanded server-side). */
export const isHostPathShape = (p: string) => p.startsWith("/") || p === "~" || p.startsWith("~/");
