import { signUpSchema } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { z } from "zod";
import { AuthCard } from "@/components/auth-card";
import {
  type AuthField,
  authErrorCode,
  FIRST_USER_MESSAGE,
  mapAuthError,
  mapAuthFailure,
} from "@/components/auth-error";
import { ErrorLine } from "@/components/error-line";
import { FormField } from "@/components/form-field";
import { NO_OUTCOME, useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { signUpStateQueryOptions } from "@/features/auth/api";
import { authClient } from "@/lib/auth-client";
import { FORM_MSG } from "@/lib/form-messages.ts";
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
            {state.data.invite === "invalid" ? FORM_MSG.inviteInvalid : FORM_MSG.inviteMissing}
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
const FIELDS: readonly AuthField[] = ["name", "handle", "email", "password"];

function SignUp({ invite, bootstrap }: { invite?: string; bootstrap: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>({ name: "", handle: "", email: "", password: "" });
  const o = useOutcome();
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const check = (field: AuthField) => () =>
    signUpSchema.shape[field].safeParse(values[field]).error?.issues[0]?.message;
  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      name: check("name"),
      handle: check("handle"),
      email: check("email"),
      password: check("password"),
    },
  });

  const set = (field: AuthField, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    f.change(field);
  };

  async function submit() {
    o.clear();
    if (!f.submit()) return;
    const parsed = signUpSchema.parse(values);
    setSubmitting(true);
    try {
      // `invite` isn't a user field the client knows; the server's catch-all consumes it (spec §9.3).
      const withInvite = { ...parsed, ...(invite ? { invite } : {}) };
      const body: typeof parsed = withInvite;
      const failure = await authClient.signUp.email(body).then(
        ({ error }) => (error ? { error } : null),
        (thrown: unknown) => ({ thrown }),
      );
      if (failure) {
        const m = mapAuthFailure(failure);
        if (bootstrap && "error" in failure && authErrorCode(failure.error) === "invite_required")
          m.message = FORM_MSG.inviteLostRace;
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
      title="Create your account"
      submitLabel="Sign up"
      pendingLabel="Signing up…"
      submitting={submitting}
      outcome={o.outcome}
      ref={formRef}
      onSubmit={() => void submit()}
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
        onBlur={(e) => f.blur("name", e)}
        error={f.errors.name}
      />
      <FormField
        name="handle"
        label="Handle"
        prefix="@"
        help="How agents and people mention you, like @alice. You can change it later."
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={40}
        className="font-mono"
        value={values.handle}
        onChange={(e) => set("handle", e.target.value.toLowerCase())}
        onBlur={(e) => f.blur("handle", e)}
        error={f.errors.handle}
      />
      <FormField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={(e) => set("email", e.target.value)}
        onBlur={(e) => f.blur("email", e)}
        error={f.errors.email}
      />
      <FormField
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        help="At least 8 characters."
        value={values.password}
        onChange={(e) => set("password", e.target.value)}
        onBlur={(e) => f.blur("password", e)}
        error={f.errors.password}
      />
    </AuthCard>
  );
}
