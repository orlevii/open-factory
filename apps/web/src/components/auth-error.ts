import { MSG } from "@open-factory/shared";
import { FORM_MSG } from "@/lib/form-messages.ts";

export type AuthField = "name" | "handle" | "email" | "password";

/** Sentinel code for "the request never got a real answer from the server". */
export const NETWORK_ERROR = "NETWORK_ERROR";
export const FIRST_USER_MESSAGE =
  "You're the first user of this factory. You'll invite everyone else from Settings → Users.";

/** Maps better-auth error codes to a form field (spec §7.4). Anything unknown is form-level. */
export function mapAuthError(
  code: string | undefined,
  message: string,
): { field?: AuthField; message: string } {
  switch (code) {
    case "HANDLE_TAKEN":
      return { field: "handle", message: MSG.handleTaken };
    case "VALIDATION_ERROR":
      return { field: "handle", message }; // handle is the only validated additional field (spec §7.4)
    case "NAME_TOO_LONG":
      return { field: "name", message: MSG.userNameLength };
    case "EMAIL_TOO_LONG":
      return { field: "email", message: MSG.emailLength };
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return { field: "email", message: MSG.emailTaken };
    case "PASSWORD_TOO_SHORT":
      return { field: "password", message: MSG.passwordLength };
    case "INVALID_EMAIL_OR_PASSWORD":
      return { message: FORM_MSG.wrongPassword };
    case "invite_invalid":
      return { message: FORM_MSG.inviteInvalid };
    case "invite_required":
      return { message: FORM_MSG.inviteMissing };
    case "USER_DISABLED":
      return { message: FORM_MSG.accountDisabled };
    case NETWORK_ERROR:
      return { message: FORM_MSG.unreachable };
    default:
      return { message: message || FORM_MSG.somethingWrong };
  }
}

/** Gateway statuses a proxy (Vite dev, a reverse proxy) returns when the server behind it is down. */
const UNREACHABLE_STATUSES = new Set([0, 502, 503, 504]);

/** What better-auth's client resolves as `error`: better-fetch spreads the parsed JSON body next to
 *  `status`. better-auth's own errors are a top-level `{ code, message }`; the S10 sign-up gate
 *  answers in the app's ApiError envelope, `{ error: { code, message } }`. */
export type AuthClientError = {
  code?: string;
  message?: string;
  status?: number;
  error?: { code?: string; message?: string };
};

/** The error code of a resolved failure, top-level or nested; undefined for none. */
export function authErrorCode(error: AuthClientError): string | undefined {
  return error.code ?? (typeof error.error === "object" ? error.error.code : undefined);
}

/** better-auth's client (better-fetch, no catchAllError) resolves `{ error }` for HTTP errors and
 *  rejects with the fetch TypeError when the server can't be reached at all. This maps both. */
export function mapAuthFailure(failure: { error: AuthClientError } | { thrown: unknown }): {
  field?: AuthField;
  message: string;
} {
  if ("thrown" in failure) return mapAuthError(NETWORK_ERROR, "");
  const { status } = failure.error;
  const code = authErrorCode(failure.error);
  const message =
    failure.error.message ??
    (typeof failure.error.error === "object" ? failure.error.error.message : undefined);
  if (!code && (status === undefined || UNREACHABLE_STATUSES.has(status)))
    return mapAuthError(NETWORK_ERROR, "");
  return mapAuthError(code, message ?? "");
}
