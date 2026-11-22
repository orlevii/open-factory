/** Long paths: the head shrinks with an ellipsis, then the last segment (only when it alone is too
 *  wide). Text with no inner "/" (a handle) splits at its middle, so "@marketing-team" reads
 *  "@ma…ng-team": its head and tail both stay. */
export function MiddleTruncate({
  text,
  keepEnd = false,
  headMin = false,
}: {
  text: string;
  /** A file name: once its last segment alone is too wide, it cuts from the start, so the
   *  extension stays. */
  keepEnd?: boolean;
  /** The head never collapses to nothing: about four characters of it stay, and the tail truncates
   *  first below that (a chip's file name, a `/` row's plugin prefix). */
  headMin?: boolean;
}) {
  const slash = text.lastIndexOf("/");
  const i = slash > 0 ? slash : Math.ceil(text.length / 2);
  const head = text.slice(0, i);
  const tail = text.slice(i);
  const tailCap = headMin ? "max-w-[calc(100%-4ch)]" : "max-w-full";
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className={headMin ? "min-w-[4ch] truncate" : "truncate"}>
        {head}
      </span>
      {/* The head goes first; the tail truncates only once the head is gone and it alone is too wide. */}
      {keepEnd ? (
        // A right-to-left box puts the ellipsis at the start; the text inside stays left-to-right.
        <span aria-hidden="true" dir="rtl" className={`${tailCap} shrink-0 truncate text-left`}>
          <span dir="ltr">{tail}</span>
        </span>
      ) : (
        <span aria-hidden="true" className={`${tailCap} shrink-0 truncate`}>
          {tail}
        </span>
      )}
      <span className="sr-only">{text}</span>
    </span>
  );
}
