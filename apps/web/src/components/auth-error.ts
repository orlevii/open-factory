export type AuthField = "name" | "handle" | "email" | "password";

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
    default:
      return { message: message || "Something went wrong. Try again." };
  }
}
