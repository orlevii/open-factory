import { z } from "zod";

export const USER_IMAGE_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const isUserImageRef = (ref: string) => USER_IMAGE_NAME.test(ref);
export const userImageTag = (name: string) => `open-factory-user/${name}:latest`;
export const LABEL_CONTEXT_HASH = "io.open-factory.context-hash";
export const LABEL_BUILT_AT = "io.open-factory.built-at";

export const IMAGE_STATUSES = [
  "no_dockerfile",
  "building",
  "failed",
  "not_built",
  "out_of_date",
  "built",
  "unknown",
] as const;
export const TEMPLATE_IMAGE_STATUSES = [...IMAGE_STATUSES, "present", "pulled_on_start"] as const;

export const imageStatusSchema = z.object({
  kind: z.enum(["user", "registry"]),
  name: z.string(),
  status: z.enum(TEMPLATE_IMAGE_STATUSES),
});
export type ImageStatus = z.infer<typeof imageStatusSchema>;

export const imageItemSchema = z.object({
  name: z.string(),
  status: z.enum(IMAGE_STATUSES),
  builtAt: z.string().optional(),
  contextHash: z.string().optional(),
  usedBy: z.array(z.string()),
  lastBuild: z
    .object({
      state: z.enum(["succeeded", "failed"]),
      finishedAt: z.string(),
      error: z.string().optional(),
      durationMs: z.number(),
    })
    .optional(),
});
export type ImageItem = z.infer<typeof imageItemSchema>;
export const imagesListSchema = z.object({
  imagesDir: z.string(),
  baseImage: z.string(),
  images: z.array(imageItemSchema),
});
export type ImagesList = z.infer<typeof imagesListSchema>;
export const imageLogSchema = z.object({
  state: z.enum(["building", "succeeded", "failed"]).nullable(),
  lines: z.array(z.string()),
});
export const buildBodySchema = z.object({ pull: z.boolean().default(true) });
export const buildStreamLineSchema = z.union([
  z.object({ line: z.string() }),
  z.object({ state: z.enum(["succeeded", "failed"]), error: z.string().optional() }),
]);
