import * as THREE from 'three'
import Module from 'manifold-3d'
import { MeshoptSimplifier } from 'meshoptimizer'
import { planeBasis } from './plane.js'
import { reservationsCollide } from './collide.js'
import { niceNormals } from './normals.js'

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
  const col = geometry.attributes.color
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
  // Vertex colors ride along as 3 extra properties — Manifold interpolates
  // them across every boolean, so colors survive cuts.
  let vertProperties
  let numProp = 3
  if (col) {
    numProp = 6
    vertProperties = new Float32Array(pos.count * 6)
    for (let i = 0; i < pos.count; i++) {
      vertProperties[i * 6] = pos.array[i * 3]
      vertProperties[i * 6 + 1] = pos.array[i * 3 + 1]
      vertProperties[i * 6 + 2] = pos.array[i * 3 + 2]
      vertProperties[i * 6 + 3] = col.array[i * 3]
      vertProperties[i * 6 + 4] = col.array[i * 3 + 1]
      vertProperties[i * 6 + 5] = col.array[i * 3 + 2]
    }
  } else {
    vertProperties = new Float32Array(pos.array)
  }
  const mesh = new Mesh({ numProp, vertProperties, triVerts })
  mesh.merge()
  return new Manifold(mesh)
}

function manifoldToGeometry(manifold) {
  const mesh = manifold.getMesh()
  const g = new THREE.BufferGeometry()
  if (mesh.numProp > 3) {
    const n = mesh.vertProperties.length / mesh.numProp
    const posArr = new Float32Array(n * 3)
    const colArr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      posArr[i * 3] = mesh.vertProperties[i * mesh.numProp]
      posArr[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1]
      posArr[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2]
      colArr[i * 3] = mesh.vertProperties[i * mesh.numProp + 3]
      colArr[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 4]
      colArr[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 5]
    }
    g.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colArr, 3))
  } else {
    g.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3))
  }
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1))
  return niceNormals(g)
}

// Paint cut-face triangles flat grey (non-indexed geometry only: each face
// owns its vertices, so walls keep their colour). planeTest receives the 3
// vertices of a triangle and says whether it lies on a cut plane.
const GREY = [0.62, 0.63, 0.66]
function paintFaces(g, planeTest) {
  const col = g.attributes.color
  if (!col || g.index) return
  const pos = g.attributes.position
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  for (let t = 0; t < pos.count; t += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, t + k)
    if (planeTest(v)) {
      for (let k = 0; k < 3; k++) col.setXYZ(t + k, GREY[0], GREY[1], GREY[2])
    }
  }
  col.needsUpdate = true
}

/**
 * Final connector placements on the z=0 cross-section of `solid` (local
 * frame): candidate spots (auto grid or manual clicks) are validated in 3D —
 * the reservation plus a 1.2 mm wall margin must sit fully INSIDE the solid,
 * so no connector ever pierces the outer shell. If the centred (50/50)
 * position leaks, the reservation is slid along the axis to 30/70 then 70/30;
 * if nothing fits, the spot is dropped. Returns [x, y, zOffset] triples.
 * Shared by the actual cut and the orange preview, so they always agree.
 */
const PIN_WALL = 1.2
function pinPlacements(wasm, solid, params) {
  const { Manifold } = wasm
  const r = Math.max(0.2, params.pinDiameter / 2)
  const h = Math.max(1, params.pinLength)
  const tol = Math.max(0, params.tolerance)
  const section = solid.slice(0)
  const polys = section.toPolygons()
  section.delete()
  let spots
  if (Array.isArray(params.manualPins)) {
    const outers = polys.filter((p) => polygonArea(p) > 0)
    const holes = polys.filter((p) => polygonArea(p) < 0)
    spots = params.manualPins.filter(
      (pt) => outers.some((o) => pointInPolygon(pt, o)) && !holes.some((hp) => pointInPolygon(pt, hp))
    )
  } else {
    spots = pinSpots(polys, r, tol, params.spacing)
  }
  const testR = r + tol + PIN_WALL
  const testH = h + 2 * tol + 2 * PIN_WALL
  const placements = []
  for (const [x, y] of spots) {
    for (const off of [0, 0.2 * h, -0.2 * h]) {
      const tester = Manifold.cylinder(testH, testR, testR, 16, true).translate([x, y, off])
      const leak = tester.subtract(solid)
      const fits = leak.isEmpty() || leak.volume() < 0.05
      tester.delete()
      leak.delete()
      if (fits) {
        placements.push([x, y, off])
        break
      }
    }
  }
  return placements
}

/**
 * Preview-only: where would the connectors land for these cut planes?
 * Runs the exact same placement logic as the cut, against the given
 * geometry, and returns world-space poses for the orange ghost markers.
 */
export async function previewPins(geometry, planes, params) {
  const wasm = await getWasm()
  const out = []
  const occupied = []
  const r = Math.max(0.2, params.pinDiameter / 2) + Math.max(0, params.tolerance)
  const halfH = (Math.max(1, params.pinLength) + 2 * Math.max(0, params.tolerance)) / 2
  for (let planeIdx = 0; planeIdx < planes.length; planeIdx++) {
    const plane = planes[planeIdx]
    const { origin } = planeBasis(plane)
    const q = new THREE.Quaternion(...plane.quat).invert()
    const toLocal = new THREE.Matrix4()
      .makeRotationFromQuaternion(q)
      .multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
    const toWorld = toLocal.clone().invert()
    const gLocal = geometry.clone().applyMatrix4(toLocal)
    const solid = geometryToManifold(wasm, gLocal)
    gLocal.dispose()
    for (const [u, v, off] of pinPlacements(wasm, solid, params)) {
      const a = new THREE.Vector3(u, v, off - halfH).applyMatrix4(toWorld)
      const b = new THREE.Vector3(u, v, off + halfH).applyMatrix4(toWorld)
      const res = { a: a.toArray(), b: b.toArray(), r }
      // Connectors must NEVER hit each other — reject any reservation that
      // would cross one already accepted on another plane.
      if (occupied.some((o) => reservationsCollide(o, res))) continue
      occupied.push(res)
      const center = new THREE.Vector3(u, v, off).applyMatrix4(toWorld)
      out.push({ center: center.toArray(), quat: plane.quat, u, v, off, planeIdx })
    }
    solid.delete()
  }
  return out
}

// Tool solids (pins, cutting boxes) meeting a colored model in a boolean:
// give them 3 colour properties (setProperties counts EXTRA props, position
// excluded) so the faces they create read as neutral grey, not black.
function matchProps(tool, hasColor) {
  if (!hasColor) return tool
  const upgraded = tool.setProperties(3, (newProp) => {
    newProp[0] = 0.62
    newProp[1] = 0.63
    newProp[2] = 0.66
  })
  tool.delete()
  return upgraded
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
function pinSpots(polys, r, tol, spacing) {
  const margin = r + tol + 1.5
  // The user-set minimum spacing drives HOW MANY connectors a face gets;
  // it can never go below twice the pin footprint (overlap guard).
  const minDist = Math.max(spacing || 0, 4 * margin)
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
    const nx = Math.min(14, Math.max(2, Math.round(((maxX - minX) / minDist) * 2)))
    const ny = Math.min(14, Math.max(2, Math.round(((maxY - minY) / minDist) * 2)))
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
    // Greedy pick honouring the user's minimum spacing.
    const picked = []
    for (const pt of cand) {
      if (picked.length >= 12) break
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
  const { origin } = planeBasis(plane)

  // Work in the plane's FULL local frame (its quaternion, not just the
  // normal): cut plane becomes z = 0 and the in-plane x/y axes match the
  // viewport plane object, so manual connector (u,v) coords line up exactly.
  const q = new THREE.Quaternion(...plane.quat).invert()
  const toLocal = new THREE.Matrix4()
    .makeRotationFromQuaternion(q)
    .multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
  const toWorld = toLocal.clone().invert()

  const gLocal = geometry.clone().applyMatrix4(toLocal)
  const hasColor = !!geometry.attributes.color
  gLocal.computeBoundingBox()
  const lb = gLocal.boundingBox.clone()
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()

  const kerf = Math.max(0, params.kerf || 0)
  const cleanup = []
  try {
    let top, bottom
    if (hasColor) {
      // trimByPlane zero-fills colour properties on the cap (black faces);
      // intersect with grey half-space boxes instead so cuts read neutral.
      const m = 1
      const sx = lb.max.x - lb.min.x + 2 * m
      const sy = lb.max.y - lb.min.y + 2 * m
      const boxTop = matchProps(
        Manifold.cube([sx, sy, lb.max.z + m - kerf / 2], false).translate([
          lb.min.x - m,
          lb.min.y - m,
          kerf / 2
        ]),
        true
      )
      const boxBot = matchProps(
        Manifold.cube([sx, sy, -kerf / 2 - (lb.min.z - m)], false).translate([
          lb.min.x - m,
          lb.min.y - m,
          lb.min.z - m
        ]),
        true
      )
      cleanup.push(boxTop, boxBot)
      top = solid.intersect(boxTop)
      bottom = solid.intersect(boxBot)
    } else {
      top = solid.trimByPlane([0, 0, 1], kerf / 2)
      bottom = solid.trimByPlane([0, 0, -1], kerf / 2)
    }
    cleanup.push(top, bottom)

    if (top.isEmpty() || bottom.isEmpty()) {
      return [manifoldToGeometry(solid)]
    }

    if (params.pins) {
      // Connector shapes: round/square/hex pegs (one piece carries the peg,
      // the other the socket) or dowel holes (both pieces get the same hole,
      // a separate wooden/printed dowel bridges them).
      const type = params.connectorType || 'pin'
      const seg = { pin: 48, square: 4, hex: 6, dowel: 48 }[type] ?? 48
      const r = Math.max(0.2, params.pinDiameter / 2)
      const h = Math.max(1, params.pinLength)
      const tol = Math.max(0, params.tolerance)
      // Tapered pegs (tip 80% of base radius) slide into their socket without
      // fighting the first layers — much easier to assemble than straight pins.
      const rTip = params.taper && type !== 'dowel' ? r * 0.8 : r
      for (const [x, y, off] of pinPlacements(wasm, solid, params)) {
        if (type === 'dowel') {
          const hole = matchProps(
            Manifold.cylinder(h + 2 * tol, r + tol, r + tol, seg, true).translate([x, y, off]),
            hasColor
          )
          cleanup.push(hole)
          const t2 = top.subtract(hole)
          const b2 = bottom.subtract(hole)
          cleanup.push(t2, b2)
          top = t2
          bottom = b2
          continue
        }
        const peg = matchProps(
          Manifold.cylinder(h, r, rTip, seg, true).translate([x, y, off]),
          hasColor
        )
        const socket = matchProps(
          Manifold.cylinder(h + 2 * tol, r + tol, rTip + tol, seg, true).translate([x, y, off]),
          hasColor
        )
        cleanup.push(peg, socket)
        const b2 = bottom.add(peg)
        const t2 = top.subtract(socket)
        cleanup.push(b2, t2)
        bottom = b2
        top = t2
      }
    }

    const gTop = manifoldToGeometry(top)
    const gBottom = manifoldToGeometry(bottom)
    if (hasColor) {
      // In the local frame the cut caps sit exactly at z = ±kerf/2.
      paintFaces(gTop, (v) => v.every((p) => Math.abs(p.z - kerf / 2) < 0.02))
      paintFaces(gBottom, (v) => v.every((p) => Math.abs(p.z + kerf / 2) < 0.02))
    }
    gTop.applyMatrix4(toWorld)
    gBottom.applyMatrix4(toWorld)
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
  const hasColor = !!geometry.attributes.color
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()
  const cube = matchProps(Manifold.cube([1, 1, 1], true), hasColor)
  const out = []
  for (const part of [solid.subtract(cube), solid.intersect(cube)]) {
    if (!part.isEmpty()) {
      const g = manifoldToGeometry(part)
      if (hasColor) {
        // Box faces sit on the unit cube's planes in the local frame.
        paintFaces(g, (v) =>
          ['x', 'y', 'z'].some((a) =>
            v.every((p) => Math.abs(Math.abs(p[a]) - 0.5) < 0.005)
          )
        )
      }
      out.push(g.applyMatrix4(m))
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
  const weldedMesh = solid.getMesh()
  solid.delete()

  await MeshoptSimplifier.ready
  const index = new Uint32Array(weldedMesh.triVerts)
  // De-interleave: the welded mesh may carry colors (numProp 6); meshopt
  // wants bare stride-3 positions and returns indices into the same vertex
  // order, so extra attributes survive untouched.
  const np = weldedMesh.numProp
  const n = weldedMesh.vertProperties.length / np
  let positions
  let colors = null
  if (np > 3) {
    positions = new Float32Array(n * 3)
    colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = weldedMesh.vertProperties[i * np]
      positions[i * 3 + 1] = weldedMesh.vertProperties[i * np + 1]
      positions[i * 3 + 2] = weldedMesh.vertProperties[i * np + 2]
      colors[i * 3] = weldedMesh.vertProperties[i * np + 3]
      colors[i * 3 + 1] = weldedMesh.vertProperties[i * np + 4]
      colors[i * 3 + 2] = weldedMesh.vertProperties[i * np + 5]
    }
  } else {
    positions = new Float32Array(weldedMesh.vertProperties)
  }
  const target = Math.max(4, Math.floor((index.length * ratio) / 3)) * 3
  const [newIndex] = MeshoptSimplifier.simplify(index, positions, 3, target, 0.05, [])

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.setIndex(new THREE.BufferAttribute(newIndex, 1))
  return niceNormals(g)
}
