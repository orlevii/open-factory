import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { AuthCard } from "@/components/auth-card";
import { mapAuthError } from "@/components/auth-error";
import { FormField } from "@/components/form-field";
import { authClient } from "@/lib/auth-client";
import { refreshSession, sessionQueryOptions } from "@/lib/session";

export const Route = createFileRoute("/sign-in")({
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(sessionQueryOptions)) throw redirect({ to: "/" });
  },
  component: SignIn,
});

const signInSchema = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
type Field = "email" | "password";

function SignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [values, setValues] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setFormError(undefined);
    const parsed = signInSchema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as Field] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const { error } = await authClient.signIn.email(parsed.data);
      if (error) {
        const m = mapAuthError(error.code, error.message ?? "");
        if (m.field === "email" || m.field === "password") setErrors({ [m.field]: m.message });
        else setFormError(m.message);
        return;
      }
      await refreshSession(qc);
      await navigate({ to: "/" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Sign in"
      submitLabel="Sign in"
      submitting={submitting}
      formError={formError}
      onSubmit={submit}
      footer={
        <span>
          New here?{" "}
          <Link to="/sign-up" className="text-foreground underline underline-offset-4">
            Create an account
          </Link>
        </span>
      }
    >
      <FormField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
        error={errors.email}
      />
      <FormField
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={values.password}
        onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
        error={errors.password}
      />
    </AuthCard>
  );
}
