import { type AgentSummary, ApiError } from "@open-factory/shared";
import { CircleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { postMessage } from "./api";

const draftKey = (slug: string) => `of-draft:${slug}`;
const readDraft = (slug: string) => {
  try {
    return sessionStorage.getItem(draftKey(slug)) ?? "";
  } catch {
    return "";
  }
};
const writeDraft = (slug: string, v: string) => {
  try {
    sessionStorage.setItem(draftKey(slug), v);
  } catch {
    /* private mode */
  }
};
const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export const NETWORK_ERROR = "Can't reach the server. Check that it's running, then try again.";

export function Composer({ slug, agent }: { slug: string; agent: AgentSummary }) {
  const [text, setText] = useState(() => readDraft(slug));
  const [urgent, setUrgent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const hintId = `${id}-hint`;
  const boxId = `${id}-box`;
  const urgentId = `${id}-urgent`;
  useEffect(() => writeDraft(slug, text), [slug, text]);
  const empty = text.trim() === "";

  async function send() {
    if (empty || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await postMessage(slug, text.trim(), urgent);
      setText("");
      setUrgent(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_start_failed") {
        // Queued server-side; the queued row shows "Not delivered yet: <reason>".
        setText("");
        setUrgent(false);
      } else setError(e instanceof ApiError ? e.message : NETWORK_ERROR);
    } finally {
      setSending(false);
      boxRef.current?.focus(); // focus stays in the composer after sending (UI §7)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarse()) return;
    e.preventDefault();
    void send();
  };

  return (
    <form
      id="composer"
      className="shrink-0 border-t border-border px-4 py-3 md:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="max-w-[52rem]">
        <label htmlFor={boxId} className="sr-only">
          Message to {agent.displayName}
        </label>
        <Textarea
          ref={boxRef}
          id={boxId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${agent.displayName}`}
          rows={2}
          aria-describedby={urgent ? hintId : undefined}
          className="max-h-[9rem] min-h-[3.5rem] resize-none bg-card md:max-h-[18rem] dark:bg-card"
        />
        <div className="mt-2 flex items-center gap-3">
          {urgent && (
            <p id={hintId} className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              {agent.turnOpen
                ? "Interrupts the current turn, then runs next."
                : "No turn is running, so this sends normally."}
            </p>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Checkbox
              id={urgentId}
              checked={urgent}
              onCheckedChange={(v) => setUrgent(v === true)}
            />
            <label htmlFor={urgentId} className="text-[0.8125rem]">
              Urgent
            </label>
          </div>
          <Button type="submit" disabled={empty || sending}>
            {urgent ? "Send urgent" : "Send"}
          </Button>
        </div>
        {error && (
          <p
            role="alert"
            className="mt-2 flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
          >
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
