import { UntrustedProse } from "@/components/untrusted-text";

/** `name@mkt`: the name (mono) and a muted `@mkt`, with a break point before the `@` (spec §10.2). */
export function PluginKey({ pluginKey }: { pluginKey: string }) {
  const at = pluginKey.lastIndexOf("@");
  const name = at < 0 ? pluginKey : pluginKey.slice(0, at);
  const mkt = at < 0 ? "" : pluginKey.slice(at);
  return (
    <span className="font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
      <UntrustedProse text={name} />
      {mkt && (
        <>
          <wbr />
          <span className="text-muted-foreground">
            <UntrustedProse text={mkt} />
          </span>
        </>
      )}
    </span>
  );
}
