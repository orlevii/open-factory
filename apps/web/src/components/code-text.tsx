/** Server copy marks commands with backticks ("`claude setup-token`"): render them as code. */
export function CodeText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i} className="font-mono text-[0.8125rem]">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}
