import { cn } from "cn";
import { CircleAlert, CircleCheck } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

export type Outcome = {
  error?: ReactNode;
  success?: ReactNode;
  notice?: ReactNode;
  outcomeKey: number;
  action?: ReactNode;
};

export function FormOutcome({
  outcome,
  pending,
  noticeId,
  className,
}: {
  outcome: Outcome;
  pending?: string;
  noticeId?: string;
  className?: string;
}) {
  const { error, success, notice, outcomeKey, action } = outcome;
  // Explicit checks, never `node && <…>` on a ReactNode (0 or "" would render).
  const hasError = error != null && error !== false && error !== "";
  const hasSuccess = !hasError && success != null && success !== false && success !== "";
  const showNotice = !hasError && !hasSuccess && notice != null && notice !== "";
  return (
    <div className={cn("form-outcome", className)}>
      <p
        id={noticeId}
        data-shown={showNotice ? "" : undefined}
        className="form-outcome-notice text-muted-foreground"
      >
        {notice}
      </p>
      <div role="alert">
        {hasError ? (
          <p
            key={outcomeKey}
            className="form-outcome-line flex items-start gap-1.5 text-destructive"
          >
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
            {action}
          </p>
        ) : null}
      </div>
      <div role="status">
        {hasSuccess ? (
          <p key={outcomeKey} className="form-outcome-line flex items-start gap-1.5">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span className="min-w-0">{success}</span>
          </p>
        ) : null}
      </div>
      <span role="status" className="sr-only">
        {pending ?? ""}
      </span>
    </div>
  );
}

export function useOutcome() {
  // One state for message and key: the key can never lag its message.
  const [outcome, setOutcome] = useState<Outcome>({ outcomeKey: 0 });
  // Functional updaters keep these referentially stable, so forms may depend on them.
  const fail = useCallback(
    (error: ReactNode, action?: ReactNode) =>
      setOutcome((s) => ({ error, action, outcomeKey: s.outcomeKey + 1 })),
    [],
  );
  const succeed = useCallback(
    (success: ReactNode) => setOutcome((s) => ({ success, outcomeKey: s.outcomeKey + 1 })),
    [],
  );
  const clear = useCallback(
    () =>
      setOutcome((s) => (s.error == null && s.success == null ? s : { outcomeKey: s.outcomeKey })),
    [],
  );
  return { outcome, fail, succeed, clear };
}
