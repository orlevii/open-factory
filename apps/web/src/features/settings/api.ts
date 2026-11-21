import {
  apiFetch,
  type CredentialKind,
  createInviteResponseSchema,
  credentialResponseSchema,
  credentialsListSchema,
  factorySettingsSchema,
  inviteItemSchema,
  type PatchFactorySettings,
  projectResponseSchema,
  projectsListSchema,
  secretSummarySchema,
  secretsListSchema,
  usersAdminListSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

const none = z.undefined();
const enc = encodeURIComponent;

export const credentialsQueryOptions = queryOptions({
  queryKey: ["credentials"],
  // No WebSocket event invalidates it: refetch on focus and mount.
  staleTime: 0,
  queryFn: () =>
    apiFetch("/api/credentials", { schema: credentialsListSchema }).then((r) => r.credentials),
});
export const createCredential = (body: { name: string; kind: CredentialKind; value: string }) =>
  apiFetch("/api/credentials", { method: "POST", body, schema: credentialResponseSchema }).then(
    (r) => r.credential,
  );
export const replaceCredential = (name: string, value: string) =>
  apiFetch(`/api/credentials/${enc(name)}/value`, {
    method: "PUT",
    body: { value },
    schema: credentialResponseSchema,
  }).then((r) => r.credential);
export const verifyCredential = (name: string) =>
  apiFetch(`/api/credentials/${enc(name)}/verify`, {
    method: "POST",
    body: {},
    schema: credentialResponseSchema,
  }).then((r) => r.credential);
export const deleteCredential = (name: string) =>
  apiFetch(`/api/credentials/${enc(name)}`, { method: "DELETE", schema: none });

export const secretsQueryOptions = queryOptions({
  queryKey: ["secrets"],
  // No WebSocket event invalidates it: refetch on focus and mount.
  staleTime: 0,
  queryFn: () => apiFetch("/api/secrets", { schema: secretsListSchema }).then((r) => r.secrets),
});
export const putSecret = (name: string, value: string) =>
  apiFetch(`/api/secrets/${enc(name)}`, {
    method: "PUT",
    body: { value },
    schema: z.object({ secret: secretSummarySchema }),
  }).then((r) => r.secret);
export const deleteSecret = (name: string) =>
  apiFetch(`/api/secrets/${enc(name)}`, { method: "DELETE", schema: none });

export const projectsQueryOptions = queryOptions({
  queryKey: ["projects"],
  // No WebSocket event invalidates it: refetch on focus and mount.
  staleTime: 0,
  queryFn: () => apiFetch("/api/projects", { schema: projectsListSchema }).then((r) => r.projects),
});
export const createProject = (body: { name: string; hostPath: string }) =>
  apiFetch("/api/projects", { method: "POST", body, schema: projectResponseSchema }).then(
    (r) => r.project,
  );
export const updateProject = (name: string, hostPath: string) =>
  apiFetch(`/api/projects/${enc(name)}`, {
    method: "PATCH",
    body: { hostPath },
    schema: projectResponseSchema,
  }).then((r) => r.project);
export const deleteProject = (name: string) =>
  apiFetch(`/api/projects/${enc(name)}`, { method: "DELETE", schema: none });

export const factorySettingsQueryOptions = queryOptions({
  queryKey: ["factory-settings"],
  queryFn: () => apiFetch("/api/settings/factory", { schema: factorySettingsSchema }),
});
export const patchFactorySettings = (body: PatchFactorySettings) =>
  apiFetch("/api/settings/factory", { method: "PATCH", body, schema: factorySettingsSchema });

export const usersQueryOptions = queryOptions({
  queryKey: ["users"],
  queryFn: () => apiFetch("/api/users", { schema: usersAdminListSchema }).then((r) => r.users),
});
export const disableUser = (id: string) =>
  apiFetch(`/api/users/${enc(id)}/disable`, {
    method: "POST",
    body: {},
    schema: z.object({ revokedInvites: z.number().int() }),
  });
export const enableUser = (id: string) =>
  apiFetch(`/api/users/${enc(id)}/enable`, { method: "POST", body: {}, schema: none });

export const invitesQueryOptions = queryOptions({
  queryKey: ["invites"],
  queryFn: () =>
    apiFetch("/api/invites", { schema: z.object({ invites: z.array(inviteItemSchema) }) }).then(
      (r) => r.invites,
    ),
});
export const createInvite = () =>
  apiFetch("/api/invites", { method: "POST", body: {}, schema: createInviteResponseSchema });
export const revokeInvite = (id: string) =>
  apiFetch(`/api/invites/${enc(id)}/revoke`, { method: "POST", body: {}, schema: none });
export const restoreInvite = (id: string) =>
  apiFetch(`/api/invites/${enc(id)}/restore`, { method: "POST", body: {}, schema: none });
