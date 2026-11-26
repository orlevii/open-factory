import type { TemplateIssue } from "@open-factory/shared";
import { ApiError, FieldError } from "../../errors.ts";
import { toolError } from "../server.ts";

/** The service's field names are the form's; a tool's parameters are named as the tool's input (spec §7.2). */
const TOOL_FIELD: Record<string, string> = {
  reportsTo: "reports_to",
  displayName: "display_name",
};

/** `path: message`, or the file when the issue has no path. */
const issueLine = (i: TemplateIssue) => {
  const where = i.path ?? i.file;
  return i.message.startsWith(where) ? i.message : `${where}: ${i.message}`;
};

/**
 * An org service's refusal as a tool error (spec §7.2): a `FieldError` becomes "handle: Another agent or person has this handle", an
 * `invalid_config` lists its error issues as `path: message` lines, any other `ApiError` (`OrgRefusedError`
 * included) is its own sentence. Anything else is a bug and is rethrown: the SDK answers it without the message.
 */
export function toolErrorOf(err: unknown): ReturnType<typeof toolError> {
  if (err instanceof FieldError) {
    const [field] = Object.keys((err.extra.fields as Record<string, string>) ?? {});
    return toolError(field ? `${TOOL_FIELD[field] ?? field}: ${err.message}` : err.message);
  }
  if (err instanceof ApiError) {
    const issues =
      err.code === "invalid_config" ? (err.extra.issues as TemplateIssue[] | undefined) : undefined;
    const errors = issues?.filter((i) => i.severity === "error") ?? [];
    return toolError(errors.length ? errors.map(issueLine).join("\n") : err.message);
  }
  throw err;
}
