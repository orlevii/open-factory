import { signUpSchema } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "@/components/auth-card";
import { type AuthField, mapAuthError } from "@/components/auth-error";
import { FormField } from "@/components/form-field";
import { authClient } from "@/lib/auth-client";
import { refreshSession, sessionQueryOptions } from "@/lib/session";

export const Route = createFileRoute("/sign-up")({
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(sessionQueryOptions)) throw redirect({ to: "/" });
  },
  component: SignUp,
});

type Values = Record<AuthField, string>;
type Errors = Partial<Record<AuthField, string>>;

function SignUp() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>({ name: "", handle: "", email: "", password: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const set = (field: AuthField, value: string) => setValues((v) => ({ ...v, [field]: value }));

  async function submit() {
    setFormError(undefined);
    const parsed = signUpSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as AuthField;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const { error } = await authClient.signUp.email(parsed.data);
      if (error) {
        const m = mapAuthError(error.code, error.message ?? "");
        if (m.field) setErrors({ [m.field]: m.message });
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
      title="Create your account"
      submitLabel="Sign up"
      submitting={submitting}
      formError={formError}
      onSubmit={submit}
      footer={
        <span>
          Already have an account?{" "}
          <Link to="/sign-in" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </span>
      }
    >
      <FormField
        name="name"
        label="Name"
        autoComplete="name"
        value={values.name}
        onChange={(e) => set("name", e.target.value)}
        error={errors.name}
      />
      <FormField
        name="handle"
        label="Handle"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={values.handle}
        onChange={(e) => set("handle", e.target.value.toLowerCase())}
        error={errors.handle}
      />
      <FormField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={(e) => set("email", e.target.value)}
        error={errors.email}
      />
      <FormField
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        value={values.password}
        onChange={(e) => set("password", e.target.value)}
        error={errors.password}
      />
    </AuthCard>
  );
}
