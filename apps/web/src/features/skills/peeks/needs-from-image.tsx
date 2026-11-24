import { UntrustedProse } from "@/components/untrusted-text";
import { Section } from "./sections";

/** What the agent's image (or this machine) must provide for a plugin's hooks and servers to run (spec §7.8). */
export const NEEDS_NOTE =
  "The agent's image (or this machine, for a local agent) must provide these. Open Factory doesn't install or test them.";

/** "Needs from the image": the program names as a wrapping mono run, then the note. Empty renders nothing. */
export function NeedsFromImage({ needs }: { needs: string[] }) {
  if (needs.length === 0) return null;
  return (
    <Section title="Needs from the image">
      <p className="font-mono text-[0.8125rem]">
        {needs.map((n, i) => (
          <span key={n}>
            {i > 0 && ", "}
            <UntrustedProse text={n} />
          </span>
        ))}
      </p>
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">{NEEDS_NOTE}</p>
    </Section>
  );
}
