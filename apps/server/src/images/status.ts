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
import { contextHash, ImageNameError, imageDir } from "./context.ts";
import { resolveImage } from "./resolve.ts";

export interface StatusDeps {
  docker: DockerClient;
  builder: Pick<ImageBuilder, "running" | "last">;
  imagesRoot: string;
  log: { warn: (obj: object, msg: string) => void };
  /** One status per image per request, shared across the templates that use it (see `statusMemo`). */
  memo?: Map<string, Promise<unknown>>;
}

/** A fresh per-request memo for `StatusDeps.memo`. */
export const statusMemo = () => new Map<string, Promise<unknown>>();

function once<T>(d: StatusDeps, key: string, f: () => Promise<T>): Promise<T> {
  if (!d.memo) return f();
  const hit = d.memo.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = f();
  d.memo.set(key, p);
  return p;
}

const isFile = async (p: string) => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

/**
 * Any Docker error reads as `unknown` (a 404 is already `undefined`): an image's status never fails a
 * list or a template page. Anything but an unreachable daemon is logged at warn.
 */
async function orUnknown<T>(
  d: StatusDeps,
  ref: string,
  f: () => Promise<T>,
): Promise<T | "unknown"> {
  try {
    return await f();
  } catch (err) {
    if (!dockerUnreachable(err)) d.log.warn({ err, ref }, "image inspect failed; status unknown");
    return "unknown";
  }
}

/** Spec §10.4, rows in order: derived on each read from the folder, the builder and the local image. */
export function imageStatus(d: StatusDeps, name: string): Promise<ImageItem> {
  return once(d, `user:${name}`, () => computeImageStatus(d, name));
}

async function computeImageStatus(d: StatusDeps, name: string): Promise<ImageItem> {
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
  // The builder's confinement rule (a direct child of images/ by real path): nothing outside is read.
  let dir: string;
  try {
    dir = await imageDir(d.imagesRoot, name);
  } catch (err) {
    if (err instanceof ImageNameError) return { ...base, status: "no_dockerfile" };
    throw err;
  }
  if (!(await isFile(join(dir, "Dockerfile")))) return { ...base, status: "no_dockerfile" };
  if (d.builder.running(name)) return { ...base, status: "building" };

  const tag = userImageTag(name);
  const image = await orUnknown(d, tag, () => d.docker.imageInspect(tag));
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
  const ref = r.ref;
  const image = await once(d, `registry:${ref}`, () =>
    orUnknown(d, ref, () => d.docker.imageInspect(ref)),
  );
  return {
    kind: "registry",
    name: ref,
    status: image === "unknown" ? "unknown" : image ? "present" : "pulled_on_start",
  };
}
