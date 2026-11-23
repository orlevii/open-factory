import type { BodyProps } from "./sheet-bodies";
import type { SheetSpec } from "./sheet-store";

/** Placeholder until Task 17 fills the Sign in again body. */
export default function SignInAgainSheetPlaceholder(
  _: BodyProps<Extract<SheetSpec, { kind: "sign-in-again" }>>,
) {
  return null;
}
