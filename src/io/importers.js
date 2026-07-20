import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { niceNormals } from '../geometry/normals.js'

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
  return niceNormals(g)
}

// 3D-printing formats are Z-up; the three.js scene is Y-up. Convert on
// import so models stand upright like in any slicer, and convert back on
// export (see exporters.js) so slicers receive them upright too.
const Z_UP_FORMATS = new Set(['stl', 'obj', '3mf'])

export async function importModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  const buffer = await file.arrayBuffer()
  let g
  switch (ext) {
    case 'stl':
      g = toSingleGeometry(new STLLoader().parse(buffer))
      break
    case 'obj':
      g = toSingleGeometry(new OBJLoader().parse(new TextDecoder().decode(buffer)))
      break
    case '3mf':
      g = toSingleGeometry(new ThreeMFLoader().parse(buffer))
      break
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(buffer, '')
      g = toSingleGeometry(gltf.scene)
      break
    }
    default:
      throw new Error(`unsupported format: .${ext}`)
  }
  if (Z_UP_FORMATS.has(ext)) g.rotateX(-Math.PI / 2)
  return g
}

export const ACCEPTED = '.stl,.obj,.glb,.gltf,.3mf'
