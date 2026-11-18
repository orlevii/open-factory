export type AuthField = "name" | "handle" | "email" | "password";

/** Sentinel code for "the request never got a real answer from the server". */
export const NETWORK_ERROR = "NETWORK_ERROR";
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
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return { field: "email", message: "An account with this email already exists." };
    case "PASSWORD_TOO_SHORT":
      return { field: "password", message: "Password must be at least 8 characters." };
    case "INVALID_EMAIL_OR_PASSWORD":
      return { message: "Wrong email or password." };
    case NETWORK_ERROR:
      return { message: NETWORK_MESSAGE };
    default:
      return { message: message || "Something went wrong. Try again." };
  }
}

/** Gateway statuses a proxy (Vite dev, a reverse proxy) returns when the server behind it is down. */
const UNREACHABLE_STATUSES = new Set([0, 502, 503, 504]);

/** better-auth's client (better-fetch, no catchAllError) resolves `{ error }` for HTTP errors and
 *  rejects with the fetch TypeError when the server can't be reached at all. This maps both. */
export function mapAuthFailure(
  failure: { error: { code?: string; message?: string; status?: number } } | { thrown: unknown },
): { field?: AuthField; message: string } {
  if ("thrown" in failure) return mapAuthError(NETWORK_ERROR, "");
  const { code, message, status } = failure.error;
  if (!code && (status === undefined || UNREACHABLE_STATUSES.has(status)))
    return mapAuthError(NETWORK_ERROR, "");
  return mapAuthError(code, message ?? "");
}
