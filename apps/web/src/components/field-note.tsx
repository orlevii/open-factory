import { CircleAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CodeText } from "@/components/code-text";
import { cn } from "@/lib/utils";

type Note = { help?: string; error?: string; warning?: string };

/** The id a control's aria-describedby names: the visible note, or nothing for an empty line. */
export function noteDescribedBy(id: string, n: Note): string | undefined {
  if (n.error || n.warning) return `${id}-error`;
  return n.help ? `${id}-help` : undefined;
}

/** One reserved note line (spec §5.1): help and error stacked in one cell, swapped by opacity. */
export function FieldNote({ id, help, error, warning }: { id: string } & Note) {
  const message = error ?? warning;
  const tone = error ? "error" : "warning";
  // The hidden layer keeps the last message, so a fixed two-line error keeps the slot's height (D2).
  const [last, setLast] = useState({ text: message ?? "", tone });
  if (message && (message !== last.text || tone !== last.tone)) setLast({ text: message, tone });
  const Icon = last.tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div className="field-note -mt-0.5">
      <p
        id={`${id}-help`}
        data-shown={!message && help ? "" : undefined}
        className="text-muted-foreground"
      >
        {help ? <CodeText text={help} /> : null}
      </p>
      <p
        id={`${id}-error`}
        data-shown={message ? "" : undefined}
        data-tone={last.tone}
        className={cn(
          "flex items-start gap-1.5",
          last.tone === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {last.text ? (
          <Icon
            aria-hidden="true"
            className={cn("mt-0.5 size-3.5 shrink-0", last.tone === "warning" && "text-warning")}
          />
        ) : null}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <CodeText text={last.text} />
        </span>
      </p>
    </div>
  );
}
