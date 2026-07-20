import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore, newPieceId } from './store.js'
import { makeT } from './i18n.js'
import { Viewer, PIECE_COLORS } from './three/viewer.js'
import { importModelFile, ACCEPTED } from './io/importers.js'
import { exportSTL, exportOBJ, exportGLB, export3MF } from './io/exporters.js'
import { AXIS_QUATS } from './geometry/plane.js'
import { planeCutAsync, simplifyAsync, volumeCutAsync } from './geometry/cutClient.js'
import { IconCut, IconBox, IconRotate, IconFaceDown, IconGrid, IconWand, IconLogo } from './icons.jsx'
import { growRegion, regionPositions, regionOrientedBox } from './geometry/shapeSelect.js'

const TOOLBAR = [
  ['plane', <IconCut key="i" />, 'planeCut'],
  ['volume', <IconBox key="i" />, 'volumeCut'],
  ['rotate', <IconRotate key="i" />, 'modeRotate'],
  ['face', <IconFaceDown key="i" />, 'placeFace'],
  ['shape', <IconWand key="i" />, 'shapeCut'],
  ['puzzle', <IconGrid key="i" />, 'puzzle']
]

export default function App() {
  const s = useStore()
  const t = makeT(s.lang)
  const canvasRef = useRef(null)
  const viewerRef = useRef(null)
  const fileRef = useRef(null)
  const [uniformScale, setUniformScale] = useState(true)

  // CAD-style tooling: gizmos belong to an active tool, nothing is shown by
  // default. Esc leaves the tool.
  const [activeTool, setActiveTool] = useState(null) // null | 'plane' | 'rotate' | 'volume'
  const [volumeMode, setVolumeMode] = useState('translate')
  const [planeMode, setPlaneMode] = useState('translate')
  const [pinPlacing, setPinPlacing] = useState(false)
  const [manualPins, setManualPins] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [blockSize, setBlockSizeState] = useState({ x: 220, y: 220, z: 250 })
  const [busyMsg, setBusyMsg] = useState(null)
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
    viewer.onRotateEnd = (q) => useStore.getState().rotateModelQuaternion(q)
    // CAD selection: clicking a piece selects it and summons the rotation
    // gizmo; clicking empty space clears both.
    viewer.onPieceClick = (id) => {
      setSelectedId(id)
      if (id) setActiveTool((tool) => tool ?? 'rotate')
      else setActiveTool((tool) => (tool === 'rotate' ? null : tool))
    }
    // Place-on-face (OrcaSlicer-style): rotate the model so the clicked
    // face lies flat on the grid, then re-ground the grid under it.
    viewer.onFacePick = (normal) => {
      const q = new THREE.Quaternion().setFromUnitVectors(
        normal.normalize(),
        new THREE.Vector3(0, -1, 0)
      )
      useStore.getState().rotateModelQuaternion(q)
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
    // Shape cut: grow a smooth region from the clicked triangle, bounded by
    // geodesic radius and creases, highlighted live (see runShapeSelection).
    viewer.onShapePick = (faceIndex, pieceId) => {
      shapePickRef.current?.(faceIndex, pieceId)
    }
    if (import.meta.env.DEV) window.__sfViewer = viewer
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
    viewerRef.current?.setGizmo(activeTool === 'rotate' && s.pieces.length > 0)
  }, [activeTool, s.pieces])

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
  }, [activeTool])

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

  async function onCut() {
    s.setBusy(true)
    s.setError(null)
    try {
      // Cut every visible piece the plane actually crosses.
      const targets = s.pieces.filter((p) => p.visible)
      for (const piece of targets) {
        const parts = await planeCutAsync(piece.geometry, s.plane, {
          ...s.cutParams,
          manualPins: manualPins.length ? manualPins : undefined
        })
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
      setManualPins([])
      setPinPlacing(false)
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
      const planes = []
      for (const [axis, size] of [
        ['x', blockSize.x],
        ['y', blockSize.y],
        ['z', blockSize.z]
      ]) {
        if (!(size > 1)) continue
        for (let off = box.min[axis] + size; off < box.max[axis] - 0.01; off += size) {
          const pos = [0, 0, 0]
          pos[{ x: 0, y: 1, z: 2 }[axis]] = off
          planes.push({ axis, offset: off, pos, quat: AXIS_QUATS[axis] })
        }
      }
      let current = s.pieces.filter((p) => p.visible)
      let done = 0
      for (const plane of planes) {
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
            manualPins: undefined
          })
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
      useStore.getState().setPiecesBulk([...current])
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
        {s.pieces.length > 0 && (
          <div className="export-group">
            <span>{t('export')}:</span>
            <button onClick={() => exportSTL(s.pieces, s.modelName)}>STL</button>
            <button onClick={() => export3MF(s.pieces, s.modelName)}>3MF</button>
            <button onClick={() => exportOBJ(s.pieces, s.modelName)}>OBJ</button>
            <button onClick={() => exportGLB(s.pieces, s.modelName)}>GLB</button>
          </div>
        )}
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
              {TOOLBAR.map(([tool, icon, labelKey], i) => (
                <button
                  key={tool}
                  className={activeTool === tool ? 'active' : ''}
                  onClick={() => setActiveTool(activeTool === tool ? null : tool)}
                >
                  {icon} <span className="tool-label">{t(labelKey)}</span>
                  <span className="kbd">{i + 1}</span>
                </button>
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
              <h3>{t('model')}</h3>
              {dims && (
                <div className="dims">
                  {t('dims', {
                    x: dims.x.toFixed(1),
                    y: dims.y.toFixed(1),
                    z: dims.z.toFixed(1)
                  })}
                </div>
              )}
              {isTiny && (
                <div className="tiny-hint">
                  {t('tinyModel')}
                  <button onClick={() => s.scaleModel(1000)}>{t('scaleToMm')}</button>
                </div>
              )}
              <label>
                {t('dimensions')}
                <div className="dim-row">
                  {['x', 'y', 'z'].map((axis) => (
                    <input
                      key={axis + dims?.[axis]?.toFixed(2)}
                      type="number"
                      min="0.1"
                      step="1"
                      defaultValue={dims ? +dims[axis].toFixed(1) : 0}
                      aria-label={axis.toUpperCase()}
                      onBlur={(e) => {
                        const v = +e.target.value
                        if (!dims || !(v > 0) || Math.abs(v - dims[axis]) < 1e-3) return
                        const f = v / dims[axis]
                        if (uniformScale) s.resizeModel(f, f, f)
                        else
                          s.resizeModel(
                            axis === 'x' ? f : 1,
                            axis === 'y' ? f : 1,
                            axis === 'z' ? f : 1
                          )
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
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
              <label>
                {t('rotation')}
                {['x', 'y', 'z'].map((axis) => (
                  <div className="rot-row" key={axis}>
                    <span className="rot-axis">{axis.toUpperCase()}</span>
                    {[-90, -15, 15, 90].map((deg) => (
                      <button key={deg} onClick={() => s.rotateModel(axis, deg)}>
                        {deg > 0 ? `+${deg}°` : `${deg}°`}
                      </button>
                    ))}
                  </div>
                ))}
              </label>
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
              {s.history.length > 0 && <button onClick={s.undo}>{t('undo')}</button>}
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
                    {t('pinDiameter')}
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
                          onClick={() => s.setCutParams({ connectorType: type })}
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

            {activeTool === 'volume' && (
              <section>
                <h3>{t('volumeCut')}</h3>
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
                    {['x', 'y', 'z'].map((axis) => (
                      <input
                        key={axis}
                        type="number"
                        min="10"
                        step="10"
                        value={blockSize[axis]}
                        aria-label={axis.toUpperCase()}
                        onChange={(e) =>
                          setBlockSizeState({ ...blockSize, [axis]: +e.target.value })
                        }
                      />
                    ))}
                  </div>
                </label>
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
                        onClick={() => s.setCutParams({ connectorType: type })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </label>
                <label>
                  {t('pinDiameter')}
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
                <button className="primary" disabled={s.busy} onClick={onPuzzle}>
                  {s.busy ? busyMsg || t('cutting') : t('generate')}
                </button>
              </section>
            )}

            <section>
              <h3>
                {t('pieces')} ({s.pieces.length})
              </h3>
              <ul className="pieces">
                {s.pieces.map((p, i) => (
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
                        setActiveTool((tool) => tool ?? 'rotate')
                      }}
                    >
                      {p.name}
                    </span>
                  </li>
                ))}
              </ul>
              {s.pieces.length > 1 && (
                <label>
                  {t('explode')}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
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
