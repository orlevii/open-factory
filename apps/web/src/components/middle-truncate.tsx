/** Long paths: the head shrinks with an ellipsis, the last segment always shows. */
export function MiddleTruncate({ text }: { text: string }) {
  const i = text.lastIndexOf("/");
  const head = i > 0 ? text.slice(0, i) : text;
  const tail = i > 0 ? text.slice(i) : "";
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="truncate">
        {head}
      </span>
      <span aria-hidden="true" className="shrink-0">
        {tail}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
