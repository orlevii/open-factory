/** Muted strip under the header; later specs add "waiting on", crons, usage and tasks here. */
export function AgentStrip({ slug }: { slug: string }) {
  return (
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 border-b border-border px-4 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6">
      <span className="font-mono">{slug}</span>
      <span aria-hidden="true">·</span>
      <span>Unsandboxed: runs directly on this machine</span>
    </div>
  );
}
