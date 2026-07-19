import * as THREE from 'three'
import Module from 'manifold-3d'

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
 * Compute the world matrix that maps the cut plane onto z = 0.
 * plane: { axis: 'x'|'y'|'z', offset, tiltA, tiltB } — tilts in degrees.
 */
export function planeBasis(plane) {
  const base = { x: [0, 90, 0], y: [-90, 0, 0], z: [0, 0, 0] }[plane.axis]
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(base[0] + plane.tiltA),
    THREE.MathUtils.degToRad(base[1] + plane.tiltB),
    0
  )
  const normal = new THREE.Vector3(0, 0, 1).applyEuler(e).normalize()
  const origin = normal.clone().multiplyScalar(plane.offset)
  return { normal, origin }
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
      const polys = section.toPolygons()

      // One pin per cross-section region large enough to host it,
      // placed at the region's centroid when it lies inside the outline.
      const minArea = Math.PI * (r + tol + 1) ** 2 * 2
      const outers = polys.filter((p) => polygonArea(p) > minArea)
      const holes = polys.filter((p) => polygonArea(p) < 0)
      for (const poly of outers) {
        const c = polygonCentroid(poly)
        if (!c || !pointInPolygon(c, poly)) continue
        if (holes.some((hp) => pointInPolygon(c, hp))) continue
        const peg = Manifold.cylinder(h, r, r, 48, true).translate([c[0], c[1], 0])
        const socket = Manifold.cylinder(h + 2 * tol, r + tol, r + tol, 48, true).translate([
          c[0],
          c[1],
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
