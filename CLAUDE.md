# SliceForge — Claude working rules (self-maintained)

Claude maintains this file itself: update it whenever the architecture, the
workflow or the rules change. It is the first thing to read in a new session.

## What this project is

In-browser tool to cut 3D models into printable pieces joined by alignment
pins — a clean-room reimplementation of objslice.com's feature set (no code or
assets from them, features only). Owner: BenGlut. Live at
https://benglut.github.io/sliceforge/ (GitHub Pages, auto-deployed on every
push to main by `.github/workflows/deploy.yml`).

## Autonomy contract (granted by the owner 2026-07-19)

- **Self-audit reflex**: after each feature, walk the app as a first-time
  slicer user (empty state -> import -> orient -> cut -> export) and fix what
  reads wrong WITHOUT being asked — dead slider travel, misplaced buttons,
  silent failures (e.g. browsers blocking multi-downloads), missing
  affordances. The owner expects proactive UX judgement, not just execution.

- Implement, test, commit and push autonomously on THIS repo (this overrides
  the global "never commit without order" rule, for this repo only).
- Every feature must be **verified before pushing**: run the geometry headless
  in node (see *Testing recipes*) and/or drive the dev server in the browser
  pane. Never push something only believed to work.
- **Synthetic primitives are NOT sufficient.** Cubes and spheres pass while
  the real experience fails (learned the hard way: smeared cut shading,
  crease-only shape selection useless on sculpts). Every geometry/visual
  feature must ALSO be exercised on the organic reference (the default Ratome
  model) with screenshots reviewed before shipping.
- Conversation with the owner in French; everything in the repo in English.
- UI copy: plain and factual, FR + EN in `src/i18n.js` (both locales in the
  same edit, keys stay in sync).

## Stack & architecture

Vite + React 18 + zustand + Three.js + manifold-3d (WASM booleans) + jszip.
No backend, no accounts — files never leave the machine.

```
src/
  App.jsx                 UI shell: header, sidebar sections, canvas host
  store.js                zustand store (pieces, plane, params, transforms)
  i18n.js                 EN/FR dict + makeT()
  style.css               all styles (dark UI)
  three/viewer.js         scene, camera, orbit, pieces render, explode,
                          plane helper, rotation gizmo (TransformControls)
  geometry/manifoldOps.js geometry<->Manifold conversion, planeCut + pins
  io/importers.js         STL/OBJ/GLB/GLTF/3MF -> single BufferGeometry
  io/exporters.js         STL per piece, minimal 3MF writer, OBJ, GLB
```

Key invariants:
- **Plate invariant**: the grid IS the plate, fixed at y=0. `groundAndCenter`
  (store.js) re-seats the model (min.y=0, centred x/z) after import and every
  model-level transform — a model must never float or sit off-plate. Cuts
  don't move pieces. Right-click in the viewport = context menu (centre
  model / fit view); right-drag stays orbit-pan.
- **Up-axis convention**: printing formats (STL/OBJ/3MF) are Z-up, the
  viewer is Y-up. importers.js rotates -90° X on import; exporters rotate a
  COPY back (+90° X, `toZUpGeometry`) for STL/OBJ/3MF so slicers open parts
  upright. GLB/GLTF are natively Y-up — no conversion either way.
- **Perf discipline**: never call `computeBoundingBox()` unconditionally —
  check `geometry.boundingBox` first (three caches it; `applyMatrix4` refreshes
  it). `setPieces` is SURGICAL: meshes reused by piece id, geometry pointers
  swapped, camera refit ONLY on new-model import (refit flag from App). Pixel
  ratio capped at 1.5. Remaining known cost: transform bake on huge meshes
  (~0.5 s/160k tris in dev) — lazy bake is the next perf item.
- **Selection (CAD standard)**: clicking a piece in the viewport selects it
  (emissive highlight + list highlight) and summons the rotation gizmo;
  clicking away or Esc clears. Hit test = bounding-box raycast (O(pieces),
  instant on huge meshes, but generous around diagonal views) — upgrade to
  three-mesh-bvh if per-triangle precision is ever needed.
- **Design system (Apple/BambuLab-inspired)**: tokens in `:root` of
  `src/style.css` (surfaces, `--accent` #2f6bff, radii, shadows) — always use
  tokens, never raw colors. Floating glass panels (blur) over the viewport,
  pill toolbar, segmented controls (`.axis-row`), custom sliders. Piece colors
  come from `PIECE_COLORS` (viewer.js) and are echoed as dots in the list.
- **Icons**: inline SVG components in `src/icons.jsx` (stroke, currentColor).
  NO emoji anywhere in the UI.
- **Tool-based UI (CAD standard)**: plane helper, volume box and rotation
  rings are TOOLS in the viewport toolbar — exactly one active at a time,
  nothing shown by default, Esc leaves the tool, each tool brings its own
  sidebar sections. Never add an always-visible overlay to the scene.
- Geometry transforms (rotate/resize) are **baked into the BufferGeometry**;
  meshes/groups stay at identity except during gizmo preview and explode.
- All booleans go through Manifold; **weld with `mesh.merge()` in WASM**, never
  three's `mergeVertices` (JS hash map blows up ~1M verts — learned on a real
  189 MB STL).
- Display normals come from `niceNormals` (normals.js): toCreasedNormals at
  30° under 500k tris (flat cut faces stay flat next to smooth surfaces),
  smooth fallback above. NEVER plain computeVertexNormals on cut results.
- The cut plane is a POSED OBJECT { pos, quat } (local +Z = normal), shown
  as a draggable translucent quad with its own TransformControls (T/R modes);
  clicking the model in plane mode snaps the plane to the surface (onPlanePick).
  Axis presets set quat + recenter. Cuts happen in the plane's local frame
  (plane -> z=0), results transformed back. Pins: peg unioned on the bottom piece, socket (peg + tolerance)
  subtracted from the top piece, placed on the z=0 cross-section. Manual
  connectors: 'place by hand' mode ghosts the parts (setPiecesGhost), clicks
  on the plane quad give plane-local mm (u,v) stored in App state, markers
  are children of the plane object (follow drags); cutParams.manualPins
  overrides auto placement, off-material spots dropped by point-in-polygon.
  A future nicety: tint markers red when off-material instead of silent drop.
- Full undo/redo (⌘Z/⇧⌘Z/Ctrl+Y): `history`/`future` stacks of entries —
  {kind:'snapshot', pieces} for topology changes (cut/simplify/puzzle),
  {kind:'matrix', inverse} for in-place transforms (rotate/resize/scale/
  centre, exact & memory-free; groundAndCenter's delta is folded into the
  matrix). LIFO discipline keeps shared-geometry mutations consistent; any
  new action clears `future`; capped at 30 entries.

## Default model

`public/ratome.stl` — the owner's Ratome SuperHero mascot, decimated to 80 k
tris and scaled to 180 mm (3.8 MB), auto-loaded at startup (best-effort fetch
in App.jsx; never overrides a user import). Regenerate from the full-res
source in ~/Downloads with the simplifyGeometry pipeline if the mascot evolves.

## Testing recipes

> Packaged as personal skills: invoke `/sliceforge-verify` (test harness) and
> `/sliceforge-ship` (docs→build→commit→push→watch-deploy pipeline) instead of
> re-deriving the recipes below. Claude installs/updates these skills itself
> in `~/.claude/skills/`.

- **Headless geometry** (fast, decisive): node script importing
  `src/geometry/*` directly; build test shapes with three
  (`new THREE.BoxGeometry(...)`, `.toNonIndexed()` to simulate STL), assert on
  bounding boxes / triangle counts. Scratch files `verify-*.tmp.mjs`, delete
  after use. `node --max-old-space-size=8192` for big meshes.
- **Browser pane**: `preview_start {name:"sliceforge"}` (config lives in the
  TigerTag repo's `.claude/launch.json` — runs `npm --prefix .../SliceForge run
  dev` on port 5173). Inject a model by dispatching a `drop` DragEvent with a
  generated STL File; drive React inputs with the native value setter +
  `input`/`focusout` events (React listens to focusout, NOT blur). In dev the
  viewer is exposed as `window.__sfViewer` for gizmo/scene assertions.
  Synthetic left_click_drag does NOT reach the canvas in the browser pane —
  test drags in the owner's Chrome instead, or simulate via `__sfViewer`. The pane can also
  report canvas getBoundingClientRect() as 0x0 — click-coordinate features
  must be verified in the owner's Chrome with real clicks.
- **Owner's Chrome** (real-world check): serve a local file to the HTTPS page
  via a localhost CORS server (`python3` one-liner), fetch + DataTransfer +
  drop. Kill the server afterwards (it exposes the folder it serves).
- Real-world reference file: `~/Downloads/RATOME ASSIS (1).stl` — 189 MB,
  3.97 M triangles, exported in metres (1.2×0.9×1.3). Exercises the unit
  converter, big-mesh welding, and slow-path performance.

## Release flow

Commit message: imperative summary, mechanism included when non-obvious. Push
to main → Actions builds → Pages serves. Watch `gh run list` until
`completed/success` before claiming it's live. No Co-Authored-By lines, no AI
mentions anywhere in the repo.

## objslice parity gaps (from hands-on benchmark of app.objslice.com, 2026-07-20)

Still missing vs their app: bounded cut plane (rect/circle shape, size,
solid depth => partial cuts); per-piece Move/Scale tools; per-piece lock/duplicate + volume/faces stats; 4-step onboarding wizard; zone cut auto-place-on-click had a
flat-plane variant (partial 'crossed zones'). Their default naming:
interieur/exterieur.

## Roadmap (owner-approved order)

1. ~~Plane cut + pins, exports, FR/EN~~ (v0.1)
2. ~~Model setup: dims display, m→mm, resize, rotation buttons + 3D gizmo~~
3. ~~Web Worker for cutting~~ (cut/simplify run in a module worker, transferables)
4. ~~Multiple pins per cut face~~ (grid candidates + ring-fit test + greedy spread, max 5/region)
5. ~~Mesh decimation~~ (weld via Manifold then MeshoptSimplifier, % in Model section)
6. ~~Volume cut~~ (oriented box + TransformControls translate/rotate/scale; cut in box-local frame vs unit cube; no pins yet)
6a. ~~Puzzle blocks~~ (LIVE grid preview while the tool is open — translucent
    bounded quads from the same puzzlePlanes() helper the generation uses,
    updating as block sizes change; grid slice at a chosen block size, e.g. printer-bed
    230³; sequential plane cuts skipping non-crossing pieces; blocks renamed
    bottom-layer-first; connector shapes: round/square/hex pegs or dowel
    holes — same holes both sides, bridged by a wooden/printed dowel.
    Auto-placement count is driven by cutParams.spacing (min distance between
    connectors, floor 4x pin footprint, cap 12/face) — LuBan-style control.
    The exploded view is in REAL mm (uniform expansion scaled by the median
    nearest-neighbour centroid distance — approximate on irregular grids);
    after every cut revealCut() auto-sets ~8% of the model size (6-60 mm).
    Connector presets via setConnectorType/CONNECTOR_PRESETS (store.js):
    dowel = standard wood 8 x 35 mm + 0.2 mm hole clearance + 45 mm spacing; values stay
    editable, tolerance field exposed in both Tenons and Puzzle sections)
6b. ~~Place-on-face~~ (OrcaSlicer-style: face tool -> click a face -> model
    rotated so that face lies on the grid; grid re-grounds under it)
7. ~~Shape cut v2~~ (geodesic-radius grow from the clicked triangle — mm
    slider, predictable on organic sculpts — combined with crease stops;
    sliders re-run the selection live from the last seed; orange overlay;
    detach = boundary-plane-fitted oriented box via volumeCut)
8. Color cut — PHASE 1 DONE: color-preserving import (OBJ vertex colors,
    GLB/3MF/MTL material colors baked per vertex, all-white dropped), colored
    display (vertexColors material), colors ride through every boolean as
    Manifold properties (numProp 6), cut faces painted flat neutral grey
    (paintFaces on the non-indexed result, local-frame plane tests), tools
    upgraded via matchProps (setProperties counts EXTRA props). Simplify
    de-interleaves and keeps colors. REMAINING phase 2: click-a-color zone
    selection and per-zone cutting.
9. Tapered pins ~~done~~ (tip 80% of base, default ON); dovetail + manual pin placement remain
10. Mesh repair for non-manifold inputs
11. Perf: lazy transform bake (keep rotations on the group until a cut/export
    needs baked coordinates) — kills the end-of-drag hitch on multi-M-tri models
