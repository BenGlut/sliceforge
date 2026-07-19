import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

function collectGeometries(root) {
  const geoms = []
  root.updateMatrixWorld(true)
  root.traverse((node) => {
    if (node.isMesh && node.geometry) {
      const g = node.geometry.clone().applyMatrix4(node.matrixWorld)
      geoms.push(g.index ? g.toNonIndexed() : g)
    }
  })
  return geoms
}

function toSingleGeometry(rootOrGeometry) {
  let g
  if (rootOrGeometry.isBufferGeometry) {
    g = rootOrGeometry.index ? rootOrGeometry.toNonIndexed() : rootOrGeometry
  } else {
    const geoms = collectGeometries(rootOrGeometry)
    if (!geoms.length) throw new Error('no mesh found in file')
    // Keep positions only: pieces are re-derived solids, materials don't survive cuts.
    for (const geom of geoms) {
      for (const name of Object.keys(geom.attributes)) {
        if (name !== 'position') geom.deleteAttribute(name)
      }
    }
    g = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name)
  }
  g.computeVertexNormals()
  return g
}

export async function importModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  const buffer = await file.arrayBuffer()
  switch (ext) {
    case 'stl':
      return toSingleGeometry(new STLLoader().parse(buffer))
    case 'obj':
      return toSingleGeometry(new OBJLoader().parse(new TextDecoder().decode(buffer)))
    case '3mf':
      return toSingleGeometry(new ThreeMFLoader().parse(buffer))
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(buffer, '')
      return toSingleGeometry(gltf.scene)
    }
    default:
      throw new Error(`unsupported format: .${ext}`)
  }
}

export const ACCEPTED = '.stl,.obj,.glb,.gltf,.3mf'
