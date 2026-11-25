import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { SheetBody } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { credentialsQueryOptions } from "@/features/settings/api";
import { restartNote } from "@/features/settings/shared";
import { isLiveReplace, signInQueryOptions } from "@/features/settings/sign-in/api";
import { SignInPanel } from "@/features/settings/sign-in/sign-in-panel";
import { useSignIn } from "@/features/settings/sign-in/use-sign-in";
import { useFocusOnOpen } from "./focus-on-open";
import { SheetFormFooter } from "./form-footer";
import type { BodyProps } from "./sheet-bodies";

const FIELDS = ["code"] as const;
const CHECKS = {};
const PRIMARY = 'button[type="submit"]';
const LINK = "[data-sign-in-link]";

/**
 * The Sign in again sheet body (spec §8.5): the sign-in panel for `replace`, no Name or Method. Start sign-in, then
 * Sign in and replace. A restored attempt moves focus itself (to Open sign-in page), so the mount focus follows it.
 */
export default function SignInAgainSheet({
  spec,
  close,
}: BodyProps<{ kind: "sign-in-again"; name: string }>) {
  // Two independent reads, both warm from `prefetch` (no `enabled` chain). The credentials one is unused here:
  // it keeps the list observed. The sign-in answer decides the mount focus.
  useQuery(credentialsQueryOptions);
  const { data: status } = useQuery(signInQueryOptions);
  const restoring = isLiveReplace(status, spec.name);
  const form = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const o = useOutcome();
  const f = useFieldErrors<"code">({ form, fields: FIELDS, checks: CHECKS });
  const s = useSignIn({
    purpose: "replace",
    name: spec.name,
    fields: f,
    outcome: o,
    onDone(c) {
      notify({ text: `Signed in again: ${c.name}. ${restartNote(c.usedBy)}`.trim() });
      close();
    },
  });
  useFocusOnOpen(form, restoring ? LINK : PRIMARY);

  // Without python3 on the server the panel says why and the footer has no primary (spec §8.2, R1).
  const unavailable = !s.available && s.phase === "idle";
  const label =
    s.phase === "ready"
      ? "Sign in and replace"
      : s.line?.tone === "error"
        ? "Start again"
        : "Start sign-in";

  return (
    <form
      ref={form}
      aria-label="Sign in again"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (s.pendingLabel !== undefined || unavailable) return;
        if (s.phase === "ready") void s.submit();
        else void s.start();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="field-stack content-start">
        <SignInPanel s={s} frame="sheet" codeRef={codeRef} />
      </SheetBody>
      <SheetFormFooter
        outcome={o.outcome}
        submitLabel={label}
        pendingLabel={s.pendingLabel ?? ""}
        pending={s.pendingLabel !== undefined}
        restored={false}
        onDiscard={() => {}}
        hideSubmit={unavailable}
      />
    </form>
  );
}
