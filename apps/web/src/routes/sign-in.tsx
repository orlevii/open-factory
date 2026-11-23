import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { AuthCard } from "@/components/auth-card";
import { mapAuthError, mapAuthFailure } from "@/components/auth-error";
import { FormField } from "@/components/form-field";
import { focusField } from "@/components/forms/focus-field";
import { useOutcome } from "@/components/forms/form-outcome";
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
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
type Field = "email" | "password";
type Errors = Partial<Record<Field, string>>;

function SignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The "Sign up" link shows only while the factory has no users yet (invite-only afterwards).
  const bootstrap = useQuery(signUpStateQueryOptions()).data?.bootstrap === true;
  const [values, setValues] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState<Errors>({});
  const o = useOutcome();
  const [submitting, setSubmitting] = useState(false);

  // Editing a field clears its error; there is no live re-validation while typing.
  const set = (field: Field, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  };

  const showFieldErrors = (form: HTMLFormElement, next: Errors) => {
    flushSync(() => setErrors(next));
    focusField(form);
  };

  async function submit(form: HTMLFormElement) {
    o.clear();
    const parsed = signInSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as Field] ??= issue.message;
      showFieldErrors(form, next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const failure = await authClient.signIn.email(parsed.data).then(
        ({ error }) => (error ? { error } : null),
        (thrown: unknown) => ({ thrown }),
      );
      if (failure) {
        const m = mapAuthFailure(failure);
        if (m.field === "email" || m.field === "password")
          showFieldErrors(form, { [m.field]: m.message });
        else o.fail(m.message);
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
      onSubmit={(form) => void submit(form)}
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
        error={errors.email}
      />
      <FormField
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={values.password}
        onChange={(e) => set("password", e.target.value)}
        error={errors.password}
      />
    </AuthCard>
  );
}
