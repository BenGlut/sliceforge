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
// it, centred — never floating. Re-applied after anything that moves geometry.
function groundAndCenter(pieces) {
  if (!pieces.length) return
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox)
  }
  const c = box.getCenter(new THREE.Vector3())
  const dx = -c.x
  const dy = -box.min.y
  const dz = -c.z
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4 && Math.abs(dz) < 1e-4) return
  for (const p of pieces) p.geometry.translate(dx, dy, dz)
}

function transformPieces(pieces, makeM) {
  const c = modelCenter(pieces)
  const m = new THREE.Matrix4()
    .makeTranslation(c.x, c.y, c.z)
    .multiply(makeM())
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
  // applyMatrix4 refreshes an already-computed boundingBox itself.
  for (const p of pieces) p.geometry.applyMatrix4(m)
  groundAndCenter(pieces)
}

// pieces: [{ id, name, geometry, visible }] — geometry is a THREE.BufferGeometry
export const useStore = create((set) => ({
  lang: navigator.language.startsWith('fr') ? 'fr' : 'en',
  setLang: (lang) => set({ lang }),

  modelName: null,
  pieces: [],
  history: [],
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
      explode: 0,
      error: null
    })
  },

  centerModel: () =>
    set((s) => {
      groundAndCenter(s.pieces)
      return { pieces: [...s.pieces] }
    }),

  replacePiece: (id, newPieces) =>
    set((s) => {
      const idx = s.pieces.findIndex((p) => p.id === id)
      if (idx === -1) return {}
      const pieces = [...s.pieces]
      pieces.splice(idx, 1, ...newPieces)
      return { pieces, history: [...s.history, s.pieces] }
    }),

  undo: () =>
    set((s) => {
      if (!s.history.length) return {}
      const history = [...s.history]
      const pieces = history.pop()
      return { pieces, history }
    }),

  rotateModelQuaternion: (q) =>
    set((s) => {
      transformPieces(s.pieces, () => new THREE.Matrix4().makeRotationFromQuaternion(q))
      return { pieces: [...s.pieces], history: [] }
    }),

  rotateModel: (axis, deg) =>
    set((s) => {
      const rad = THREE.MathUtils.degToRad(deg)
      transformPieces(s.pieces, () =>
        new THREE.Matrix4()[`makeRotation${axis.toUpperCase()}`](rad)
      )
      return { pieces: [...s.pieces], history: [] }
    }),

  resizeModel: (fx, fy, fz) =>
    set((s) => {
      transformPieces(s.pieces, () => new THREE.Matrix4().makeScale(fx, fy, fz))
      return { pieces: [...s.pieces], history: [] }
    }),

  scaleModel: (factor) =>
    set((s) => {
      for (const p of s.pieces) {
        p.geometry.scale(factor, factor, factor)
      }
      groundAndCenter(s.pieces)
      return {
        pieces: [...s.pieces],
        history: [],
        plane: { ...s.plane, offset: s.plane.offset * factor }
      }
    }),

  setPiecesBulk: (pieces) =>
    set((s) => ({ pieces, history: [...s.history, s.pieces] })),

  replaceAllGeometries: (geoms) =>
    set((s) => {
      if (geoms.length !== s.pieces.length) return {}
      return {
        pieces: s.pieces.map((p, i) => ({ ...p, geometry: geoms[i] })),
        history: [...s.history, s.pieces]
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
