import {
  apiFetch,
  type CredentialKind,
  credentialResponseSchema,
  credentialsListSchema,
  projectResponseSchema,
  projectsListSchema,
  secretSummarySchema,
  secretsListSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

const none = z.undefined();
const enc = encodeURIComponent;

export const credentialsQueryOptions = queryOptions({
  queryKey: ["credentials"],
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
