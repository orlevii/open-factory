import { createHash } from "node:crypto";
import type { Mount } from "@open-factory/harness";
import type { ContainerCreateOptions } from "./client.ts";

export const EXTRA_HOSTS = ["host.docker.internal:host-gateway"];
export const SECURITY_OPT = ["no-new-privileges:true"];
export const TMPFS: Record<string, string> = { "/run/open-factory": "" };

export interface SpecInputs {
  imageId: string;
  mounts: Mount[];
  uid: number;
  gid: number;
}

/**
 * Everything in a container's create options that decides what runs and how (spec §11.1): the image by id, `Env`
 * (`HOST_UID`/`HOST_GID` only) and the hardened `HostConfig` with the bind mounts sorted by target. `createOptions`
 * adds only the name and the labels (identity, not behaviour), so the spec hash, taken over this object, changes
 * whenever any option a container runs with changes.
 */
export function containerSpec(i: SpecInputs): ContainerCreateOptions {
  const mounts = [...i.mounts].sort((a, b) =>
    a.target !== b.target ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
  );
  return {
    Image: i.imageId,
    Env: [`HOST_UID=${i.uid}`, `HOST_GID=${i.gid}`],
    HostConfig: {
      Mounts: mounts.map((m) => ({
        Type: "bind" as const,
        Source: m.source,
        Target: m.target,
        ReadOnly: m.readOnly,
      })),
      Tmpfs: { ...TMPFS },
      ExtraHosts: [...EXTRA_HOSTS],
      SecurityOpt: [...SECURITY_OPT],
    },
  };
}

/** JSON with object keys sorted at every level, so the hash doesn't depend on key order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Spec §11.2: sha256 over the create options derived from the image id, the mounts and HOST_UID/HOST_GID (and so
 * also the extra hosts, the security options and the tmpfs). Only these inputs are read, so
 * nothing else a caller passes (secrets, the credential, a slug) can re-create a container.
 */
export function specHash(i: SpecInputs): string {
  const spec = containerSpec({ imageId: i.imageId, mounts: i.mounts, uid: i.uid, gid: i.gid });
  return createHash("sha256").update(stableJson(spec)).digest("hex");
}
