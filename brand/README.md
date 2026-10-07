# brand

Original artwork for Isotherm, made for this repo (MIT, like the rest of it). No third-party marks.

| File | What | Use |
|---|---|---|
| `isotherm-logo.svg` | Source of the mark, 1024 × 1024 viewBox | Edit this; re-render the PNGs from it |
| `isotherm-logo-1024.png` | 1024 × 1024 PNG, transparent rounded corners, 74 KB, not animated | Hackathon portal logo (needs PNG/JPG/WEBP, ≥ 500 px short edge, ≤ 2 MB) |
| `isotherm-logo-512.png` | 512 × 512 PNG, 32 KB | Smaller uploads, README |
| `isotherm-cover.svg` | Source of the 16:9 cover; text uses system fonts (Avenir Next, then Helvetica Neue / Arial) | Edit this |
| `isotherm-cover-1920x1080.png` | 1920 × 1080 PNG, 195 KB | Thumbnail / first frame for the demo and pitch videos |

**The mark.** A thermometer whose mercury stops exactly on an isotherm, a line of equal temperature: cool navy above the line, warm orange below it. The four rungs on the stem are the strike ladder ("Tmax ≥ k"). It was checked down to 16 px, where the two-tone tile and the thermometer still read.

**Colours.** Navy `#173B5C` → `#0C2034`; contour `#25547D`; warm `#FF9A3C` → `#F0502B`; mercury `#E23B28`; cream `#FFF6E8`.

**Rendering.** The PNGs were rendered from the SVGs with headless Google Chrome at device scale 1 (`--screenshot --window-size=W,H --default-background-color=00000000`), then checked with PIL (size, mode, single frame). To re-render, open the SVG in Chrome at the target size, or use any SVG renderer that has the system fonts for the cover.
