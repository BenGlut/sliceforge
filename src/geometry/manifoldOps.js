import * as THREE from 'three'
import Module from 'manifold-3d'
import { MeshoptSimplifier } from 'meshoptimizer'
import { planeBasis } from './plane.js'

let wasmPromise = null
async function getWasm() {
  if (!wasmPromise) {
    wasmPromise = Module().then((w) => {
      w.setup()
      return w
    })
  }
  return wasmPromise
}

function geometryToManifold(wasm, geometry) {
  const { Manifold, Mesh } = wasm
  const pos = geometry.attributes.position
  let triVerts
  if (geometry.index) {
    triVerts = new Uint32Array(geometry.index.array)
  } else {
    // Non-indexed (typical STL): sequential indices — Manifold's merge() welds
    // the duplicates in WASM, which scales to millions of vertices where a
    // JS hash-map weld would blow up.
    triVerts = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) triVerts[i] = i
  }
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(pos.array),
    triVerts
  })
  mesh.merge()
  return new Manifold(mesh)
}

function manifoldToGeometry(manifold) {
  const mesh = manifold.getMesh()
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3))
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1))
  g.computeVertexNormals()
  return g
}

function polygonArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

function polygonCentroid(poly) {
  let cx = 0
  let cy = 0
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    const cross = x1 * y2 - x2 * y1
    a += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  a /= 2
  if (Math.abs(a) < 1e-9) return null
  return [cx / (6 * a), cy / (6 * a)]
}

function pointInPolygon([px, py], poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Choose pin positions on the z=0 cross-section: a coarse grid per region,
 * candidates must fit the whole pin (ring test with margin), then a greedy
 * spread pick — several pins lock rotation, one central pin cannot.
 */
function pinSpots(polys, r, tol) {
  const margin = r + tol + 1.5
  const outers = polys.filter((p) => polygonArea(p) > 0)
  const holes = polys.filter((p) => polygonArea(p) < 0)
  const inside = (pt) =>
    outers.some((o) => pointInPolygon(pt, o)) && !holes.some((h) => pointInPolygon(pt, h))
  const fits = (pt) => {
    if (!inside(pt)) return false
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      if (!inside([pt[0] + margin * Math.cos(a), pt[1] + margin * Math.sin(a)])) return false
    }
    return true
  }

  const spots = []
  for (const poly of outers) {
    const area = polygonArea(poly)
    if (area < Math.PI * margin * margin * 2.5) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of poly) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const nx = Math.min(10, Math.max(2, Math.round((maxX - minX) / (4 * margin))))
    const ny = Math.min(10, Math.max(2, Math.round((maxY - minY) / (4 * margin))))
    const cand = []
    const c = polygonCentroid(poly)
    if (c && fits(c)) cand.push(c)
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const pt = [
          minX + ((i + 0.5) * (maxX - minX)) / nx,
          minY + ((j + 0.5) * (maxY - minY)) / ny
        ]
        if (fits(pt)) cand.push(pt)
      }
    }
    // Greedy farthest-point pick, min spacing scaled to the region size.
    const minDist = Math.max(6 * margin, Math.sqrt(area) / 3)
    const picked = []
    for (const pt of cand) {
      if (picked.length >= 5) break
      if (picked.every((q) => Math.hypot(pt[0] - q[0], pt[1] - q[1]) >= minDist)) picked.push(pt)
    }
    spots.push(...picked)
  }
  return spots
}

/**
 * Cut a geometry by a plane, optionally adding alignment pins across the seam.
 * Returns an array of 1..2 BufferGeometries (a plane fully outside the model
 * returns the untouched solid as a single piece).
 */
export async function planeCut(geometry, plane, params) {
  const wasm = await getWasm()
  const { Manifold } = wasm
  const { normal, origin } = planeBasis(plane)

  // Work in the plane's local frame: cut plane becomes z = 0.
  const q = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 0, 1))
  const toLocal = new THREE.Matrix4()
    .makeRotationFromQuaternion(q)
    .multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
  const toWorld = toLocal.clone().invert()

  const gLocal = geometry.clone().applyMatrix4(toLocal)
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()

  const kerf = Math.max(0, params.kerf || 0)
  const cleanup = []
  try {
    let top = solid.trimByPlane([0, 0, 1], kerf / 2)
    let bottom = solid.trimByPlane([0, 0, -1], kerf / 2)
    cleanup.push(top, bottom)

    if (top.isEmpty() || bottom.isEmpty()) {
      return [manifoldToGeometry(solid)]
    }

    if (params.pins) {
      const r = Math.max(0.2, params.pinDiameter / 2)
      const h = Math.max(1, params.pinLength)
      const tol = Math.max(0, params.tolerance)
      const section = solid.slice(0)
      cleanup.push(section)
      for (const [x, y] of pinSpots(section.toPolygons(), r, tol)) {
        const peg = Manifold.cylinder(h, r, r, 48, true).translate([x, y, 0])
        const socket = Manifold.cylinder(h + 2 * tol, r + tol, r + tol, 48, true).translate([
          x,
          y,
          0
        ])
        cleanup.push(peg, socket)
        const b2 = bottom.add(peg)
        const t2 = top.subtract(socket)
        cleanup.push(b2, t2)
        bottom = b2
        top = t2
      }
    }

    const gTop = manifoldToGeometry(top).applyMatrix4(toWorld)
    const gBottom = manifoldToGeometry(bottom).applyMatrix4(toWorld)
    gTop.computeVertexNormals()
    gBottom.computeVertexNormals()
    return [gTop, gBottom]
  } finally {
    solid.delete()
    for (const m of cleanup) {
      try {
        m.delete()
      } catch {
        /* already consumed */
      }
    }
  }
}

/**
 * Split a solid with an oriented box (unit cube transformed by matrixArray,
 * column-major Matrix4). Returns [outside, inside] — 1 piece if the box
 * misses (or swallows) the solid. Cut in the box's local frame so Manifold
 * only ever sees an axis-aligned unit cube.
 */
export async function volumeCut(geometry, matrixArray) {
  const wasm = await getWasm()
  const { Manifold } = wasm
  const m = new THREE.Matrix4().fromArray(matrixArray)
  const inv = m.clone().invert()
  const gLocal = geometry.clone().applyMatrix4(inv)
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()
  const cube = Manifold.cube([1, 1, 1], true)
  const out = []
  for (const part of [solid.subtract(cube), solid.intersect(cube)]) {
    if (!part.isEmpty()) {
      const g = manifoldToGeometry(part).applyMatrix4(m)
      g.computeVertexNormals()
      out.push(g)
    }
    part.delete()
  }
  cube.delete()
  solid.delete()
  return out
}

/**
 * Reduce the triangle count to ~ratio (0..1) of the current one.
 * The mesh is first welded through Manifold (clean shared index), then
 * decimated with meshoptimizer's edge-collapse simplifier, which preserves
 * topology — the result stays cuttable.
 */
export async function simplifyGeometry(geometry, ratio) {
  const wasm = await getWasm()
  const solid = geometryToManifold(wasm, geometry)
  const welded = manifoldToGeometry(solid)
  solid.delete()

  await MeshoptSimplifier.ready
  const index = new Uint32Array(welded.index.array)
  const positions = new Float32Array(welded.attributes.position.array)
  const target = Math.max(4, Math.floor((index.length * ratio) / 3)) * 3
  const [newIndex] = MeshoptSimplifier.simplify(index, positions, 3, target, 0.05, [])

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(newIndex, 1))
  g.computeVertexNormals()
  return g
}
