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

- Implement, test, commit and push autonomously on THIS repo (this overrides
  the global "never commit without order" rule, for this repo only).
- Every feature must be **verified before pushing**: run the geometry headless
  in node (see *Testing recipes*) and/or drive the dev server in the browser
  pane. Never push something only believed to work.
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
- Cuts happen in the plane's local frame (plane -> z=0), results transformed
  back. Pins: peg unioned on the bottom piece, socket (peg + tolerance)
  subtracted from the top piece, placed on the z=0 cross-section.
- Store `history` is a stack of previous `pieces` arrays; model transforms
  reset it (transformed pieces no longer match saved ones).

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

## Roadmap (owner-approved order)

1. ~~Plane cut + pins, exports, FR/EN~~ (v0.1)
2. ~~Model setup: dims display, m→mm, resize, rotation buttons + 3D gizmo~~
3. ~~Web Worker for cutting~~ (cut/simplify run in a module worker, transferables)
4. ~~Multiple pins per cut face~~ (grid candidates + ring-fit test + greedy spread, max 5/region)
5. ~~Mesh decimation~~ (weld via Manifold then MeshoptSimplifier, % in Model section)
6. ~~Volume cut~~ (oriented box + TransformControls translate/rotate/scale; cut in box-local frame vs unit cube; no pins yet)
6a. ~~Puzzle blocks~~ (grid slice at a chosen block size, e.g. printer-bed
    230³; sequential plane cuts skipping non-crossing pieces; blocks renamed
    bottom-layer-first; connector shapes: round/square/hex pegs or dowel
    holes — same holes both sides, bridged by a wooden/printed dowel)
6b. ~~Place-on-face~~ (OrcaSlicer-style: face tool -> click a face -> model
    rotated so that face lies on the grid; grid re-grounds under it)
7. Shape cut (click a protruding feature → connected-shell selection)
8. Color cut (vertex colors / texture zones) — needs color-preserving import
9. Tapered pins ~~done~~ (tip 80% of base, default ON); dovetail + manual pin placement remain
10. Mesh repair for non-manifold inputs
11. Perf: lazy transform bake (keep rotations on the group until a cut/export
    needs baked coordinates) — kills the end-of-drag hitch on multi-M-tri models
