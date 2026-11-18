# Open Factory — Logo usage (Sawtooth)

> Chosen direction (round 2: 30° pitch kept, centred lockup, cut *t*). One page, for anyone putting the logo somewhere.

## 1. The logo
- **Idea:** The factory roofline drawn as one continuous line with an open floor: an open factory. The teeth rise at an exact 30° pitch, left to right.
- **Versions:** horizontal (primary) · stacked · symbol only · wordmark only.
- **Wordmark:** "open factory", set in Archivo Bold (SIL OFL 1.1), tracking −1 %, converted to outlines. The top of the *t* is cut at the roof's 30° pitch: the one custom detail that ties the type to the symbol. Never retype it.
- **Files:** only what the product uses lives in this repo: `horizontal-color.svg` (light grounds), `horizontal-dark.svg` (dark grounds, reversed cut) and `symbol-small-color.svg` (the small cut). The favicon and web icon set ships from `apps/web/public/`. The full package (stacked lockup, symbol-only and wordmark-only masters, one-colour and tile versions, PNG exports) stays in the logo project, outside this repo.

## 2. Clear space
**S** = the stroke width of the roofline (28/256 of the symbol). Clear space = **2 S** on every side. The clear space scales with the logo.

## 3. Minimum size
| Version | Screen | Print |
|---|---|---|
| Horizontal | 96 px wide | 25 mm wide |
| Stacked | 64 px wide | 18 mm wide |
| Symbol | 16 px (use the small cut) | 6 mm |

Small cut: `symbol-small-color.svg` is drawn on the 16 px grid (2 px walls, 4 px bays, every vertical edge on a whole pixel) — use it below 32 px. `apps/web/public/favicon.ico` and `favicon.svg` are rendered straight from it.

## 4. Colour
| Name | HEX | RGB | CMYK (starting point) | Pantone |
|---|---|---|---|---|
| Signal Orange | `#FF5A1F` | 255, 90, 31 | 0 65 88 0 | 172 C (approx.) |
| Ink | `#16140F` | 22, 20, 15 | 0 9 32 91 | Black 6 C (approx.) |
| Paper | `#F4F1EA` | 244, 241, 234 | 0 1 4 4 | Warm Gray 1 C (approx.) |

CMYK and Pantone values are conversions — proof against a swatch book before printing.

**Approved pairs:** orange symbol + ink wordmark on white/paper · orange symbol + paper wordmark on ink · all-ink on orange · all-white or all-black one-colour. App icon: orange mark on an ink tile.

## 5. Typography
- Wordmark/headlines: Archivo Bold. Body: same family or the system UI stack.
- All three typefaces in this exploration are SIL Open Font License — free for logo use.

## 6. Don'ts
Don't stretch, squash or rotate · don't recolour outside the palette · no shadows, outlines, gradients or effects · don't rearrange or resize the parts of a lockup · don't place on busy backgrounds without a solid container. Don't add a floor line or close the shape — the open bottom is the idea. Don't flip it; the teeth always rise to the right.

## 7. Open items
- Trademark clearance not done — run a professional search before committing.
- Reversed: the `-dark` and `-white` files use a symbol ~2 % thinner (27.4 vs 28), because light shapes on dark look heavier. Use them for all light-on-dark work.
