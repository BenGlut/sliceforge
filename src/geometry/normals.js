import * as THREE from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

// Crease-aware display normals: flat cut faces stay flat, curved surfaces
// stay smooth — plain computeVertexNormals smears the two together and makes
// every cut look dirty. Guarded: the JS hash weld inside doesn't scale past
// ~500k tris (fallback: smooth normals).
export function niceNormals(geometry) {
  const tris = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3
  if (tris < 500_000) {
    try {
      return toCreasedNormals(geometry, THREE.MathUtils.degToRad(30))
    } catch {
      /* fall through */
    }
  }
  geometry.computeVertexNormals()
  return geometry
}
