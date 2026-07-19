import * as THREE from 'three'
import { planeCut, simplifyGeometry } from './manifoldOps.js'

function toGeometry({ positions, index }) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1))
  return g
}

function toPayload(geometry) {
  return {
    positions: geometry.attributes.position.array,
    normals: geometry.attributes.normal?.array ?? null,
    index: geometry.index.array
  }
}

self.onmessage = async (e) => {
  const { id, op, plane, params } = e.data
  try {
    const g = toGeometry(e.data)
    let results
    if (op === 'planeCut') results = await planeCut(g, plane, params)
    else if (op === 'simplify') results = [await simplifyGeometry(g, params.ratio)]
    else throw new Error(`unknown op ${op}`)
    const payload = results.map(toPayload)
    const transfer = payload.flatMap((p) =>
      [p.positions.buffer, p.normals?.buffer, p.index.buffer].filter(Boolean)
    )
    self.postMessage({ id, ok: true, results: payload }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) })
  }
}
