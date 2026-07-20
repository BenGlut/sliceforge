import * as THREE from 'three'
import { create } from 'zustand'

function modelCenter(pieces) {
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox)
  }
  return box.getCenter(new THREE.Vector3())
}

// Slicer invariant: the plate is fixed at y=0 and the model always RESTS on
// it, centred — never floating. Returns the translation it applied so the
// caller can fold it into the undoable transform matrix.
function groundAndCenter(pieces) {
  if (!pieces.length) return [0, 0, 0]
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox)
  }
  const c = box.getCenter(new THREE.Vector3())
  const dx = -c.x
  const dy = -box.min.y
  const dz = -c.z
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4 && Math.abs(dz) < 1e-4) return [0, 0, 0]
  for (const p of pieces) p.geometry.translate(dx, dy, dz)
  return [dx, dy, dz]
}

// Apply a model-level transform (about the model centre, then re-grounded)
// and return the TOTAL affine matrix — undo is its exact inverse, no
// geometry snapshots needed.
function transformPieces(pieces, makeM) {
  const c = modelCenter(pieces)
  const m = new THREE.Matrix4()
    .makeTranslation(c.x, c.y, c.z)
    .multiply(makeM())
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
  // applyMatrix4 refreshes an already-computed boundingBox itself.
  for (const p of pieces) p.geometry.applyMatrix4(m)
  const d = groundAndCenter(pieces)
  return new THREE.Matrix4().makeTranslation(d[0], d[1], d[2]).multiply(m)
}

// History entries: { kind: 'snapshot', pieces } for topology changes,
// { kind: 'matrix', inverse } for in-place transforms. LIFO order keeps the
// shared-geometry mutations consistent. Any new action clears the redo stack.
const HISTORY_MAX = 30
function pushEntry(s, entry) {
  return { history: [...s.history, entry].slice(-HISTORY_MAX), future: [] }
}
function matrixEntry(total) {
  return { kind: 'matrix', inverse: total.clone().invert().toArray() }
}

// pieces: [{ id, name, geometry, visible }] — geometry is a THREE.BufferGeometry
export const useStore = create((set) => ({
  lang: navigator.language.startsWith('fr') ? 'fr' : 'en',
  setLang: (lang) => set({ lang }),

  modelName: null,
  pieces: [],
  history: [],
  future: [],
  busy: false,
  error: null,

  explode: 0,
  setExplode: (explode) => set({ explode }),

  // Cut plane as a posed object: pos + quat (local +Z = cut normal).
  plane: { pos: [0, 0, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
  setPlane: (patch) => set((s) => ({ plane: { ...s.plane, ...patch } })),

  cutParams: {
    kerf: 0.15,
    pins: true,
    pinDiameter: 6,
    pinLength: 8,
    tolerance: 0.15,
    taper: true,
    connectorType: 'pin'
  },
  setCutParams: (patch) => set((s) => ({ cutParams: { ...s.cutParams, ...patch } })),

  setModel: (name, geometry) => {
    const pieces = [{ id: 1, name, geometry, visible: true }]
    groundAndCenter(pieces)
    return set({
      modelName: name,
      pieces,
      history: [],
      future: [],
      explode: 0,
      error: null
    })
  },

  centerModel: () =>
    set((s) => {
      const d = groundAndCenter(s.pieces)
      if (!d[0] && !d[1] && !d[2]) return {}
      const m = new THREE.Matrix4().makeTranslation(d[0], d[1], d[2])
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m)) }
    }),

  replacePiece: (id, newPieces) =>
    set((s) => {
      const idx = s.pieces.findIndex((p) => p.id === id)
      if (idx === -1) return {}
      const pieces = [...s.pieces]
      pieces.splice(idx, 1, ...newPieces)
      return { pieces, ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces }) }
    }),

  undo: () =>
    set((s) => {
      if (!s.history.length) return {}
      const history = [...s.history]
      const entry = history.pop()
      if (entry.kind === 'matrix') {
        const inv = new THREE.Matrix4().fromArray(entry.inverse)
        for (const p of s.pieces) p.geometry.applyMatrix4(inv)
        return {
          pieces: [...s.pieces],
          history,
          future: [...s.future, matrixEntry(inv)]
        }
      }
      return {
        pieces: entry.pieces,
        history,
        future: [...s.future, { kind: 'snapshot', pieces: s.pieces }]
      }
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return {}
      const future = [...s.future]
      const entry = future.pop()
      if (entry.kind === 'matrix') {
        const inv = new THREE.Matrix4().fromArray(entry.inverse)
        for (const p of s.pieces) p.geometry.applyMatrix4(inv)
        return {
          pieces: [...s.pieces],
          future,
          history: [...s.history, matrixEntry(inv)].slice(-HISTORY_MAX)
        }
      }
      return {
        pieces: entry.pieces,
        future,
        history: [...s.history, { kind: 'snapshot', pieces: s.pieces }].slice(-HISTORY_MAX)
      }
    }),

  rotateModelQuaternion: (q) =>
    set((s) => {
      const m = transformPieces(s.pieces, () => new THREE.Matrix4().makeRotationFromQuaternion(q))
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m)) }
    }),

  rotateModel: (axis, deg) =>
    set((s) => {
      const rad = THREE.MathUtils.degToRad(deg)
      const m = transformPieces(s.pieces, () =>
        new THREE.Matrix4()[`makeRotation${axis.toUpperCase()}`](rad)
      )
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m)) }
    }),

  resizeModel: (fx, fy, fz) =>
    set((s) => {
      const m = transformPieces(s.pieces, () => new THREE.Matrix4().makeScale(fx, fy, fz))
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m)) }
    }),

  scaleModel: (factor) =>
    set((s) => {
      for (const p of s.pieces) {
        p.geometry.scale(factor, factor, factor)
      }
      const d = groundAndCenter(s.pieces)
      const m = new THREE.Matrix4()
        .makeTranslation(d[0], d[1], d[2])
        .multiply(new THREE.Matrix4().makeScale(factor, factor, factor))
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m)) }
    }),

  setPiecesBulk: (pieces) =>
    set((s) => ({ pieces, ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces }) })),

  replaceAllGeometries: (geoms) =>
    set((s) => {
      if (geoms.length !== s.pieces.length) return {}
      return {
        pieces: s.pieces.map((p, i) => ({ ...p, geometry: geoms[i] })),
        ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces })
      }
    }),

  togglePiece: (id) =>
    set((s) => ({
      pieces: s.pieces.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p))
    })),

  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error })
}))

let nextId = 2
export const newPieceId = () => nextId++
