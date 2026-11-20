import { useEffect, useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { smallClass } from "@/features/settings/shared";

/**
 * A new invite link, shown once (S10 §12.4): a read-only mono field that takes focus with its text
 * selected, Copy, the shown-once line and Done. Key it by the link so a new invite replaces it whole.
 */
export function InviteReveal({ link, onDone }: { link: string; onDone(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"copied" | "failed">();

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const copyLink = () => {
    const write = navigator.clipboard?.writeText(link);
    if (!write) return setCopy("failed");
    write.then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };

  return (
    <div className="grid max-w-xl gap-2">
      <div className="flex items-center gap-2">
        <Input
          ref={ref}
          readOnly
          value={link}
          aria-label="Invite link"
          aria-describedby="invite-reveal-note"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-[0.8125rem] md:text-[0.8125rem]"
        />
        <Button type="button" variant="outline" size="sm" onClick={copyLink}>
          Copy
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
      <p id="invite-reveal-note" className={`${smallClass} text-muted-foreground`}>
        Copy this link now. It isn't shown again. It works for one sign-up within 7 days.
      </p>
      <InlineOutcome tone={copy === "copied" ? "success" : copy === "failed" ? "error" : undefined}>
        {copy === "copied" ? "Copied." : copy === "failed" ? "Couldn't copy" : undefined}
      </InlineOutcome>
    </div>
  );
}
