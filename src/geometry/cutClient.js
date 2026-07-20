import * as THREE from 'three'

// Main-thread facade over the geometry worker: heavy Manifold/meshopt work
// runs off the UI thread, geometries cross the boundary as transferables.
let worker = null
let seq = 0
const pending = new Map()

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./cut.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const { id, ok, results, error } = e.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (ok) p.resolve(results)
      else p.reject(new Error(error))
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'))
      pending.clear()
    }
  }
  return worker
}

async function runOp(op, geometry, extra) {
  const id = ++seq
  // Copies: the displayed geometry must keep its buffers.
  const positions = new Float32Array(geometry.attributes.position.array)
  const index = geometry.index ? new Uint32Array(geometry.index.array) : null
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  getWorker().postMessage(
    { id, op, positions, index, ...extra },
    index ? [positions.buffer, index.buffer] : [positions.buffer]
  )
  const results = await promise
  return results.map((r) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3))
    if (r.normals) g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3))
    if (r.index) g.setIndex(new THREE.BufferAttribute(r.index, 1))
    if (!r.normals) g.computeVertexNormals()
    return g
  })
}

export const planeCutAsync = (geometry, plane, params) =>
  runOp('planeCut', geometry, { plane, params })

export const simplifyAsync = (geometry, ratio) => runOp('simplify', geometry, { params: { ratio } })

export const volumeCutAsync = (geometry, matrix) => runOp('volumeCut', geometry, { params: { matrix } })
