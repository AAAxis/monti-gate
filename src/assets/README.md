# Renderer assets

Everything Vite bundles. `brands/` has its own README — read that one before
touching a tag mark.

## The two copies of the Scout mark

| File | Route | Used by |
|---|---|---|
| `scout-mark.png` | URL, as a CSS `mask-image` | `--scout-mark` in `styles.css`, which `.brand-mark` (sidebar), `.extension-mark.is-scout` and `.start-brand-mark` all mask with |
| `scout-mark.svg` | `?raw`, inlined into a document | `lib/homePage.ts` only |

They are the same artwork and they exist twice on purpose.

The PNG is masked, so its colour never matters — the mask takes `--ink` and
inverts with the theme. That is the right route everywhere inside the app.

The SVG is the **embeddable** cut, and it is not the canonical file. It differs
from `../../assets/scout-mark.svg` (= `../../../brand/scout.svg`, md5
`ee8d6d10…`) in three ways, each of which matters only where it is used:

1. `fill="currentColor"` instead of `fill="black"`. The generated browser home
   page is a `file://` document with a light and a dark theme; shipped black,
   the mark is an invisible smudge on the dark one. It cannot be masked there —
   a mask needs a URL, and that document has no asset directory beside it.
2. The clipPath id is `scout-mark-clip`, not Figma's `clip0_4261_2`. It is the
   only `id` in the artwork, and this is the only place the artwork lands inside
   a document that has ids of its own (`#search`, `#suggest`).
3. No `width`/`height` attributes, so the embedding page sizes it — `.brand svg`
   sets a height and lets the width follow. The art is 874×1124; forcing it
   square letterboxes it.

### Swapping it

Take the new canonical mark, apply those three edits, and drop the result here.
Then open a generated `home.html` (`<user data dir>/ScoutHome/home.html`) in
both themes — an SVG that still says `fill="black"` looks correct on the light
theme and disappears on the dark one, which is exactly the failure this file
exists to prevent.
