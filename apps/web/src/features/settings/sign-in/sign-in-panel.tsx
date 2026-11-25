import { type AttemptView, MSG } from "@open-factory/shared";
import { cn } from "cn";
import { CircleAlert, Copy, ExternalLink } from "lucide-react";
import { type RefObject, useId } from "react";
import { CopyFailed, CopyIcon, useCopy } from "@/components/copy-feedback";
import { FieldShell } from "@/components/field-shell";
import { Button, buttonVariants, IN_FORM } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Line, SignIn } from "./use-sign-in";

/** One formatter for the deadline's fixed clock time in the browser's locale (D15), never built per render. */
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** "Opens claude.com in a new tab · Expires at 14:32": the host of the validated URL, never the URL (R2). */
function readyNote(a: AttemptView): string {
  const host = hostOf(a.url);
  const opens = host ? `Opens ${host} in a new tab` : "Opens in a new tab";
  const at = a.codeDeadline ? Date.parse(a.codeDeadline) : Number.NaN;
  return Number.isNaN(at) ? opens : `${opens} · Expires at ${TIME.format(at)}`;
}

function PanelLine({ line }: { line: Line }) {
  const error = line.tone === "error";
  // The unavailable reason reads like a note with its icon, muted (spec §8.2); an error is crimson.
  const icon = error || line.text === MSG.signInUnavailable;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem]",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {icon ? <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : null}
      <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
    </p>
  );
}

/**
 * The sign-in panel (spec §8.2), shared by Add credential and Sign in again. It reserves no space for a later state;
 * states swap instantly, with no fade and no height transition (R1, R7). The footer primary belongs to the host.
 */
export function SignInPanel({
  s,
  frame,
  codeRef,
}: {
  s: SignIn;
  frame: "inline" | "sheet";
  codeRef: RefObject<HTMLInputElement | null>;
}) {
  const copy = useCopy();
  const noteId = useId();
  const busy = s.phase === "exchanging" || s.phase === "verifying";
  const a = s.attempt;
  const ready = a !== null && (s.phase === "ready" || busy);
  return (
    <div ref={s.panelRef} data-sign-in-panel="" className="field-stack min-w-0">
      <div aria-live="polite">{!ready && s.line ? <PanelLine line={s.line} /> : null}</div>
      {ready ? (
        <>
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <a
                data-sign-in-link=""
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-describedby={noteId}
                className={cn(buttonVariants({ variant: "outline" }), IN_FORM)}
                // The paste lands in Code on return (spec §8.2).
                onClick={() => codeRef.current?.focus()}
              >
                <ExternalLink aria-hidden="true" />
                Open sign-in page
              </a>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                inForm
                aria-label="Copy link"
                data-skip-validate
                onClick={(e) => {
                  if (!a.url) return;
                  // A failed copy keeps focus here, beside its "Couldn't copy".
                  void copy.copy(a.url, e.detail === 0).then((ok) => {
                    if (ok) codeRef.current?.focus();
                  });
                }}
              >
                <CopyIcon
                  state={copy.state}
                  instant={copy.instant}
                  idle={<Copy aria-hidden="true" className="size-3.5" />}
                />
              </Button>
              {copy.state === "failed" ? <CopyFailed /> : null}
            </div>
            <p
              id={noteId}
              className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground [overflow-wrap:anywhere]"
            >
              {readyNote(a)}
            </p>
          </div>
          <FieldShell
            name="sign-in-code"
            label="Code"
            help="Shown after you sign in."
            error={s.codeError}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                ref={codeRef}
                id={id}
                name="sign-in-code"
                type="text"
                value={s.code}
                onChange={(e) => s.setCode(e.target.value)}
                onBlur={s.blurCode}
                // readOnly, not a disabled fieldset, so focus stays (spec §8.2).
                readOnly={busy}
                aria-disabled={busy || undefined}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </FieldShell>
          {frame === "sheet" && !busy ? (
            <Button
              type="button"
              variant="ghost"
              inForm
              data-skip-validate
              className="justify-self-start"
              onClick={() => void s.cancel()}
            >
              Cancel sign-in
            </Button>
          ) : null}
        </>
      ) : null}
      <span role="status" className="sr-only">
        {s.phase === "ready" ? "Sign-in page ready." : ""}
      </span>
    </div>
  );
}
