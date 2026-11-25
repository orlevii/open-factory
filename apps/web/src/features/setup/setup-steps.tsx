import type { SetupStatus } from "@open-factory/shared";
import { Check, ChevronRight } from "lucide-react";
import { useId } from "react";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet, openSheetForResult } from "@/features/sheets/sheet-store";
import { useSetup } from "./api";

const noop = () => {};
// biome-ignore lint/suspicious/noThenProperty: SheetSpec's field, not a thenable
const NEW_TEMPLATE = { kind: "new-template", then: "open-editor" } as const;
const STEPS = [
  {
    title: "Sign in to Claude",
    desc: "Connect the Claude account your agents run on.",
    open: () => openSheetForResult({ kind: "add-credential" }, noop),
    intent: sheetIntent("add-credential", { kind: "add-credential" }),
    done: (s: SetupStatus) => s.hasCredential,
  },
  {
    title: "Create a template",
    desc: "A template is a role: persona, skills, tools and model.",
    open: () => openSheet(NEW_TEMPLATE),
    intent: sheetIntent("new-template", NEW_TEMPLATE),
    done: (s: SetupStatus) => s.hasTemplate,
  },
  {
    title: "Create an agent",
    desc: 'It runs a template in its own session. Give it "Can manage the org" to have it build the rest.',
    open: () => openSheet({ kind: "new-agent" }),
    intent: sheetIntent("new-agent", { kind: "new-agent" }),
    done: () => false,
  },
] as const;

/** The first-run steps (I8 §4.3): three rows that open the sheets that do each one. Order never changes and
 *  a done step stays clickable. */
export function SetupSteps({ status }: { status: SetupStatus }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-heading text-[1rem] leading-[1.25rem] font-semibold">
        Set up your factory
      </h2>
      <ol className="mt-2 border-y border-border">
        {STEPS.map((step, i) => {
          const done = step.done(status);
          return (
            <li key={step.title} className="border-b border-border last:border-b-0">
              <button
                type="button"
                {...step.intent}
                onClick={step.open}
                aria-label={`Step ${i + 1} of ${STEPS.length}, ${step.title}, ${done ? "done" : "not done"}`}
                aria-describedby={`${id}-step-${i}`}
                className="flex min-h-14 w-full items-start gap-3 px-2 py-3 text-left of-row"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[0.8125rem] text-muted-foreground tabular-nums"
                >
                  {done ? <Check aria-hidden="true" className="size-3 text-success" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.875rem] font-medium">{step.title}</span>
                  <span
                    id={`${id}-step-${i}`}
                    className="block text-[0.8125rem] text-muted-foreground"
                  >
                    {step.desc}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 self-center text-muted-foreground"
                />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The block with the whole status, for the places that render it. Only this reads more than `hasAgent`. */
export function SetupBlock() {
  const status = useSetup().data;
  return status ? <SetupSteps status={status} /> : null;
}
