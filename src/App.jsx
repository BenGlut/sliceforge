import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore, newPieceId } from './store.js'
import { makeT } from './i18n.js'
import { Viewer, PIECE_COLORS } from './three/viewer.js'
import { importModelFile, ACCEPTED } from './io/importers.js'
import { exportSTL, exportOBJ, exportGLB, export3MF } from './io/exporters.js'
import { AXIS_QUATS } from './geometry/plane.js'
import { planeCutAsync, simplifyAsync, volumeCutAsync, pinPreviewAsync } from './geometry/cutClient.js'
import { IconCut, IconBox, IconMove, IconRotate, IconFaceDown, IconGrid, IconWand, IconLogo } from './icons.jsx'
import { growRegion, regionPositions, regionOrientedBox } from './geometry/shapeSelect.js'
import { reservationsCollide, pinFits2D } from './geometry/collide.js'

// One source of truth for the puzzle grid: the preview shows EXACTLY the
// planes the generation will cut.
function puzzlePlanes(box, blockSize) {
  const planes = []
  for (const [axis, size] of [
    ['x', blockSize.x],
    ['y', blockSize.y],
    ['z', blockSize.z]
  ]) {
    if (!(size > 1)) continue
    for (let off = box.min[axis] + size; off < box.max[axis] - 0.01; off += size) {
      planes.push({ axis, offset: off })
    }
  }
  return planes
}

// Print-convention axes everywhere the user reads dimensions: X = width,
// Y = depth, Z = HEIGHT (slicer convention). The viewer is Y-up internally,
// so print-Z maps to view-y and print-Y to view-z.
const PRINT_AXES = [
  { key: 'x', label: 'X', color: '#e5484d' },
  { key: 'z', label: 'Y', color: '#3fb950' },
  { key: 'y', label: 'Z', color: '#2f6bff' }
]

// Number field that applies stepper clicks (±1 step) IMMEDIATELY and typed
// values on Enter/blur — live resize without mid-typing surprises.
function DimField({ label, color, value, onCommit }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (v) => {
    if (v > 0 && Math.abs(v - value) > 1e-3) onCommit(v)
  }
  return (
    <div className="dim-field">
      <span style={{ color }}>{label}</span>
      <input
        type="number"
        min="0.1"
        step="1"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const v = +e.target.value
          if (Number.isFinite(v) && Math.abs(Math.abs(v - value) - 1) < 1e-6) commit(v)
        }}
        onBlur={(e) => commit(+e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
      />
    </div>
  )
}

// Two families of tools, visually separated in the toolbar: TRANSFORM the
// selected piece (move/rotate/place) vs CUT it into more pieces.
const TOOL_GROUPS = [
  [
    ['move', <IconMove key="i" />, 'modeMove'],
    ['rotate', <IconRotate key="i" />, 'modeRotate'],
    ['face', <IconFaceDown key="i" />, 'placeFace']
  ],
  [
    ['plane', <IconCut key="i" />, 'planeCut'],
    ['volume', <IconBox key="i" />, 'volumeCut'],
    ['shape', <IconWand key="i" />, 'shapeCut'],
    ['puzzle', <IconGrid key="i" />, 'puzzle']
  ]
]
const TOOLBAR = TOOL_GROUPS.flat()
const TRANSFORM_TOOLS = new Set(TOOL_GROUPS[0].map(([tool]) => tool))

export default function App() {
  const s = useStore()
  const t = makeT(s.lang)
  const canvasRef = useRef(null)
  const viewerRef = useRef(null)
  const fileRef = useRef(null)
  const [uniformScale, setUniformScale] = useState(true)
  const [modelOpen, setModelOpen] = useState(true)

  // CAD-style tooling: gizmos belong to an active tool, nothing is shown by
  // default. Esc leaves the tool.
  const [activeTool, setActiveTool] = useState(null) // null | 'plane' | 'rotate' | 'volume'
  const [volumeMode, setVolumeMode] = useState('translate')
  const [planeMode, setPlaneMode] = useState('translate')
  const [pinPlacing, setPinPlacing] = useState(false)
  const [manualPins, setManualPins] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const selectedIdRef = useRef(null)
  const [blockSize, setBlockSizeState] = useState({ x: 220, y: 220, z: 250 })
  const [busyMsg, setBusyMsg] = useState(null)
  const [pinPreviewOn, setPinPreviewOn] = useState(false)
  const [puzzlePins, setPuzzlePins] = useState(null) // [{planeIdx, u, v, off}]
  const puzzlePlanesRef = useRef([]) // posed planes matching planeIdx
  const puzzleSectionsRef = useRef([]) // per-plane cross-section polygons
  const puzzlePinsRef = useRef(null)
  const puzzleSourceRef = useRef(null) // { pieces, ids } — regenerate from the original

  function clearPinPreview() {
    setPinPreviewOn(false)
    setPuzzlePins(null)
    viewerRef.current?.setPinPreview(null)
    viewerRef.current?.setPiecesGhost(false)
    if (viewerRef.current) viewerRef.current.puzzleEditMode = false
  }

  // World-space reservation segment for collision checks between connectors.
  function pinReservation(planeIdx, u, v, off = 0) {
    const plane = puzzlePlanesRef.current[planeIdx]
    const p = useStore.getState().cutParams
    const halfH = (p.pinLength + 2 * p.tolerance) / 2
    const q = new THREE.Quaternion(...plane.quat)
    const base = new THREE.Vector3(...plane.pos)
    const toW = (z) => new THREE.Vector3(u, v, z).applyQuaternion(q).add(base).toArray()
    return { a: toW(off - halfH), b: toW(off + halfH), r: p.pinDiameter / 2 + p.tolerance }
  }

  function pinValid2D(planeIdx, u, v) {
    const polys = puzzleSectionsRef.current[planeIdx]
    if (!polys?.length) return false
    const p = useStore.getState().cutParams
    return pinFits2D(polys, u, v, p.pinDiameter / 2 + p.tolerance + 1.5)
  }

  function collidesWithOthers(pins, selfIdx, planeIdx, u, v, off) {
    const res = pinReservation(planeIdx, u, v, off)
    return pins.some((pin, i) => {
      if (i === selfIdx) return false
      return reservationsCollide(res, pinReservation(pin.planeIdx, pin.u, pin.v, pin.off))
    })
  }

  // Compute where the puzzle's connectors will land (same engine as the
  // cut) and show them as orange ghosts through transparent pieces.
  async function onPreviewPins() {
    const st = useStore.getState()
    s.setBusy(true)
    s.setError(null)
    try {
      const box = new THREE.Box3()
      st.pieces.forEach((p) => {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      })
      const planes = puzzlePlanes(box, blockSize).map(({ axis, offset }) => {
        const pos = [0, 0, 0]
        pos[{ x: 0, y: 1, z: 2 }[axis]] = offset
        return { pos, quat: AXIS_QUATS[axis] }
      })
      puzzlePlanesRef.current = planes
      const all = []
      const sections = []
      for (const piece of st.pieces.filter((p) => p.visible)) {
        const res = await pinPreviewAsync(piece.geometry, planes, st.cutParams)
        all.push(...res.pins)
        res.sections.forEach((polys, i) => {
          sections[i] = [...(sections[i] ?? []), ...(polys ?? [])]
        })
      }
      puzzleSectionsRef.current = sections
      setPuzzlePins(all.map(({ planeIdx, u, v, off }) => ({ planeIdx, u, v, off })))
      viewerRef.current.setPiecesGhost(true)
      viewerRef.current.puzzleEditMode = true
      setPinPreviewOn(true)
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }
  const [ctxMenu, setCtxMenu] = useState(null)
  const [shapeMeta, setShapeMeta] = useState(null) // { pieceId, count }
  const [shapeSens, setShapeSens] = useState(60)
  const [shapeRadius, setShapeRadius] = useState(null) // null -> default from model size
  const shapeSelRef = useRef(null) // { pieceId, faceIndex, sel }

  function clearShapeSel() {
    shapeSelRef.current = null
    setShapeMeta(null)
    viewerRef.current?.setShapeHighlight(null)
  }

  // (Re)run the shape selection from the stored seed with current params —
  // called on click AND live when a slider moves.
  function runShapeSelection(pieceId, faceIndex, sens, radius) {
    const piece = useStore.getState().pieces.find((p) => p.id === pieceId)
    if (!piece) return
    const res = growRegion(piece.geometry, faceIndex, sens, radius)
    if (res.count >= res.triCount * 0.95) {
      shapeSelRef.current = { pieceId, faceIndex, sel: null }
      setShapeMeta(null)
      viewerRef.current.setShapeHighlight(null)
      useStore.getState().setError(makeT(useStore.getState().lang)('shapeWhole'))
      return
    }
    useStore.getState().setError(null)
    shapeSelRef.current = { pieceId, faceIndex, sel: res.sel }
    setShapeMeta({ pieceId, count: res.count })
    viewerRef.current.setShapeHighlight(regionPositions(piece.geometry, res.sel, res.count))
  }

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [ctxMenu])

  useEffect(() => {
    // One Viewer per canvas, ever: StrictMode double-mounts effects in dev,
    // and a second WebGL context on the same canvas leaves the first one
    // half-alive (stale camera matrices -> NaN raycasts).
    const canvas = canvasRef.current
    const viewer = canvas.__viewer ?? new Viewer(canvas)
    canvas.__viewer = viewer
    viewer.onRotateEnd = (q) =>
      useStore.getState().rotateModelQuaternion(q, selectedIdRef.current)
    // Baked move: the drag delta from the plate-plane arrows.
    viewer.onMoveEnd = (pieceId, dx, dz) => useStore.getState().translatePiece(pieceId, dx, dz)
    // CAD selection: transforms only ever apply to the SELECTED piece (there
    // can be several on the plate). Clicking a piece selects it and summons
    // the move arrows; clicking empty space clears both.
    viewer.onPieceClick = (id) => {
      setSelectedId(id)
      if (id) setActiveTool((tool) => tool ?? 'move')
      else setActiveTool((tool) => (TRANSFORM_TOOLS.has(tool) ? null : tool))
    }
    // Place-on-face (OrcaSlicer-style): rotate the CLICKED piece so the
    // face lies flat on the grid, then re-ground it.
    viewer.onFacePick = (normal, pieceId) => {
      setSelectedId(pieceId)
      const q = new THREE.Quaternion().setFromUnitVectors(
        normal.normalize(),
        new THREE.Vector3(0, -1, 0)
      )
      useStore.getState().rotateModelQuaternion(q, pieceId)
    }
    viewer.onContextMenu = (x, y) => setCtxMenu({ x, y })
    // Draggable cut plane: gizmo drags write back to the store; clicking the
    // model in plane mode snaps the plane there, oriented to the surface.
    viewer.onPlaneChange = ({ pos, quat }) => useStore.getState().setPlane({ pos, quat })
    // Manual connectors: click the plane to drop one, click near one to
    // remove it (plane-local mm, so markers follow plane drags).
    viewer.onPinPick = (u, v) => {
      setManualPins((pins) => {
        const r = Math.max(3, useStore.getState().cutParams.pinDiameter)
        const idx = pins.findIndex(([pu, pv]) => Math.hypot(pu - u, pv - v) < r)
        if (idx >= 0) return pins.filter((_, i) => i !== idx)
        return [...pins, [u, v]]
      })
    }
    viewer.onPlanePick = (point, normal) => {
      const quat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        normal.normalize()
      )
      useStore.getState().setPlane({ pos: point.toArray(), quat: quat.toArray() })
    }
    // Editable puzzle connectors: add on plane click, remove on marker
    // click, move by dragging — all collision-guarded.
    viewer.onPuzzlePinAdd = (planeIdx, u, v) => {
      setPuzzlePins((pins) => {
        if (!pins) return pins
        if (!pinValid2D(planeIdx, u, v)) return pins
        if (collidesWithOthers(pins, -1, planeIdx, u, v, 0)) return pins
        return [...pins, { planeIdx, u, v, off: 0 }]
      })
    }
    // Live drag constraint: the marker only follows while inside the
    // material (2D section + wall margin) and away from other connectors.
    viewer.puzzlePinValidator = (pinIdx, planeIdx, u, v) => {
      if (!pinValid2D(planeIdx, u, v)) return false
      const pins = puzzlePinsRef.current
      if (!pins) return true
      const pin = pins[pinIdx]
      return !collidesWithOthers(pins, pinIdx, planeIdx, u, v, pin?.off ?? 0)
    }
    viewer.onPuzzlePinRemove = (idx) => {
      setPuzzlePins((pins) => (pins ? pins.filter((_, i) => i !== idx) : pins))
    }
    viewer.onPuzzlePinMove = (idx, u, v) => {
      setPuzzlePins((pins) => {
        if (!pins) return pins
        const pin = pins[idx]
        if (!pin) return pins
        if (collidesWithOthers(pins, idx, pin.planeIdx, u, v, pin.off ?? 0)) return [...pins]
        return pins.map((q, i) => (i === idx ? { ...q, u, v } : q))
      })
    }
    // Shape cut: grow a smooth region from the clicked triangle, bounded by
    // geodesic radius and creases, highlighted live (see runShapeSelection).
    viewer.onShapePick = (faceIndex, pieceId) => {
      shapePickRef.current?.(faceIndex, pieceId)
    }
    if (import.meta.env.DEV) {
      window.__sfViewer = viewer
      window.__sfDebug = { planes: puzzlePlanesRef, sections: puzzleSectionsRef, pins: puzzlePinsRef }
    }
    viewerRef.current = viewer
  }, [])

  // Default model on startup (best-effort): the Ratome mascot, 180 mm demo
  // asset. Never overrides a file the user imported first.
  useEffect(() => {
    ;(async () => {
      try {
        const r = await fetch(import.meta.env.BASE_URL + 'ratome.stl')
        if (!r.ok) return
        const blob = await r.blob()
        if (useStore.getState().pieces.length) return
        const geometry = await importModelFile(
          new File([blob], 'Ratome Mascotte.stl', { type: 'model/stl' })
        )
        if (useStore.getState().pieces.length) {
          geometry.dispose()
          return
        }
        useStore.getState().setModel('Ratome Mascotte.stl', geometry)
        geometry.computeBoundingBox()
        const c = geometry.boundingBox.getCenter(new THREE.Vector3())
        useStore.getState().setPlane({ pos: [c.x, c.y, c.z] })
      } catch {
        /* the app works fine without the default model */
      }
    })()
  }, [])


  const lastModelRef = useRef(null)
  useEffect(() => {
    const refit = s.modelName !== lastModelRef.current
    lastModelRef.current = s.modelName
    viewerRef.current?.setPieces(s.pieces, s.explode, refit)
  }, [s.pieces])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // A lone piece is always the implicit selection (no pointless extra click);
  // a selection whose piece vanished (cut, undo) is cleared.
  useEffect(() => {
    if (s.pieces.length === 1) setSelectedId(s.pieces[0].id)
    else if (selectedId != null && !s.pieces.some((p) => p.id === selectedId))
      setSelectedId(null)
  }, [s.pieces, selectedId])

  useEffect(() => {
    viewerRef.current?.setGizmo(activeTool === 'rotate' ? selectedId : null)
  }, [activeTool, selectedId, s.pieces])

  useEffect(() => {
    viewerRef.current?.setMoveGizmo(activeTool === 'move' ? selectedId : null)
  }, [activeTool, selectedId, s.pieces])

  useEffect(() => {
    viewerRef.current?.setVolumeBox(activeTool === 'volume' && s.pieces.length > 0)
  }, [activeTool, s.pieces.length > 0])

  useEffect(() => {
    viewerRef.current?.setSelected(selectedId)
  }, [selectedId, s.pieces])

  useEffect(() => {
    if (!viewerRef.current) return
    viewerRef.current.faceMode = activeTool === 'face'
    viewerRef.current.shapeMode = activeTool === 'shape'
    if (activeTool !== 'face') viewerRef.current.clearFaceHover?.()
    // Warm the face-hover caches right after the tool opens (off the click
    // paint) so the first hover never freezes.
    if (activeTool === 'face') setTimeout(() => viewerRef.current?.warmFaceCaches?.(), 30)
    if (activeTool !== 'shape') clearShapeSel()
  }, [activeTool])

  const shapePickRef = useRef(null)

  async function onDetachShape() {
    const sh = shapeSelRef.current
    if (!sh) return
    s.setBusy(true)
    s.setError(null)
    try {
      const piece = useStore.getState().pieces.find((p) => p.id === sh.pieceId)
      const matrix = regionOrientedBox(piece.geometry, sh.sel)
      if (!matrix) throw new Error('no boundary')
      const parts = await volumeCutAsync(piece.geometry, matrix)
      if (parts.length === 2) {
        useStore.getState().replacePiece(
          piece.id,
          parts.map((g, i) => ({
            id: newPieceId(),
            name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
            geometry: g,
            visible: true
          }))
        )
      }
      clearShapeSel()
      revealCut()
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useStore.getState().redo()
        else useStore.getState().undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        useStore.getState().redo()
        return
      }
      if (e.key === 'Escape') {
        setPinPlacing((placing) => {
          if (placing) return false
          setActiveTool(null)
          setSelectedId(null)
          setCtxMenu(null)
          return placing
        })
        return
      }
      const idx = Number(e.key) - 1
      if (idx >= 0 && idx < TOOLBAR.length && useStore.getState().pieces.length) {
        const tool = TOOLBAR[idx][0]
        setActiveTool((t) => (t === tool ? null : tool))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    viewerRef.current?.setVolumeMode(volumeMode)
  }, [volumeMode])

  useEffect(() => {
    viewerRef.current?.setPlaneGizmoMode(planeMode)
  }, [planeMode])

  // T/R toggle the active gizmo mode (plane or volume tool).
  useEffect(() => {
    if (activeTool !== 'plane' && activeTool !== 'volume') return
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const k = e.key.toLowerCase()
      if (k !== 't' && k !== 'r') return
      const mode = k === 't' ? 'translate' : 'rotate'
      if (activeTool === 'plane') setPlaneMode(mode)
      else setVolumeMode(mode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool])

  async function onVolumeCut() {
    s.setBusy(true)
    s.setError(null)
    try {
      const matrix = viewerRef.current.getVolumeMatrix()
      const targets = s.pieces.filter((p) => p.visible)
      for (const piece of targets) {
        const parts = await volumeCutAsync(piece.geometry, matrix)
        if (parts.length < 2) continue
        useStore.getState().replacePiece(
          piece.id,
          parts.map((g, i) => ({
            id: newPieceId(),
            name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
            geometry: g,
            visible: true
          }))
        )
      }
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  useEffect(() => {
    viewerRef.current?.setExplode(s.explode)
  }, [s.explode])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (activeTool !== 'plane' || !s.pieces.length) {
      viewer.hidePlane()
      return
    }
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const size = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length()
    viewer.showPlane(s.plane, size * 0.8)
  }, [s.plane, s.pieces, activeTool])

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.planeMode = activeTool === 'plane'
  }, [activeTool])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const active = pinPlacing && activeTool === 'plane'
    viewer.pinMode = active
    viewer.setPiecesGhost(active)
    return () => viewer.setPiecesGhost(false)
  }, [pinPlacing, activeTool, s.pieces])

  useEffect(() => {
    viewerRef.current?.setPinMarkers(manualPins, s.cutParams.pinDiameter, s.cutParams.pinLength)
  }, [manualPins, s.cutParams.pinDiameter, s.cutParams.pinLength, s.plane, activeTool])

  useEffect(() => {
    if (activeTool !== 'plane') {
      setPinPlacing(false)
      setManualPins([])
    }
    // The Modèle section IS the transform editor (dimensions + rotation):
    // it stays open alongside the transform tools and collapses only for the
    // cut tools, which bring their own sections.
    setModelOpen(!activeTool || TRANSFORM_TOOLS.has(activeTool))
    // Opening the puzzle on a model smaller than the default blocks would
    // yield "1 block" and feel broken — propose sizes that actually split.
    if (activeTool === 'puzzle' && dims) {
      const est =
        Math.ceil(dims.x / Math.max(1, blockSize.x)) *
        Math.ceil(dims.y / Math.max(1, blockSize.y)) *
        Math.ceil(dims.z / Math.max(1, blockSize.z))
      if (est <= 1) {
        setBlockSizeState({
          x: Math.max(10, Math.ceil(dims.x / 2 / 5) * 5),
          y: Math.max(10, Math.ceil(dims.y / 2 / 5) * 5),
          z: Math.max(10, Math.ceil(dims.z / 2 / 5) * 5)
        })
      }
    }
  }, [activeTool])

  // Live preview of the puzzle grid while the tool is open.
  useEffect(() => {
    clearPinPreview()
    const viewer = viewerRef.current
    if (!viewer) return
    if (activeTool !== 'puzzle' || !s.pieces.length) {
      viewer.setPuzzlePreview(null)
      return
    }
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    viewer.setPuzzlePreview(puzzlePlanes(box, blockSize), box)
    return () => viewer.setPuzzlePreview(null)
  }, [activeTool, blockSize, s.pieces])

  // Render the orange markers from the editable pin list.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (!puzzlePins) {
      viewer.setPinPreview(null)
      return
    }
    const p = s.cutParams
    const pins = puzzlePins.map(({ planeIdx, u, v, off }) => {
      const plane = puzzlePlanesRef.current[planeIdx]
      const q = new THREE.Quaternion(...plane.quat)
      const center = new THREE.Vector3(u, v, off ?? 0)
        .applyQuaternion(q)
        .add(new THREE.Vector3(...plane.pos))
      return { center: center.toArray(), quat: plane.quat, plane, planeIdx }
    })
    viewer.setPinPreview(pins, p.pinDiameter, p.pinLength)
  }, [puzzlePins, s.cutParams.pinDiameter, s.cutParams.pinLength])

  useEffect(() => {
    puzzlePinsRef.current = puzzlePins
  }, [puzzlePins])

  async function onFiles(files) {
    const file = files?.[0]
    if (!file) return
    s.setBusy(true)
    s.setError(null)
    try {
      const geometry = await importModelFile(file)
      s.setModel(file.name, geometry)
      geometry.computeBoundingBox()
      const c = geometry.boundingBox.getCenter(new THREE.Vector3())
      s.setPlane({ pos: [c.x, c.y, c.z] })
    } catch (e) {
      console.error(e)
      s.setError(t('loadError', { name: file.name }))
    } finally {
      s.setBusy(false)
    }
  }

  const isDowelPiece = (p) => p.name.startsWith('tourillon_')

  // Printable dowels: the HOLES carry the tolerance, the dowel itself is the
  // exact nominal diameter. One piece per size, count in its name.
  function addDowelPiece(count) {
    if (!count) return
    const st = useStore.getState()
    const cp = st.cutParams
    const base = `tourillon_${cp.pinDiameter}x${cp.pinLength}`
    const existing = st.pieces.find((x) => x.name.startsWith(base))
    const prev = existing ? parseInt(existing.name.match(/_x(\d+)$/)?.[1] ?? '0', 10) : 0
    const total = prev + count
    const box = new THREE.Box3()
    st.pieces.forEach((q) => {
      if (isDowelPiece(q)) return
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox()
      box.union(q.geometry.boundingBox)
    })
    const g = new THREE.CylinderGeometry(cp.pinDiameter / 2, cp.pinDiameter / 2, cp.pinLength, 48)
    g.translate((box.isEmpty() ? 0 : box.max.x) + 15 + cp.pinDiameter, cp.pinLength / 2, 0)
    const name = `${base}_x${total}`
    if (existing) {
      useStore.getState().setPiecesBulk(
        st.pieces.map((q) => (q === existing ? { ...q, name, geometry: g } : q))
      )
    } else {
      useStore.getState().setPiecesBulk([
        ...st.pieces,
        { id: newPieceId(), name, geometry: g, visible: true }
      ])
    }
  }

  // Make the cut visible: gently explode the pieces (real mm, scaled to the
  // model) so the user SEES the separation and discovers the slider.
  function revealCut() {
    const st = useStore.getState()
    if (st.explode !== 0) return
    const box = new THREE.Box3()
    st.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const d = box.isEmpty() ? 100 : Math.max(...box.getSize(new THREE.Vector3()).toArray())
    st.setExplode(Math.round(Math.min(60, Math.max(6, d * 0.08))))
  }

  async function onCut() {
    s.setBusy(true)
    s.setError(null)
    try {
      // Cut every visible piece the plane actually crosses.
      const targets = s.pieces.filter((p) => p.visible && !isDowelPiece(p))
      let dowels = 0
      for (const piece of targets) {
        const parts = await planeCutAsync(piece.geometry, s.plane, {
          ...s.cutParams,
          manualPins: manualPins.length ? manualPins : undefined
        })
        if (parts.length < 2) continue
        dowels += parts.dowelCount ?? 0
        useStore.getState().replacePiece(
          piece.id,
          parts.map((g, i) => ({
            id: newPieceId(),
            name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
            geometry: g,
            visible: true
          }))
        )
      }
      addDowelPiece(dowels)
      setManualPins([])
      setPinPlacing(false)
      revealCut()
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  const [simplifyPct, setSimplifyPct] = useState(25)
  const triCount = s.pieces.reduce(
    (n, p) => n + (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3,
    0
  )

  async function onSimplify() {
    s.setBusy(true)
    s.setError(null)
    try {
      const geoms = []
      for (const p of s.pieces) {
        geoms.push((await simplifyAsync(p.geometry, simplifyPct / 100))[0])
      }
      useStore.getState().replaceAllGeometries(geoms)
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  // Puzzle: slice the model into printable blocks along a regular grid,
  // connectors added on every interface by the plane-cut engine.
  async function onPuzzle() {
    s.setBusy(true)
    s.setError(null)
    try {
      const box = new THREE.Box3()
      s.pieces.forEach((p) => {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      })
      const planes = puzzlePlanes(box, blockSize).map(({ axis, offset }) => {
        const pos = [0, 0, 0]
        pos[{ x: 0, y: 1, z: 2 }[axis]] = offset
        return { axis, offset, pos, quat: AXIS_QUATS[axis] }
      })
      const edited = puzzlePins
      const targets = s.pieces.filter((p) => p.visible && !isDowelPiece(p))
      let kept = s.pieces.filter((p) => !p.visible || isDowelPiece(p))
      let current = targets
      // Re-clicking Générer must REGENERATE, never re-cut the previous blocks:
      // if the targets are exactly the last generation, restart from the
      // saved source and drop the previous dowel piece.
      const src = puzzleSourceRef.current
      if (src && targets.length && targets.every((p) => src.ids?.has(p.id))) {
        current = src.pieces
        kept = kept.filter((p) => !isDowelPiece(p))
      } else {
        puzzleSourceRef.current = { pieces: targets, ids: null }
      }
      let done = 0
      let dowels = 0
      for (let planeIdx = 0; planeIdx < planes.length; planeIdx++) {
        const plane = planes[planeIdx]
        const next = []
        for (const piece of current) {
          if (!piece.geometry.boundingBox) piece.geometry.computeBoundingBox()
          const bb = piece.geometry.boundingBox
          if (
            plane.offset <= bb.min[plane.axis] + 0.05 ||
            plane.offset >= bb.max[plane.axis] - 0.05
          ) {
            next.push(piece)
            continue
          }
          const parts = await planeCutAsync(piece.geometry, plane, {
            ...s.cutParams,
            manualPins: edited
              ? edited.filter((pin) => pin.planeIdx === planeIdx).map(({ u, v }) => [u, v])
              : undefined
          })
          dowels += parts.dowelCount ?? 0
          if (parts.length < 2) next.push(piece)
          else
            parts.forEach((g) =>
              next.push({ id: newPieceId(), name: piece.name, geometry: g, visible: true })
            )
        }
        current = next
        done++
        setBusyMsg(`${done} / ${planes.length}`)
      }
      // Name blocks bottom layer first, stable reading order for assembly.
      const base = (s.modelName || 'model').replace(/\.[^.]+$/, '')
      const c = new THREE.Vector3()
      current
        .map((p) => {
          p.geometry.computeBoundingBox()
          p.geometry.boundingBox.getCenter(c)
          return { p, y: c.y, z: c.z, x: c.x }
        })
        .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
        .forEach((e, i) => {
          e.p.name = `${base}_${String(i + 1).padStart(2, '0')}`
        })
      useStore.getState().setPiecesBulk([...kept, ...current])
      puzzleSourceRef.current.ids = new Set(current.map((p) => p.id))
      addDowelPiece(dowels)
      clearPinPreview()
      revealCut()
      viewerRef.current?.fitCamera?.()
      setActiveTool(null)
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
      setBusyMsg(null)
    }
  }

  const { modelBox, dims } = (() => {
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    if (box.isEmpty()) return { modelBox: null, dims: null }
    return { modelBox: box, dims: box.getSize(new THREE.Vector3()) }
  })()
  const selPiece = s.pieces.find((p) => p.id === selectedId) ?? null
  const selDims = (() => {
    if (!selPiece) return null
    if (!selPiece.geometry.boundingBox) selPiece.geometry.computeBoundingBox()
    return selPiece.geometry.boundingBox.getSize(new THREE.Vector3())
  })()
  const isTiny = dims && Math.max(dims.x, dims.y, dims.z) < 10
  const maxDim = dims ? Math.max(dims.x, dims.y, dims.z) : 100
  const effRadius = shapeRadius ?? Math.round(maxDim / 4)

  shapePickRef.current = (faceIndex, pieceId) =>
    runShapeSelection(pieceId, faceIndex, shapeSens, effRadius)

  // Sliders re-run the selection live from the last clicked seed.
  useEffect(() => {
    const seed = shapeSelRef.current
    if (activeTool === 'shape' && seed) {
      runShapeSelection(seed.pieceId, seed.faceIndex, shapeSens, effRadius)
    }
  }, [shapeSens, shapeRadius])

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onFiles(e.dataTransfer.files)
      }}
    >
      <header>
        <span className="logo">
          <IconLogo /> SliceForge
        </span>
        <button onClick={() => fileRef.current.click()}>{t('import')}</button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          hidden
          onChange={(e) => {
            onFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {s.pieces.length > 0 && (() => {
          const checked = s.pieces.filter((p) => p.visible)
          return (
            <div className="export-group">
              <span>{t('export')} · {checked.length} :</span>
              <button disabled={!checked.length} onClick={() => exportSTL(checked, s.modelName)}>STL</button>
              <button disabled={!checked.length} onClick={() => export3MF(checked, s.modelName)}>3MF</button>
              <button disabled={!checked.length} onClick={() => exportOBJ(checked, s.modelName)}>OBJ</button>
              <button disabled={!checked.length} onClick={() => exportGLB(checked, s.modelName)}>GLB</button>
            </div>
          )
        })()}
        <span className="spacer" />
        <button className="lang" onClick={() => s.setLang(s.lang === 'fr' ? 'en' : 'fr')}>
          {s.lang === 'fr' ? 'EN' : 'FR'}
        </button>
      </header>

      <div className="main">
        <div className={`canvas-wrap${activeTool === 'face' ? ' face-mode' : ''}`}>
          <canvas ref={canvasRef} />
          {s.pieces.length > 0 && (
            <div className="viewport-toolbar">
              {TOOL_GROUPS.map((group, gi) => (
                <div className="tool-group" key={gi}>
                  {group.map(([tool, icon, labelKey]) => (
                    <button
                      key={tool}
                      className={activeTool === tool ? 'active' : ''}
                      onClick={() => setActiveTool(activeTool === tool ? null : tool)}
                    >
                      {icon} <span className="tool-label">{t(labelKey)}</span>
                      <span className="kbd">{TOOLBAR.findIndex(([tl]) => tl === tool) + 1}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!s.pieces.length && (
            <div className="empty-state">
              <IconLogo />
              <p>{t('dropHint')}</p>
              <button className="primary" onClick={() => fileRef.current.click()}>
                {t('import')}
              </button>
              <span className="formats">STL · OBJ · GLB · GLTF · 3MF</span>
            </div>
          )}
          {s.busy && <div className="busy">{busyMsg || t('cutting')}</div>}
          {ctxMenu && (
            <div
              className="ctx-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  s.centerModel()
                  setCtxMenu(null)
                }}
              >
                {t('centerModel')}
              </button>
              <button
                onClick={() => {
                  viewerRef.current?.fitCamera()
                  setCtxMenu(null)
                }}
              >
                {t('fitView')}
              </button>
            </div>
          )}
          {s.error && (
            <div className="error" onClick={() => s.setError(null)}>
              {s.error}
            </div>
          )}
        </div>

        {s.pieces.length > 0 && (
          <aside>
            <section>
              <h3 className="collapsible" onClick={() => setModelOpen((v) => !v)}>
                {t('model')}
                <span className={`chevron${modelOpen ? '' : ' closed'}`}>▾</span>
              </h3>
              {dims && (
                <div className="dims">
                  {t('dims', {
                    x: dims.x.toFixed(1),
                    y: dims.z.toFixed(1),
                    z: dims.y.toFixed(1)
                  })}
                </div>
              )}
              {isTiny && (
                <div className="tiny-hint">
                  {t('tinyModel')}
                  <button onClick={() => s.scaleModel(1000)}>{t('scaleToMm')}</button>
                </div>
              )}
              {modelOpen && (<>
              {selPiece ? (
                <>
                  {s.pieces.length > 1 && (
                    <div className="dims">{t('selectedPiece', { name: selPiece.name })}</div>
                  )}
                  <label>
                    {t('dimensions')}
                    <div className="dim-row">
                      {PRINT_AXES.map(({ key, label, color }) => (
                        <DimField
                          key={key}
                          label={label}
                          color={color}
                          value={selDims ? +selDims[key].toFixed(1) : 0}
                          onCommit={(v) => {
                            if (!selDims) return
                            const f = v / selDims[key]
                            if (uniformScale) s.resizeModel(f, f, f, selectedId)
                            else
                              s.resizeModel(
                                key === 'x' ? f : 1,
                                key === 'y' ? f : 1,
                                key === 'z' ? f : 1,
                                selectedId
                              )
                          }}
                        />
                      ))}
                    </div>
                  </label>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={uniformScale}
                      onChange={(e) => setUniformScale(e.target.checked)}
                    />
                    {t('uniform')}
                  </label>
                  <label>
                    {t('rotation')}
                    {PRINT_AXES.map(({ key: axis, label, color }) => (
                      <div className="rot-row" key={axis}>
                        <span className="rot-axis" style={{ color }}>{label}</span>
                        {[-90, -15, 15, 90].map((deg) => (
                          <button key={deg} onClick={() => s.rotateModel(axis, deg, selectedId)}>
                            {deg > 0 ? `+${deg}°` : `${deg}°`}
                          </button>
                        ))}
                      </div>
                    ))}
                  </label>
                </>
              ) : (
                <div className="dims">{t('selectHint')}</div>
              )}
              <div className="dims">{t('triangles', { n: Math.round(triCount).toLocaleString() })}</div>
              <div className="simplify-row">
                <input
                  type="number"
                  min="1"
                  max="90"
                  value={simplifyPct}
                  onChange={(e) => setSimplifyPct(+e.target.value)}
                  aria-label="%"
                />
                <span>%</span>
                <button disabled={s.busy} onClick={onSimplify}>
                  {t('simplify')}
                </button>
              </div>
              </>)}
            </section>

            {activeTool === 'plane' && (
            <>
            <section>
              <h3>{t('planeCut')}</h3>
              <div className="dims">{t('planeHint')}</div>
              <div className="axis-row">
                {[
                  ['translate', `${t('modeMove')} (T)`],
                  ['rotate', `${t('modeRotate')} (R)`]
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    className={planeMode === mode ? 'active' : ''}
                    onClick={() => setPlaneMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label>
                {t('axis')}
                <div className="axis-row">
                  {['x', 'y', 'z'].map((a) => (
                    <button
                      key={a}
                      onClick={() => {
                        const c = modelBox
                          ? modelBox.getCenter(new THREE.Vector3()).toArray()
                          : [0, 0, 0]
                        s.setPlane({ quat: AXIS_QUATS[a], pos: c })
                      }}
                    >
                      {a.toUpperCase()}
                    </button>
                  ))}
                </div>
              </label>
              <label>
                {t('kerf')}
                <input
                  type="number"
                  min="0"
                  step="0.05"
                  value={s.cutParams.kerf}
                  onChange={(e) => s.setCutParams({ kerf: +e.target.value })}
                />
              </label>
              <button className="primary" disabled={s.busy} onClick={onCut}>
                {s.busy ? t('cutting') : t('cut')}
              </button>
            </section>

            <section>
              <h3>
                {t('connectors')}
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={s.cutParams.pins}
                    onChange={(e) => s.setCutParams({ pins: e.target.checked })}
                  />
                </label>
              </h3>
              {s.cutParams.pins && (
                <>
                  <label>
                    {t(['square', 'hex'].includes(s.cutParams.connectorType) ? 'pinWidth' : 'pinDiameter')}
                    <input
                      type="number"
                      min="1"
                      step="0.5"
                      value={s.cutParams.pinDiameter}
                      onChange={(e) => s.setCutParams({ pinDiameter: +e.target.value })}
                    />
                  </label>
                  <label>
                    {t('pinLength')}
                    <input
                      type="number"
                      min="2"
                      step="0.5"
                      value={s.cutParams.pinLength}
                      onChange={(e) => s.setCutParams({ pinLength: +e.target.value })}
                    />
                  </label>
                  <label>
                    {t('tolerance')}
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={s.cutParams.tolerance}
                      onChange={(e) => s.setCutParams({ tolerance: +e.target.value })}
                    />
                  </label>
                  <div className="dims">{t('toleranceHint')}</div>
                  <label>
                    {t('spacing')}
                    <input
                      type="number"
                      min="5"
                      step="5"
                      value={s.cutParams.spacing}
                      onChange={(e) => s.setCutParams({ spacing: +e.target.value })}
                    />
                  </label>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={s.cutParams.taper}
                      onChange={(e) => s.setCutParams({ taper: e.target.checked })}
                    />
                    {t('taper')}
                  </label>
                  <button
                    className={pinPlacing ? 'active' : ''}
                    onClick={() => setPinPlacing((v) => !v)}
                  >
                    {t('placePins')}
                  </button>
                  {pinPlacing && <div className="dims">{t('pinsHint')}</div>}
                  {manualPins.length > 0 && (
                    <div className="simplify-row">
                      <span className="dims" style={{ flex: 1 }}>
                        {t('pinsPlaced', { n: manualPins.length })}
                      </span>
                      <button onClick={() => setManualPins([])}>{t('clearPins')}</button>
                    </div>
                  )}
                  <label>
                    {t('connector')}
                    <div className="axis-row">
                      {[
                        ['pin', t('connPin')],
                        ['square', t('connSquare')],
                        ['hex', t('connHex')],
                        ['dowel', t('connDowel')]
                      ].map(([type, label]) => (
                        <button
                          key={type}
                          className={s.cutParams.connectorType === type ? 'active' : ''}
                          onClick={() => s.setConnectorType(type)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </label>
                </>
              )}
            </section>
            </>
            )}

            {activeTool === 'move' && (
              <section>
                <h3>{t('modeMove')}</h3>
                <div className="dims">{selectedId ? t('moveHint') : t('selectHint')}</div>
              </section>
            )}

            {activeTool === 'volume' && (
              <section>
                <h3>{t('volumeCut')}</h3>
                <div className="dims">{t('volumeHint')}</div>
                <div className="axis-row">
                  {[
                    ['translate', t('modeMove')],
                    ['rotate', t('modeRotate')],
                    ['scale', t('modeScale')]
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      className={volumeMode === mode ? 'active' : ''}
                      onClick={() => setVolumeMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button className="primary" disabled={s.busy} onClick={onVolumeCut}>
                  {s.busy ? t('cutting') : t('detach')}
                </button>
              </section>
            )}

            {activeTool === 'face' && (
              <section>
                <h3>{t('placeFace')}</h3>
                <div className="dims">{t('faceHint')}</div>
              </section>
            )}

            {activeTool === 'rotate' && (
              <section>
                <h3>{t('modeRotate')}</h3>
                <div className="dims">{selectedId ? t('rotateHint') : t('selectHint')}</div>
              </section>
            )}

            {activeTool === 'shape' && (
              <section>
                <h3>{t('shapeCut')}</h3>
                <div className="dims">
                  {shapeMeta ? t('shapeSelected', { n: shapeMeta.count }) : t('shapeHint')}
                </div>
                <label>
                  {t('radius')} ({effRadius} mm)
                  <input
                    type="range"
                    min="1"
                    max={Math.ceil(maxDim)}
                    value={effRadius}
                    onChange={(e) => setShapeRadius(+e.target.value)}
                  />
                </label>
                <label>
                  {t('sensitivity')} ({shapeSens}°)
                  <input
                    type="range"
                    min="5"
                    max="85"
                    value={shapeSens}
                    onChange={(e) => setShapeSens(+e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={s.busy || !shapeMeta}
                  onClick={onDetachShape}
                >
                  {s.busy ? t('cutting') : t('detachShape')}
                </button>
              </section>
            )}

            {activeTool === 'puzzle' && (
              <section>
                <h3>{t('puzzle')}</h3>
                <label>
                  {t('blockSize')}
                  <div className="dim-row">
                    {PRINT_AXES.map(({ key: axis, label, color }) => (
                      <div className="dim-field" key={axis}>
                        <span style={{ color }}>{label}</span>
                        <input
                          type="number"
                          min="10"
                          step="10"
                          value={blockSize[axis]}
                          onChange={(e) =>
                            setBlockSizeState({ ...blockSize, [axis]: +e.target.value })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </label>
                <div className="dims">{t('blockSizeHint')}</div>
                {dims && (
                  <div className="dims">
                    {t('blocksEstimate', {
                      n:
                        Math.ceil(dims.x / Math.max(1, blockSize.x)) *
                        Math.ceil(dims.y / Math.max(1, blockSize.y)) *
                        Math.ceil(dims.z / Math.max(1, blockSize.z))
                    })}
                  </div>
                )}
                <label>
                  {t('connector')}
                  <div className="axis-row">
                    {[
                      ['pin', t('connPin')],
                      ['square', t('connSquare')],
                      ['hex', t('connHex')],
                      ['dowel', t('connDowel')]
                    ].map(([type, label]) => (
                      <button
                        key={type}
                        className={s.cutParams.connectorType === type ? 'active' : ''}
                        onClick={() => s.setConnectorType(type)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </label>
                <label>
                  {t(['square', 'hex'].includes(s.cutParams.connectorType) ? 'pinWidth' : 'pinDiameter')}
                  <input
                    type="number"
                    min="1"
                    step="0.5"
                    value={s.cutParams.pinDiameter}
                    onChange={(e) => s.setCutParams({ pinDiameter: +e.target.value })}
                  />
                </label>
                <label>
                  {t('pinLength')}
                  <input
                    type="number"
                    min="2"
                    step="0.5"
                    value={s.cutParams.pinLength}
                    onChange={(e) => s.setCutParams({ pinLength: +e.target.value })}
                  />
                </label>
                <label>
                  {t('tolerance')}
                  <input
                    type="number"
                    min="0"
                    step="0.05"
                    value={s.cutParams.tolerance}
                    onChange={(e) => s.setCutParams({ tolerance: +e.target.value })}
                  />
                </label>
                <label>
                  {t('spacing')}
                  <input
                  type="number"
                  min="5"
                  step="5"
                  value={s.cutParams.spacing}
                  onChange={(e) => s.setCutParams({ spacing: +e.target.value })}
                  />
                </label>
                <button
                  className={pinPreviewOn ? 'active' : ''}
                  disabled={s.busy}
                  onClick={() => (pinPreviewOn ? clearPinPreview() : onPreviewPins())}
                >
                  {pinPreviewOn ? t('hidePins') : t('previewPins')}
                </button>
                {pinPreviewOn && (
                  <>
                    <div className="dims">{t('pinsPlaced', { n: puzzlePins?.length ?? 0 })}</div>
                    <div className="dims">{t('hintMove')}</div>
                    <div className="dims">{t('hintRemove')}</div>
                    <div className="dims">{t('hintAdd')}</div>
                  </>
                )}
                <button className="primary" disabled={s.busy} onClick={onPuzzle}>
                  {s.busy ? busyMsg || t('cutting') : t('generate')}
                </button>
              </section>
            )}

            <section>
              <h3>
                {t('pieces')} ({s.pieces.length})
              </h3>
              {(s.history.length > 0 || s.future.length > 0) && (
                <div className="axis-row">
                  <button disabled={!s.history.length} onClick={s.undo}>
                    {t('undo')}
                  </button>
                  <button disabled={!s.future.length} onClick={s.redo}>
                    {t('redo')}
                  </button>
                </div>
              )}
              <ul className="pieces">
                {[...s.pieces]
                  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                  .map((p) => ({ p, i: s.pieces.indexOf(p) }))
                  .map(({ p, i }) => (
                  <li key={p.id} className={p.id === selectedId ? 'selected' : ''}>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={p.visible}
                        onChange={() => s.togglePiece(p.id)}
                      />
                    </label>
                    <span
                      className="piece-dot"
                      style={{
                        background:
                          '#' + PIECE_COLORS[i % PIECE_COLORS.length].toString(16).padStart(6, '0')
                      }}
                    />
                    <span
                      className="piece-name"
                      onClick={() => {
                        setSelectedId(p.id)
                        setActiveTool((tool) => tool ?? 'move')
                      }}
                    >
                      {p.name}
                    </span>
                  </li>
                ))}
              </ul>
              {s.pieces.length > 1 && (
                <label>
                  {t('explode')} ({Math.round(s.explode)} mm)
                  <input
                    type="range"
                    min="0"
                    max={Math.max(30, Math.round(maxDim / 2))}
                    step="1"
                    value={s.explode}
                    onChange={(e) => s.setExplode(+e.target.value)}
                  />
                </label>
              )}
            </section>
          </aside>
        )}
      </div>
    </div>
  )
}
