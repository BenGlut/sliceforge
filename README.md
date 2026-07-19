# SliceForge

Cut 3D models into printable pieces joined by alignment pins — fully in the browser.

Import a model, position a cutting plane, and SliceForge splits it into watertight solids
with matching peg/socket pairs across the seam, ready to drop into any slicer
(Cura, BambuStudio, PrusaSlicer, Lychee…).

## Features (v0.1)

- **Import** STL / OBJ / GLB / GLTF / 3MF (drag & drop or file picker)
- **Model setup** — per-axis rotation (±15° / ±90°), resize by target dimensions
  (proportions locked or per-axis), one-click m→mm fix for metre-unit exports
- **Plane cut** — axis + offset + two tilt angles, optional kerf (blade clearance)
- **Alignment pins** — cylindrical peg/socket pairs auto-placed on the cut
  cross-section, with printable tolerance; pin diameter/length configurable
- **Watertight output** — all booleans run through [Manifold](https://github.com/elalish/manifold)
  (WASM), which guarantees manifold, hole-free results
- **Pieces manager** — visibility toggles, exploded view, undo
- **Export** STL (one file per piece), 3MF (all pieces in one file), OBJ, GLB
- **FR / EN** interface
- 100 % client-side — no upload, no account, models never leave the machine

## Roadmap

- [ ] Volume cut — box/sphere brush to detach a region (add/subtract modes)
- [ ] Shape cut — click a protruding feature, auto-select the connected shell
- [ ] Color cut — split by vertex-color / texture zones (multi-material printing)
- [ ] Dovetail / tapered connectors, manual pin placement
- [ ] Mesh decimation (meshoptimizer) for heavy scans
- [ ] Mesh repair for non-manifold inputs
- [ ] Orthographic view, measurement tools

## Development

```bash
npm install
npm run dev     # local dev server
npm run build   # production build in dist/
```

Stack: Vite + React + zustand + Three.js + manifold-3d (WASM). No backend.

## License

MIT. This is an independent, from-scratch implementation; it contains no code or
assets from any other product.
