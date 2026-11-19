import { createHash } from "node:crypto";
import type { Mount } from "@open-factory/harness";

/** Bump when the launcher's create options change in a way existing containers must pick up. */
export const LAUNCHER_VERSION = 1;

export const EXTRA_HOSTS = ["host.docker.internal:host-gateway"];
export const SECURITY_OPT = ["no-new-privileges:true"];
export const TMPFS: Record<string, string> = { "/run/open-factory": "" };

/**
 * Spec §11.2: sha256 over the local image id, the sorted mounts, HOST_UID/HOST_GID, the extra hosts, the security
 * options, the tmpfs and the launcher version. Only these fields are read, so nothing else a caller passes (secrets,
 * the credential, a slug) can re-create a container.
 */
export function specHash(i: {
  imageId: string;
  mounts: Mount[];
  uid: number;
  gid: number;
}): string {
  const mounts = i.mounts
    .map((m) => [m.source, m.target, m.readOnly] as const)
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = JSON.stringify({
    launcher: LAUNCHER_VERSION,
    imageId: i.imageId,
    mounts,
    uid: i.uid,
    gid: i.gid,
    extraHosts: EXTRA_HOSTS,
    securityOpt: SECURITY_OPT,
    tmpfs: Object.entries(TMPFS).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
