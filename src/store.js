import { create } from 'zustand'

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

  plane: { axis: 'z', offset: 0, tiltA: 0, tiltB: 0 },
  setPlane: (patch) => set((s) => ({ plane: { ...s.plane, ...patch } })),

  cutParams: { kerf: 0.15, pins: true, pinDiameter: 6, pinLength: 8, tolerance: 0.15 },
  setCutParams: (patch) => set((s) => ({ cutParams: { ...s.cutParams, ...patch } })),

  setModel: (name, geometry) =>
    set({
      modelName: name,
      pieces: [{ id: 1, name, geometry, visible: true }],
      history: [],
      explode: 0,
      error: null
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

  scaleModel: (factor) =>
    set((s) => {
      for (const p of s.pieces) {
        p.geometry.scale(factor, factor, factor)
        p.geometry.computeBoundingBox()
      }
      return {
        pieces: [...s.pieces],
        history: [],
        plane: { ...s.plane, offset: s.plane.offset * factor }
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
