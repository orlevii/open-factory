import { MSG } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { z } from "zod";
import { AuthCard } from "@/components/auth-card";
import { mapAuthError, mapAuthFailure } from "@/components/auth-error";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { signUpStateQueryOptions } from "@/features/auth/api";
import { authClient } from "@/lib/auth-client";
import { refreshSession, sessionQueryOptions } from "@/lib/session";

export const Route = createFileRoute("/sign-in")({
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(sessionQueryOptions))
      throw redirect({ to: "/inbox" });
  },
  component: SignIn,
});

const signInSchema = z.object({
  email: z.email(MSG.email),
  password: z.string().min(1, MSG.passwordRequired),
});
type Field = "email" | "password";
const FIELDS: readonly Field[] = ["email", "password"];

function SignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The "Sign up" link shows only while the factory has no users yet (invite-only afterwards).
  const bootstrap = useQuery(signUpStateQueryOptions()).data?.bootstrap === true;
  const [values, setValues] = useState({ email: "", password: "" });
  const o = useOutcome();
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      email: () => signInSchema.shape.email.safeParse(values.email).error?.issues[0]?.message,
      password: () =>
        signInSchema.shape.password.safeParse(values.password).error?.issues[0]?.message,
    },
  });

  const set = (field: Field, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    f.change(field);
  };

  async function submit() {
    o.clear();
    if (!f.submit()) return;
    const parsed = signInSchema.parse(values);
    setSubmitting(true);
    try {
      const failure = await authClient.signIn.email(parsed).then(
        ({ error }) => (error ? { error } : null),
        (thrown: unknown) => ({ thrown }),
      );
      if (failure) {
        const m = mapAuthFailure(failure);
        if (!f.server(m.field ? { [m.field]: m.message } : undefined)) o.fail(m.message);
        return;
      }
      await refreshSession(qc);
      await navigate({ to: "/inbox" });
    } catch {
      o.fail(mapAuthError(undefined, "").message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      submitLabel="Sign in"
      pendingLabel="Signing in…"
      submitting={submitting}
      outcome={o.outcome}
      ref={formRef}
      onSubmit={() => void submit()}
      footer={
        bootstrap ? (
          <span>
            No account yet?{" "}
            <Link
              to="/sign-up"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Sign up
            </Link>
          </span>
        ) : null
      }
    >
      <FormField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        autoFocus
        value={values.email}
        onChange={(e) => set("email", e.target.value)}
        onBlur={(e) => f.blur("email", e)}
        error={f.errors.email}
      />
      <FormField
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={values.password}
        onChange={(e) => set("password", e.target.value)}
        onBlur={(e) => f.blur("password", e)}
        error={f.errors.password}
      />
    </AuthCard>
  );
}
