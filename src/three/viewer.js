import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const PIECE_COLORS = [0x5b8dee, 0xee8a5b, 0x62c48a, 0xd46bc8, 0xe0c34f, 0x6bd4cf, 0x9a7be4]

export class Viewer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x14161c)
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000)
    this.camera.position.set(120, 90, 120)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 2, 1.5)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xa0b4ff, 0.5)
    fill.position.set(-1.5, -0.5, -1)
    this.scene.add(fill)

    this.grid = new THREE.GridHelper(200, 20, 0x3a4152, 0x242a38)
    this.scene.add(this.grid)

    this.piecesGroup = new THREE.Group()
    this.scene.add(this.piecesGroup)
    this.planeHelper = null
    this.modelCenter = new THREE.Vector3()

    this._raf = 0
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()

    this._onResize = () => {
      const { clientWidth: w, clientHeight: h } = canvas.parentElement
      this.renderer.setSize(w, h, false)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', this._onResize)
    this._onResize()
  }

  setPieces(pieces, explode = 0) {
    this.piecesGroup.clear()
    const box = new THREE.Box3()
    pieces.forEach((p) => {
      p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    if (!box.isEmpty()) box.getCenter(this.modelCenter)

    pieces.forEach((p, i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: PIECE_COLORS[i % PIECE_COLORS.length],
        roughness: 0.55,
        metalness: 0.05
      })
      const mesh = new THREE.Mesh(p.geometry, mat)
      mesh.visible = p.visible
      mesh.userData.pieceId = p.id
      this.piecesGroup.add(mesh)
    })
    this.setExplode(explode)

    if (!box.isEmpty() && pieces.length === 1) {
      const size = box.getSize(new THREE.Vector3()).length()
      const d = Math.max(size, 10)
      this.camera.position
        .copy(this.modelCenter)
        .add(new THREE.Vector3(0.8, 0.6, 0.8).multiplyScalar(d))
      this.controls.target.copy(this.modelCenter)
      this.grid.position.y = box.min.y
    }
  }

  setExplode(factor) {
    const c = new THREE.Vector3()
    for (const mesh of this.piecesGroup.children) {
      mesh.geometry.boundingBox.getCenter(c).sub(this.modelCenter)
      mesh.position.copy(c.multiplyScalar(factor))
    }
  }

  showPlane(normal, origin, size) {
    this.hidePlane()
    const plane = new THREE.Plane(normal, -normal.dot(origin))
    this.planeHelper = new THREE.PlaneHelper(plane, size, 0xffb347)
    this.scene.add(this.planeHelper)
  }

  hidePlane() {
    if (this.planeHelper) {
      this.scene.remove(this.planeHelper)
      this.planeHelper = null
    }
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._onResize)
    this.renderer.dispose()
  }
}
