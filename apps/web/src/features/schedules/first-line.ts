/** The first line of a message as plain text: never rendered markdown, never HTML. */
export const firstLine = (body: string) => body.split("\n").find((l) => l.trim() !== "") ?? "";
