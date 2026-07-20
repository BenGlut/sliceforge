import * as THREE from 'three'

/**
 * The cut plane is a posed object: { pos: [x,y,z], quat: [x,y,z,w] } — its
 * local +Z is the cut normal. Draggable in the viewport, serializable to the
 * worker. Kept free of any manifold import.
 */
export function planeBasis(plane) {
  const q = new THREE.Quaternion(...plane.quat)
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize()
  const origin = new THREE.Vector3(...plane.pos)
  return { normal, origin }
}

// Presets: quaternions turning +Z into each world axis.
export const AXIS_QUATS = {
  x: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)).toArray(),
  y: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)).toArray(),
  z: [0, 0, 0, 1]
}

export const DEFAULT_PLANE = { pos: [0, 0, 0], quat: AXIS_QUATS.y }
