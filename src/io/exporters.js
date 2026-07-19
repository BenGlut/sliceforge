import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import JSZip from 'jszip'

function download(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function baseName(name) {
  return (name || 'model').replace(/\.[^.]+$/, '')
}

// The viewer is Y-up; printing formats (STL/OBJ/3MF) are Z-up. Rotate a
// COPY back to Z-up at export so slicers open the parts upright.
export function toZUpGeometry(geometry) {
  return geometry.clone().rotateX(Math.PI / 2)
}

function piecesToScene(pieces, zUp = false) {
  const scene = new THREE.Scene()
  const mat = new THREE.MeshStandardMaterial()
  for (const p of pieces) {
    const mesh = new THREE.Mesh(zUp ? toZUpGeometry(p.geometry) : p.geometry, mat)
    mesh.name = p.name
    scene.add(mesh)
  }
  return scene
}

export function exportSTL(pieces, modelName) {
  const exporter = new STLExporter()
  pieces.forEach((p, i) => {
    const mesh = new THREE.Mesh(toZUpGeometry(p.geometry), new THREE.MeshStandardMaterial())
    const data = exporter.parse(mesh, { binary: true })
    download(
      new Blob([data], { type: 'model/stl' }),
      `${baseName(modelName)}_${String(i + 1).padStart(2, '0')}.stl`
    )
  })
}

export function exportOBJ(pieces, modelName) {
  const data = new OBJExporter().parse(piecesToScene(pieces, true))
  download(new Blob([data], { type: 'model/obj' }), `${baseName(modelName)}.obj`)
}

export function exportGLB(pieces, modelName) {
  new GLTFExporter().parse(
    piecesToScene(pieces),
    (glb) => download(new Blob([glb], { type: 'model/gltf-binary' }), `${baseName(modelName)}.glb`),
    (err) => console.error('GLB export failed', err),
    { binary: true }
  )
}

// Minimal but valid 3MF: one object per piece, all placed in the build.
export async function export3MF(pieces, modelName) {
  const objects = pieces
    .map((p, i) => {
      const zg = toZUpGeometry(p.geometry)
      const g = zg.index ? zg : null
      const pos = zg.attributes.position
      let verts = ''
      for (let v = 0; v < pos.count; v++) {
        verts += `<vertex x="${pos.getX(v)}" y="${pos.getY(v)}" z="${pos.getZ(v)}"/>`
      }
      let tris = ''
      if (g) {
        const idx = g.index
        for (let t = 0; t < idx.count; t += 3) {
          tris += `<triangle v1="${idx.getX(t)}" v2="${idx.getX(t + 1)}" v3="${idx.getX(t + 2)}"/>`
        }
      } else {
        for (let t = 0; t < pos.count; t += 3) {
          tris += `<triangle v1="${t}" v2="${t + 1}" v3="${t + 2}"/>`
        }
      }
      return `<object id="${i + 1}" type="model" name="${p.name}"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object>`
    })
    .join('')
  const items = pieces.map((_, i) => `<item objectid="${i + 1}"/>`).join('')
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${objects}</resources><build>${items}</build></model>`

  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
      `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`
  )
  zip.file('3D/3dmodel.model', model)
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  download(blob, `${baseName(modelName)}.3mf`)
}
