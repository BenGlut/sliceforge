import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore, newPieceId } from './store.js'
import { makeT } from './i18n.js'
import { Viewer } from './three/viewer.js'
import { importModelFile, ACCEPTED } from './io/importers.js'
import { exportSTL, exportOBJ, exportGLB, export3MF } from './io/exporters.js'
import { planeCut, planeBasis } from './geometry/manifoldOps.js'

export default function App() {
  const s = useStore()
  const t = makeT(s.lang)
  const canvasRef = useRef(null)
  const viewerRef = useRef(null)
  const fileRef = useRef(null)
  const [showPlane, setShowPlane] = useState(true)
  const [uniformScale, setUniformScale] = useState(true)

  useEffect(() => {
    const viewer = new Viewer(canvasRef.current)
    viewerRef.current = viewer
    return () => viewer.dispose()
  }, [])

  useEffect(() => {
    viewerRef.current?.setPieces(s.pieces, s.explode)
  }, [s.pieces])

  useEffect(() => {
    viewerRef.current?.setExplode(s.explode)
  }, [s.explode])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (!showPlane || !s.pieces.length) {
      viewer.hidePlane()
      return
    }
    const { normal, origin } = planeBasis(s.plane)
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const size = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length()
    viewer.showPlane(normal, origin, size)
  }, [s.plane, s.pieces, showPlane])

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
      s.setPlane({ axis: 'z', offset: c.z, tiltA: 0, tiltB: 0 })
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
        const parts = await planeCut(piece.geometry, s.plane, s.cutParams)
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

  const { bboxRange, dims } = (() => {
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    if (box.isEmpty()) return { bboxRange: [-100, 100], dims: null }
    const size = box.getSize(new THREE.Vector3())
    const d = size.length()
    return { bboxRange: [-d, d], dims: size }
  })()
  const isTiny = dims && Math.max(dims.x, dims.y, dims.z) < 10

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
        <span className="logo">⚒ SliceForge</span>
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
        <div className="canvas-wrap">
          <canvas ref={canvasRef} />
          {!s.pieces.length && <div className="drop-hint">{t('dropHint')}</div>}
          {s.busy && <div className="busy">{t('cutting')}</div>}
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

            <section>
              <h3>
                {t('planeCut')}
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={showPlane}
                    onChange={(e) => setShowPlane(e.target.checked)}
                  />
                  👁
                </label>
              </h3>
              <label>
                {t('axis')}
                <div className="axis-row">
                  {['x', 'y', 'z'].map((a) => (
                    <button
                      key={a}
                      className={s.plane.axis === a ? 'active' : ''}
                      onClick={() => s.setPlane({ axis: a })}
                    >
                      {a.toUpperCase()}
                    </button>
                  ))}
                </div>
              </label>
              <label>
                {t('offset')} ({s.plane.offset.toFixed(1)})
                <input
                  type="range"
                  min={bboxRange[0]}
                  max={bboxRange[1]}
                  step="0.1"
                  value={s.plane.offset}
                  onChange={(e) => s.setPlane({ offset: +e.target.value })}
                />
              </label>
              <label>
                {t('tiltA')} ({s.plane.tiltA}°)
                <input
                  type="range"
                  min="-45"
                  max="45"
                  value={s.plane.tiltA}
                  onChange={(e) => s.setPlane({ tiltA: +e.target.value })}
                />
              </label>
              <label>
                {t('tiltB')} ({s.plane.tiltB}°)
                <input
                  type="range"
                  min="-45"
                  max="45"
                  value={s.plane.tiltB}
                  onChange={(e) => s.setPlane({ tiltB: +e.target.value })}
                />
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
                </>
              )}
              <button className="primary" disabled={s.busy} onClick={onCut}>
                {s.busy ? t('cutting') : t('cut')}
              </button>
              {s.history.length > 0 && <button onClick={s.undo}>{t('undo')}</button>}
            </section>

            <section>
              <h3>
                {t('pieces')} ({s.pieces.length})
              </h3>
              <ul className="pieces">
                {s.pieces.map((p) => (
                  <li key={p.id}>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={p.visible}
                        onChange={() => s.togglePiece(p.id)}
                      />
                      {p.name}
                    </label>
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
