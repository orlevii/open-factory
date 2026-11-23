import { type FormEvent, type ReactNode, type Ref, useEffect } from "react";
import { FormOutcome, type Outcome } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Wordmark } from "@/components/wordmark";

/** The auth page frame (UI design §4.1): a bare narrow column on the page background, no card. */
export function AuthCard(props: {
  title: string;
  submitLabel: string;
  pendingLabel: string;
  submitting: boolean;
  /** Hides the submit button (states with no form to submit). */
  hideSubmit?: boolean;
  outcome: Outcome;
  ref?: Ref<HTMLFormElement>;
  onSubmit(form: HTMLFormElement): void;
  footer: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${props.title} · Open Factory`;
  }, [props.title]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    props.onSubmit(e.currentTarget);
  };
  return (
    <main className="flex min-h-svh justify-center px-4 py-12 sm:items-center">
      <div className="w-full max-w-[22rem]">
        <Wordmark className="mb-10 h-6" />
        <h1 className="mb-6 font-heading text-[1.375rem] leading-7 font-bold tracking-[-0.015em]">
          {props.title}
        </h1>
        <form ref={props.ref} onSubmit={submit} noValidate className="field-stack">
          {props.children}
          <FormOutcome outcome={props.outcome} className="-mt-2" />
          {!props.hideSubmit && (
            <Button type="submit" className="h-9 w-full" disabled={props.submitting}>
              {props.submitting && <Spinner size="text" />}
              {props.submitting ? props.pendingLabel : props.submitLabel}
            </Button>
          )}
        </form>
        <div className="mt-6 text-[0.8125rem] text-muted-foreground">{props.footer}</div>
      </div>
    </main>
  );
}
