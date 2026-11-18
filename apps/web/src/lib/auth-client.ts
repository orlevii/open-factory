import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [inferAdditionalFields({ user: { handle: { type: "string", required: true } } })],
});

export type Session = typeof authClient.$Infer.Session;
