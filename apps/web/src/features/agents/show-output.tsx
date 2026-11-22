/** A failed command's output, collapsed by default (native details: keyboard and screen-reader
 *  support for free). Renders nothing when there is no output. */
export function ShowOutput({ output }: { output?: unknown }) {
  if (typeof output !== "string" || output.trim() === "") return null;
  return (
    <details className="w-full text-[0.8125rem]">
      <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground">
        Show output
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-code-border bg-code p-3 font-mono text-xs whitespace-pre-wrap">
        {output}
      </pre>
    </details>
  );
}
