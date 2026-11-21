import { CircleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect } from "react";
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
  formError?: string;
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
        <form onSubmit={submit} noValidate className="grid gap-4">
          {props.children}
          {props.formError && (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {props.formError}
            </p>
          )}
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

/** After a failed submit, move focus to the first invalid field (call after the errors rendered). */
export function focusFirstInvalid(form: HTMLFormElement) {
  form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
