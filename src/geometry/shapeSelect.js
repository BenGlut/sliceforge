import * as THREE from 'three'

// Shape selection: from a clicked triangle, flood-fill across edges while
// neighbouring faces stay smooth; sharp creases (dihedral angle above the
// sensitivity) stop the growth. Works on indexed and raw (STL) geometry.
// Runs on the main thread — fine up to ~1M triangles; simplify first beyond.

function adjacency(geometry) {
  if (geometry.userData._adj) return geometry.userData._adj
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const triCount = (idx ? idx.length : geometry.attributes.position.count) / 3
  // Weld corners by quantized position so raw STL soup gets real adjacency.
  const keyMap = new Map()
  const cornerVid = new Int32Array(triCount * 3)
  let nextId = 0
  const q = 1e4
  for (let c = 0; c < triCount * 3; c++) {
    const v = idx ? idx[c] : c
    const key = `${Math.round(pos[v * 3] * q)}_${Math.round(pos[v * 3 + 1] * q)}_${Math.round(
      pos[v * 3 + 2] * q
    )}`
    let id = keyMap.get(key)
    if (id === undefined) {
      id = nextId++
      keyMap.set(key, id)
    }
    cornerVid[c] = id
  }
  // Pair up shared edges (vertex ids < 2^22 — fine below ~4M welded verts).
  const neighbors = new Int32Array(triCount * 3).fill(-1)
  const open = new Map()
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const slot = t * 3 + e
      const a = cornerVid[slot]
      const b = cornerVid[t * 3 + ((e + 1) % 3)]
      const key = a < b ? a * 4194304 + b : b * 4194304 + a
      const other = open.get(key)
      if (other === undefined) {
        open.set(key, slot)
      } else {
        neighbors[slot] = Math.floor(other / 3)
        neighbors[other] = t
        open.delete(key)
      }
    }
  }
  const adj = { cornerVid, neighbors, triCount }
  geometry.userData._adj = adj
  return adj
}

function triNormals(geometry) {
  if (geometry.userData._triNormals) return geometry.userData._triNormals
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const triCount = (idx ? idx.length : geometry.attributes.position.count) / 3
  const out = new Float32Array(triCount * 3)
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let t = 0; t < triCount; t++) {
    const i0 = (idx ? idx[t * 3] : t * 3) * 3
    const i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3
    const i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3
    a.fromArray(pos, i0)
    b.fromArray(pos, i1)
    c.fromArray(pos, i2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    ab.cross(ac).normalize()
    out[t * 3] = ab.x
    out[t * 3 + 1] = ab.y
    out[t * 3 + 2] = ab.z
  }
  geometry.userData._triNormals = out
  return out
}

function triCentroids(geometry) {
  if (geometry.userData._triCentroids) return geometry.userData._triCentroids
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const triCount = (idx ? idx.length : geometry.attributes.position.count) / 3
  const out = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 3; k++) {
      const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3
      x += pos[v]
      y += pos[v + 1]
      z += pos[v + 2]
    }
    out[t * 3] = x / 3
    out[t * 3 + 1] = y / 3
    out[t * 3 + 2] = z / 3
  }
  geometry.userData._triCentroids = out
  return out
}

/**
 * Grow from the clicked triangle by geodesic distance over the surface
 * (radius in model units), additionally stopped by sharp creases. The radius
 * makes selection predictable on smooth organic sculpts where crease
 * detection alone floods or stalls.
 */
export function growRegion(geometry, seedTri, angleDeg, radius = Infinity) {
  const { neighbors, triCount } = adjacency(geometry)
  const normals = triNormals(geometry)
  const cent = triCentroids(geometry)
  const cosT = Math.cos((angleDeg * Math.PI) / 180)
  const sel = new Uint8Array(triCount)
  const dist = new Float32Array(triCount).fill(Infinity)
  const queue = [seedTri]
  sel[seedTri] = 1
  dist[seedTri] = 0
  let count = 1
  while (queue.length) {
    const t = queue.shift()
    const nx = normals[t * 3]
    const ny = normals[t * 3 + 1]
    const nz = normals[t * 3 + 2]
    for (let e = 0; e < 3; e++) {
      const nb = neighbors[t * 3 + e]
      if (nb < 0) continue
      const dot = nx * normals[nb * 3] + ny * normals[nb * 3 + 1] + nz * normals[nb * 3 + 2]
      if (dot < cosT) continue
      const step = Math.hypot(
        cent[nb * 3] - cent[t * 3],
        cent[nb * 3 + 1] - cent[t * 3 + 1],
        cent[nb * 3 + 2] - cent[t * 3 + 2]
      )
      const nd = dist[t] + step
      if (nd > radius || nd >= dist[nb]) continue
      dist[nb] = nd
      if (!sel[nb]) {
        sel[nb] = 1
        count++
      }
      queue.push(nb)
    }
  }
  return { sel, count, triCount }
}

/**
 * Connected region whose triangles stay nearly coplanar with the SEED
 * triangle (each candidate is compared to the seed normal, not to its
 * neighbour — gentle curvature cannot drift the selection wide). Used to
 * light up "the face" under the cursor in place-on-face mode.
 */
export function coplanarRegion(geometry, seedTri, angleDeg = 12) {
  const { neighbors, triCount } = adjacency(geometry)
  const normals = triNormals(geometry)
  const cosT = Math.cos((angleDeg * Math.PI) / 180)
  const sx = normals[seedTri * 3]
  const sy = normals[seedTri * 3 + 1]
  const sz = normals[seedTri * 3 + 2]
  const sel = new Uint8Array(triCount)
  const queue = [seedTri]
  sel[seedTri] = 1
  let count = 1
  while (queue.length) {
    const t = queue.pop()
    for (let e = 0; e < 3; e++) {
      const nb = neighbors[t * 3 + e]
      if (nb < 0 || sel[nb]) continue
      if (sx * normals[nb * 3] + sy * normals[nb * 3 + 1] + sz * normals[nb * 3 + 2] < cosT)
        continue
      sel[nb] = 1
      count++
      queue.push(nb)
    }
  }
  return { sel, count, triCount }
}

export function regionPositions(geometry, sel, count) {
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const out = new Float32Array(count * 9)
  let o = 0
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3
      out[o++] = pos[v]
      out[o++] = pos[v + 1]
      out[o++] = pos[v + 2]
    }
  }
  return out
}

/**
 * Oriented cutting box for a selected region: the box's bottom face sits on
 * the plane fitted to the region's boundary loop (the "neck"), and it covers
 * the region with a margin. Feed the returned matrix to volumeCut.
 */
export function regionOrientedBox(geometry, sel) {
  const { cornerVid, neighbors } = adjacency(geometry)
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const corner = (t, k) => {
    const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3
    return new THREE.Vector3(pos[v], pos[v + 1], pos[v + 2])
  }

  // Boundary edges = selected tri edges whose neighbour is outside.
  const boundary = []
  const bCentroid = new THREE.Vector3()
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    for (let e = 0; e < 3; e++) {
      const nb = neighbors[t * 3 + e]
      if (nb >= 0 && sel[nb]) continue
      const a = corner(t, e)
      const b = corner(t, (e + 1) % 3)
      boundary.push([a, b])
      bCentroid.add(a).add(b)
    }
  }
  if (!boundary.length) return null
  bCentroid.divideScalar(boundary.length * 2)

  // Newell-style normal over the (consistently wound) boundary edges.
  const n = new THREE.Vector3()
  const ta = new THREE.Vector3()
  const tb = new THREE.Vector3()
  for (const [a, b] of boundary) {
    ta.subVectors(a, bCentroid)
    tb.subVectors(b, bCentroid)
    n.add(ta.cross(tb))
  }
  if (n.lengthSq() < 1e-12) return null
  n.normalize()

  // Region centroid decides which side of the boundary plane the shape is on.
  const rc = new THREE.Vector3()
  let rcount = 0
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    rc.add(corner(t, 0))
    rcount++
  }
  rc.divideScalar(rcount)
  if (n.dot(new THREE.Vector3().subVectors(rc, bCentroid)) < 0) n.negate()

  // Orthonormal basis (u, v, n) and region extents in it.
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(n.x) > 0.8) u.set(0, 1, 0)
  u.cross(n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, minW = Infinity, maxW = -Infinity
  const d = new THREE.Vector3()
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    for (let k = 0; k < 3; k++) {
      d.subVectors(corner(t, k), bCentroid)
      const pu = d.dot(u)
      const pv = d.dot(v)
      const pw = d.dot(n)
      if (pu < minU) minU = pu
      if (pu > maxU) maxU = pu
      if (pv < minV) minV = pv
      if (pv > maxV) maxV = pv
      if (pw < minW) minW = pw
      if (pw > maxW) maxW = pw
    }
  }
  const m = Math.max(1, 0.03 * Math.max(maxU - minU, maxV - minV, maxW - minW))
  minU -= m; maxU += m; minV -= m; maxV += m; maxW += m
  minW = Math.min(minW, 0) - 0.2 // just under the neck plane: full cut, no crumbs

  const size = new THREE.Vector3(maxU - minU, maxV - minV, maxW - minW)
  const center = bCentroid
    .clone()
    .addScaledVector(u, (minU + maxU) / 2)
    .addScaledVector(v, (minV + maxV) / 2)
    .addScaledVector(n, (minW + maxW) / 2)
  const rot = new THREE.Matrix4().makeBasis(u, v, n)
  const quat = new THREE.Quaternion().setFromRotationMatrix(rot)
  return new THREE.Matrix4().compose(center, quat, size).toArray()
}
