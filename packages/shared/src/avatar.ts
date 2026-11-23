/**
 * Identity colours (spec §11). The order is stored in `agents.color`, so it is
 * fixed here and the CSS tokens `--avatar-1..12` are checked against it.
 */
export type AvatarTier = "deep" | "light";
export type AvatarTheme = "light" | "dark";

export const AVATAR_CHROMA = 0.07;

export const AVATAR_HUES: readonly {
  index: number;
  hue: number;
  tier: AvatarTier;
  name: string;
}[] = [
  { index: 1, hue: 115, tier: "deep", name: "Olive" },
  { index: 2, hue: 130, tier: "light", name: "Moss" },
  { index: 3, hue: 175, tier: "deep", name: "Jade" },
  { index: 4, hue: 190, tier: "light", name: "Teal" },
  { index: 5, hue: 205, tier: "deep", name: "Cyan" },
  { index: 6, hue: 220, tier: "light", name: "Sky" },
  { index: 7, hue: 270, tier: "deep", name: "Indigo" },
  { index: 8, hue: 285, tier: "light", name: "Violet" },
  { index: 9, hue: 300, tier: "deep", name: "Plum" },
  { index: 10, hue: 315, tier: "light", name: "Orchid" },
  { index: 11, hue: 330, tier: "deep", name: "Rose" },
  { index: 12, hue: 345, tier: "light", name: "Ruby" },
];

export const AVATAR_COUNT = AVATAR_HUES.length;

const L: Record<AvatarTheme, Record<AvatarTier, number>> = {
  light: { deep: 0.56, light: 0.68 },
  dark: { deep: 0.64, light: 0.76 },
};

export function avatarL(theme: AvatarTheme, tier: AvatarTier): number {
  return L[theme][tier];
}

export type Oklch = { l: number; c: number; h: number };

/** ΔE_ok: Euclidean distance in OKLab. */
export function oklchDistance(a: Oklch, b: Oklch): number {
  const ax = a.c * Math.cos((a.h * Math.PI) / 180);
  const ay = a.c * Math.sin((a.h * Math.PI) / 180);
  const bx = b.c * Math.cos((b.h * Math.PI) / 180);
  const by = b.c * Math.sin((b.h * Math.PI) / 180);
  return Math.hypot(a.l - b.l, ax - bx, ay - by);
}
