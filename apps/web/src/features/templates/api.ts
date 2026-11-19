import {
  apiFetch,
  type createTemplateBodySchema,
  issuesResponseSchema,
  putTemplateFileResponseSchema,
  type TemplateFile,
  type TemplateIssue,
  templateDetailResponseSchema,
  templatesListSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { z as zod } from "zod";

const path = (name: string) => `/api/templates/${encodeURIComponent(name)}`;

export const templatesQueryOptions = queryOptions({
  queryKey: ["templates"],
  queryFn: () => apiFetch("/api/templates", { schema: templatesListSchema }),
});

export const templateQueryOptions = (name: string) =>
  queryOptions({
    queryKey: ["templates", name],
    queryFn: () =>
      apiFetch(path(name), { schema: templateDetailResponseSchema }).then((r) => r.template),
    // The editor works on a file's bytes; a stale cache would hand it an old baseHash.
    staleTime: 0,
  });

export const createTemplate = (body: z.input<typeof createTemplateBodySchema>) =>
  apiFetch("/api/templates", { method: "POST", body, schema: templateDetailResponseSchema }).then(
    (r) => r.template,
  );

export const saveTemplateFile = (
  name: string,
  file: TemplateFile,
  content: string,
  baseHash: string | null,
): Promise<{ hash: string; issues: TemplateIssue[] }> =>
  apiFetch(`${path(name)}/files/${encodeURIComponent(file)}`, {
    method: "PUT",
    body: { content, baseHash },
    schema: putTemplateFileResponseSchema,
  });

export const validateTemplateFile = (
  name: string,
  file: TemplateFile,
  content: string,
): Promise<TemplateIssue[]> =>
  apiFetch(`${path(name)}/validate`, {
    method: "POST",
    body: { file, content },
    schema: issuesResponseSchema,
  }).then((r) => r.issues);

export const deleteTemplate = (name: string) =>
  apiFetch(path(name), { method: "DELETE", schema: zod.undefined() });
