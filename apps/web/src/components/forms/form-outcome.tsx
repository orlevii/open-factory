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

/** For forms that have no form-level message yet. A module constant, so it is referentially stable. */
export const NO_OUTCOME: Readonly<Outcome> = Object.freeze({ outcomeKey: 0 });

const present = (n: ReactNode) => n != null && n !== false && n !== "";

/** Whether `FormOutcome` shows the notice: only while there is neither an error nor a success. A control the notice
 *  describes (`aria-describedby={noticeId}`) uses this, so the two cannot disagree. */
export const showsNotice = ({ error, success, notice }: Outcome) =>
  !present(error) && !present(success) && notice != null && notice !== "";

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
  const hasError = present(error);
  const hasSuccess = !hasError && present(success);
  const showNotice = showsNotice(outcome);
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
