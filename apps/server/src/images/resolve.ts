import { isUserImageRef, userImageTag } from "@open-factory/shared";

export const USER_TAG_PREFIX = userImageTag("").slice(0, -":latest".length);
/** The name inside a user image tag made by `userImageTag`. */
export const userNameOfTag = (tag: string) => tag.slice(USER_TAG_PREFIX.length, -":latest".length);

export type ResolvedImage =
  | { kind: "user"; name: string; tag: string }
  | { kind: "registry"; ref: string; tag: string };

/** Spec §10.1: only a template's image: is resolved; the factory default never is. */
export function resolveImage(
  templateImage: string | undefined,
  defaultImage: string,
): ResolvedImage {
  if (templateImage !== undefined && isUserImageRef(templateImage))
    return { kind: "user", name: templateImage, tag: userImageTag(templateImage) };
  const ref = templateImage ?? defaultImage;
  return { kind: "registry", ref, tag: ref };
}
