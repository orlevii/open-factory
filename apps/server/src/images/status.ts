import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ImageItem,
  type ImageStatus,
  isUserImageRef,
  LABEL_BUILT_AT,
  LABEL_CONTEXT_HASH,
  type TemplateConfig,
  userImageTag,
} from "@open-factory/shared";
import type { DockerClient } from "../runtime/docker/client.ts";
import { dockerUnreachable } from "../runtime/docker/errors.ts";
import type { TemplateRow } from "../templates/template-index.ts";
import type { ImageBuilder } from "./builder.ts";
import { contextHash } from "./context.ts";
import { resolveImage } from "./resolve.ts";

export interface StatusDeps {
  docker: DockerClient;
  builder: Pick<ImageBuilder, "running" | "last">;
  imagesRoot: string;
}

const isFile = async (p: string) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

/** Docker unreachable reads as `unknown`; any other Docker error is a real failure. */
async function orUnknown<T>(f: () => Promise<T>): Promise<T | "unknown"> {
  try {
    return await f();
  } catch (err) {
    if (dockerUnreachable(err)) return "unknown";
    throw err;
  }
}

/** Spec §10.4, rows in order: derived on each read from the folder, the builder and the local image. */
export async function imageStatus(d: StatusDeps, name: string): Promise<ImageItem> {
  const dir = join(d.imagesRoot, name);
  const last = d.builder.last(name);
  const base = {
    name,
    usedBy: [] as string[],
    ...(last
      ? {
          lastBuild: {
            state: last.state,
            finishedAt: last.finishedAt.toISOString(),
            ...(last.error !== undefined ? { error: last.error } : {}),
            durationMs: last.durationMs,
          },
        }
      : {}),
  };
  if (!(await isFile(join(dir, "Dockerfile")))) return { ...base, status: "no_dockerfile" };
  if (d.builder.running(name)) return { ...base, status: "building" };

  const image = await orUnknown(() => d.docker.imageInspect(userImageTag(name)));
  if (image === "unknown") return { ...base, status: "unknown" };
  const builtAt = image?.labels[LABEL_BUILT_AT];
  const hash = image?.labels[LABEL_CONTEXT_HASH];
  const fromImage = {
    ...base,
    ...(builtAt ? { builtAt } : {}),
    ...(hash ? { contextHash: hash } : {}),
  };

  const builtMs = builtAt ? Date.parse(builtAt) : Number.NaN;
  if (
    last?.state === "failed" &&
    (!image || Number.isNaN(builtMs) || last.finishedAt.getTime() > builtMs)
  )
    return { ...fromImage, status: "failed" };
  if (!image) return { ...base, status: "not_built" };
  // A folder that can't be packed (a link outside it) can't match any image.
  const current = await contextHash(dir, name).catch(() => undefined);
  return { ...fromImage, status: hash !== undefined && hash === current ? "built" : "out_of_date" };
}

/** Every folder in images/ with a valid name, sorted, with the templates whose `image:` names it. */
export async function listImages(d: StatusDeps, templates: TemplateRow[]): Promise<ImageItem[]> {
  const entries = await readdir(d.imagesRoot, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => e.isDirectory() && isUserImageRef(e.name))
    .map((e) => e.name)
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      ...(await imageStatus(d, name)),
      usedBy: templates
        .filter((t) => t.config?.image === name)
        .map((t) => t.name)
        .sort(),
    })),
  );
}

/** A template's image as it would start (spec §10.4); undefined for a broken or local-runtime template. */
export async function templateImageStatus(
  d: StatusDeps,
  config: TemplateConfig | undefined,
  defaultImage: string,
): Promise<ImageStatus | undefined> {
  if (!config || config.runtime === "local") return undefined;
  const r = resolveImage(config.image, defaultImage);
  if (r.kind === "user")
    return { kind: "user", name: r.name, status: (await imageStatus(d, r.name)).status };
  const image = await orUnknown(() => d.docker.imageInspect(r.ref));
  return {
    kind: "registry",
    name: r.ref,
    status: image === "unknown" ? "unknown" : image ? "present" : "pulled_on_start",
  };
}
