# Wayward Palms planner

A furniture planner for the main level of the house, with a 2D plan view and a 3D
walkthrough. Open `index.html` in a browser. Nothing needs building. The 3D view loads
three.js 0.149.0 from cdnjs.cloudflare.com.

| File | What it is |
| --- | --- |
| `index.html` | The app. The 2D planner (the Final PDF drawn at 1/8″ = 1′-0″, plus furniture), the 2D/3D switch, and the shared furniture state. |
| `plan-data.js` | **The plan model: the single source of truth for walls, openings, rooms and solids.** |
| `plan-core.js` | Units, validation, wall joins, and generation of meshes and colliders. Plain JS, no three.js, so it also runs in Node. |
| `planner-3d.js` | The three.js view: overhead orbit, first-person walk, furniture editing, "Edit dimensions". Holds no house dimensions of its own. |
| `tests/verify-3d.js` | Node check: builds the scene from the data and checks wall, opening and room-area counts, the effect of measurement changes, and validation. |
| `tests/e2e.js` | Browser check with Playwright: 2D↔3D furniture sync, walking through doors, stopping at walls, switching views, the edit panel, no console errors. |
| `tools/` | Extraction from the PDFs (`extract_plan.py`, `fit-openings.js`) and drawing regeneration (`build_drawing.py`). |

## Units and coordinates

Every length in `plan-data.js` and in the furniture state is **decimal feet**
(`"units": "ft"` in the schema). The origin is the exterior NW corner of the house. +x runs
east, +y runs south (plan view, north up), and heights are measured up from the floor. The
UI shows feet-inches to the nearest 1/16″ (`PlanCore.formatFtIn`). Inputs accept `5' 7 1/2"`,
`67"`, `67in` or `5.625` (`PlanCore.parseLength`). In 3D, X = east, Y = up, Z = south.

## The plan model (`plan-data.js`)

```
walls[]     { id, a:[x,y], b:[x,y], thickness, exterior, height? }   centre line, ft
openings[]  { id, wall, kind, offset, width, height, sill, style?, leaves?, hinge?, swing?, source }
rooms[]     { id, num, name, polygon:[[x,y]...], keyArea, ceiling }
solids[]    { id, polygon, height }     fireplace mass and a chase: full-height blocks
defaults    { wallHeight, eyeHeight, ... }
assumptions[]  every place the extractor had to guess
```

* An **opening** belongs to one wall. `offset` is the distance from the wall's start (`a`)
  to the opening's centre. Move or resize the wall and its openings move with it.
* `kind`: `door` (`style` swing / bifold / pocket), `window` (`style: "panel"` for full-height
  fixed glass), `open` (no door; `height: null` means no header), `garage`, `passthrough`.
* `hinge` is `start`, `end` or `both`. `swing` is `left` or `right`, seen walking from `a` to `b`.
* `height` and `sill` are in feet. A wall without `height` takes the tallest ceiling of the
  rooms beside it (10′ in most rooms, 13′ in the Office, 15′ in the Foyer).

## Changing a measurement

Pick whichever suits the change:

1. **In the app:** 3D walkthrough → **Edit dimensions**. Pick a wall from the list or click it
   in the view, type new values, then **Apply and rebuild**. Edits are validated first. A
   plan with errors is not applied, and the last good model stays on screen. Edits are kept
   in this browser and marked **Plan edited**. Use **Copy plan JSON** and paste it over the
   `PLAN` object in `plan-data.js` to make them permanent. **Revert** goes back to the file.
2. **In the file:** edit `plan-data.js`, then run `node tests/verify-3d.js`. The 3D view
   rebuilds from the file every time the page loads.

What validation catches: zero-length walls, bad thickness or height, openings that run past
their wall's clear length (for example after a wall is shortened), overlapping openings on
one wall, crossing walls, room polygons that are too small, and room areas far from the
measured key. For furniture it flags pieces outside the house footprint and pieces that
overlap a wall. Furniture that overlaps a wall is also tinted red in 3D.

The 2D drawing is the Final PDF itself, so it does not move when you edit the model. Turn
on **Wall model** in the 2D toolbar to outline the walls and openings the 3D view is built
from. It switches on automatically once the plan is edited.

## 3D controls

* **Overhead:** drag to orbit; right-drag or Shift-drag to pan; scroll or pinch to zoom;
  **Top-down** looks straight down with north up. **Ceiling** shows or hides the ceilings,
  and **Walls** chooses full height, faded, or cut away at 4′. Drag furniture to move it,
  **R** rotates it, Delete removes it. **Snap to walls** makes a dropped piece face the
  room, flush against the nearest wall. Double-click the floor to place the walker.
* **First person:** W A S D or the arrow keys to walk, Shift to run, mouse to look (click to
  capture the pointer, Esc to release). On touch screens, use the pad to move and drag to
  look. You can walk through door openings, but not through walls, glass or furniture
  (rugs excepted). The eye height defaults to 5′-7″ and can be changed in the toolbar.
* **V** (or the camera button) switches views. Overhead centres on the walker, and first
  person starts where the walker stands.

## Tests

```
node tests/verify-3d.js          # data → 3D checks (no browser needed)
node tests/e2e.js [shots-dir]    # browser checks; needs Playwright + Chromium and access to cdnjs
```

## Regenerating from the PDFs

Re-running the extractor overwrites hand edits to `plan-data.js`. Requires poppler
(`pdftocairo`), `pdfplumber` and `shapely`.

```
python3 tools/extract_plan.py FINAL.pdf MEASURED.pdf > plan-data.js
node tools/fit-openings.js plan-data.js
python3 tools/build_drawing.py FINAL.pdf index.html
node tests/verify-3d.js
```

`FINAL.pdf` is "Final Wayward Palms Layout – Stud to Stud Without Drywall (Clean)". It
supplies the walls, door swings, window symbols and room badges. `MEASURED.pdf` is the first
stud-to-stud layout with the blue field-measurement tags, which supply opening widths and
heights.
