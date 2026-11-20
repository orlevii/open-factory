/** Says what "est." means wherever usage figures are shown (spec §6). */
export function EstimateLine() {
  return (
    <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      Estimated at API prices. A subscription is billed by plan, not per token.
    </p>
  );
}
