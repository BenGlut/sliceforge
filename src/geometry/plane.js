import * as THREE from 'three'

/**
 * Compute the cut plane's normal + origin from UI params.
 * plane: { axis: 'x'|'y'|'z', offset, tiltA, tiltB } — tilts in degrees.
 * Kept free of any manifold import so the main bundle can show the plane
 * helper without loading the WASM engine.
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
