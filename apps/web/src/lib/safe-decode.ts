/** decodeURIComponent that returns the input unchanged when it is malformed (a path like `/agents/%zz/chat`). */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
