import { signUpSchema } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { AuthCard } from "@/components/auth-card";
import {
  type AuthField,
  authErrorCode,
  FIRST_USER_MESSAGE,
  INVITE_INVALID_MESSAGE,
  INVITE_LOST_RACE_MESSAGE,
  INVITE_MISSING_MESSAGE,
  mapAuthError,
  mapAuthFailure,
} from "@/components/auth-error";
import { ErrorLine } from "@/components/error-line";
import { FormField } from "@/components/form-field";
import { focusField } from "@/components/forms/focus-field";
import { NO_OUTCOME, useOutcome } from "@/components/forms/form-outcome";
import { signUpStateQueryOptions } from "@/features/auth/api";
import { authClient } from "@/lib/auth-client";
import { refreshSession, sessionQueryOptions } from "@/lib/session";

export const Route = createFileRoute("/sign-up")({
  validateSearch: z.object({ invite: z.string().optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ invite: search.invite }),
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(sessionQueryOptions))
      throw redirect({ to: "/inbox" });
  },
  // Only so the first load shows the pending mark; a failure renders as the error line.
  loader: async ({ context, deps }) => {
    await context.queryClient
      .fetchQuery(signUpStateQueryOptions(deps.invite))
      .catch(() => undefined);
  },
  component: SignUpPage,
});

function SignUpPage() {
  const { invite } = Route.useSearch();
  const state = useQuery(signUpStateQueryOptions(invite));
  if (state.data) {
    // While bootstrapping any sign-up succeeds, so a stale or junk invite doesn't block the form.
    if (!state.data.bootstrap && state.data.invite !== "valid")
      return (
        <AuthCard
          title="Create your account"
          submitLabel="Sign up"
          pendingLabel="Signing up…"
          submitting={false}
          hideSubmit
          outcome={NO_OUTCOME}
          onSubmit={() => {}}
          footer={<SignInLink />}
        >
          <p role="status" className="text-[0.8125rem] leading-[1.125rem]">
            {state.data.invite === "invalid" ? INVITE_INVALID_MESSAGE : INVITE_MISSING_MESSAGE}
          </p>
        </AuthCard>
      );
    return <SignUp invite={invite} bootstrap={state.data.bootstrap} />;
  }
  if (state.isError)
    return (
      <AuthCard
        title="Create your account"
        submitLabel="Sign up"
        pendingLabel="Signing up…"
        submitting={false}
        hideSubmit
        outcome={NO_OUTCOME}
        onSubmit={() => {}}
        footer={<SignInLink />}
      >
        <ErrorLine text="Couldn't check this sign-up link." onRetry={() => void state.refetch()} />
      </AuthCard>
    );
  return null;
}

function SignInLink() {
  return (
    <span>
      Already have an account?{" "}
      <Link to="/sign-in" className="font-medium text-foreground underline underline-offset-4">
        Sign in
      </Link>
    </span>
  );
}

type Values = Record<AuthField, string>;
type Errors = Partial<Record<AuthField, string>>;

function SignUp({ invite, bootstrap }: { invite?: string; bootstrap: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>({ name: "", handle: "", email: "", password: "" });
  const [errors, setErrors] = useState<Errors>({});
  const o = useOutcome();
  const [submitting, setSubmitting] = useState(false);

  // Editing a field clears its error; there is no live re-validation while typing.
  const set = (field: AuthField, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  };

  const showFieldErrors = (form: HTMLFormElement, next: Errors) => {
    flushSync(() => setErrors(next));
    focusField(form);
  };

  async function submit(form: HTMLFormElement) {
    o.clear();
    const parsed = signUpSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as AuthField;
        next[field] ??= issue.message;
      }
      showFieldErrors(form, next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      // `invite` isn't a user field the client knows; the server's catch-all consumes it (spec §9.3).
      const withInvite = { ...parsed.data, ...(invite ? { invite } : {}) };
      const body: typeof parsed.data = withInvite;
      const failure = await authClient.signUp.email(body).then(
        ({ error }) => (error ? { error } : null),
        (thrown: unknown) => ({ thrown }),
      );
      if (failure) {
        const m = mapAuthFailure(failure);
        if (bootstrap && "error" in failure && authErrorCode(failure.error) === "invite_required")
          m.message = INVITE_LOST_RACE_MESSAGE;
        if (m.field) showFieldErrors(form, { [m.field]: m.message });
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
      title="Create your account"
      submitLabel="Sign up"
      pendingLabel="Signing up…"
      submitting={submitting}
      outcome={o.outcome}
      onSubmit={(form) => void submit(form)}
      footer={<SignInLink />}
    >
      {bootstrap && <p className="text-[0.8125rem] leading-[1.125rem]">{FIRST_USER_MESSAGE}</p>}
      <FormField
        name="name"
        label="Name"
        autoComplete="name"
        autoFocus
        value={values.name}
        onChange={(e) => set("name", e.target.value)}
        error={errors.name}
      />
      <FormField
        name="handle"
        label="Handle"
        prefix="@"
        help="How agents mention you, like @alice. Lowercase letters, numbers and hyphens."
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={32}
        className="font-mono"
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
        help="At least 8 characters."
        value={values.password}
        onChange={(e) => set("password", e.target.value)}
        error={errors.password}
      />
    </AuthCard>
  );
}
