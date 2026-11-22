import { EMAIL_TOO_LONG_MESSAGE, NAME_TOO_LONG_MESSAGE } from "@open-factory/shared";

export type AuthField = "name" | "handle" | "email" | "password";

/** Sentinel code for "the request never got a real answer from the server". */
export const NETWORK_ERROR = "NETWORK_ERROR";
export const INVITE_MISSING_MESSAGE = "Sign-up needs an invite link from a member of this factory.";
export const INVITE_INVALID_MESSAGE =
  "This invite link isn't valid anymore. Ask a member of this factory for a new one.";
export const INVITE_LOST_RACE_MESSAGE =
  "Someone else just became the first user. Ask them for an invite link.";
export const FIRST_USER_MESSAGE =
  "You're the first user of this factory. You'll invite everyone else from Settings → Users.";
export const DISABLED_MESSAGE =
  "This account is disabled. Ask a member of this factory to enable it.";
export const NETWORK_MESSAGE = "Can't reach the server. Check that it's running, then try again.";

/** Maps better-auth error codes to a form field (spec §7.4). Anything unknown is form-level. */
export function mapAuthError(
  code: string | undefined,
  message: string,
): { field?: AuthField; message: string } {
  switch (code) {
    case "HANDLE_TAKEN":
      return { field: "handle", message: "That handle is already taken." };
    case "VALIDATION_ERROR":
      return { field: "handle", message }; // handle is the only validated additional field (spec §7.4)
    case "NAME_TOO_LONG":
      return { field: "name", message: NAME_TOO_LONG_MESSAGE };
    case "EMAIL_TOO_LONG":
      return { field: "email", message: EMAIL_TOO_LONG_MESSAGE };
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return { field: "email", message: "An account with this email already exists." };
    case "PASSWORD_TOO_SHORT":
      return { field: "password", message: "Password must be at least 8 characters." };
    case "INVALID_EMAIL_OR_PASSWORD":
      return { message: "Wrong email or password." };
    case "invite_invalid":
      return { message: INVITE_INVALID_MESSAGE };
    case "invite_required":
      return { message: INVITE_MISSING_MESSAGE };
    case "USER_DISABLED":
      return { message: DISABLED_MESSAGE };
    case NETWORK_ERROR:
      return { message: NETWORK_MESSAGE };
    default:
      return { message: message || "Something went wrong. Try again." };
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
