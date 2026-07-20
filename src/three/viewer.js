import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'

export const PIECE_COLORS = [0x5b8dee, 0xee8a5b, 0x62c48a, 0xd46bc8, 0xe0c34f, 0x6bd4cf, 0x9a7be4]

export class Viewer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    // Full retina (x2) is wasted on multi-million-triangle scenes — cap it.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0e1014)
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

    // In-view rotation wheel: drag a ring, the whole model rotates live around
    // its centre; on release the rotation is baked into the geometries.
    this.onRotateEnd = null
    this.pivot = new THREE.Object3D()
    this.scene.add(this.pivot)
    this.gizmo = new TransformControls(this.camera, canvas)
    this.gizmo.setMode('rotate')
    this.gizmo.setSize(1.15)
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(5))
    this.gizmoHelper = this.gizmo.getHelper()
    this.gizmoHelper.visible = false
    this.scene.add(this.gizmoHelper)
    this.gizmo.addEventListener('objectChange', () => this._applyPivotPreview())
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value
      if (!e.value) this._bakeGizmoRotation()
    })

    this._raf = 0
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()

    // Click-to-select: a press that barely moved (not an orbit drag, not a
    // gizmo grab) raycasts the pieces' bounding boxes — O(pieces), instant
    // even on multi-million-triangle meshes.
    this.onPieceClick = null
    this.onFacePick = null
    this.onShapePick = null
    this.faceMode = false
    this.shapeMode = false
    this.selectedPieceId = null
    this._raycaster = new THREE.Raycaster()
    this._downPos = null
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) this._rDownPos = [e.clientX, e.clientY]
      else this._downPos = [e.clientX, e.clientY]
    })
    // Right-CLICK (not a right-drag pan) opens the context menu.
    this.onContextMenu = null
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const down = this._rDownPos
      this._rDownPos = null
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return
      this.onContextMenu?.(e.clientX, e.clientY)
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return
      const down = this._downPos
      this._downPos = null
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return
      if (this.gizmo.dragging || this.volGizmo?.dragging) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      this._raycaster.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        ),
        this.camera
      )
      if (this.faceMode || this.shapeMode) {
        // Precise triangle raycast (meshes carry no rotation, so face data
        // is already in world space).
        const hits = this._raycaster.intersectObjects(
          this.piecesGroup.children.filter((m) => m.visible),
          false
        )
        const hit = hits[0]
        if (!hit?.face) return
        if (this.shapeMode) this.onShapePick?.(hit.faceIndex, hit.object.userData.pieceId)
        else this.onFacePick?.(hit.face.normal.clone())
        return
      }
      let best = null
      const target = new THREE.Vector3()
      for (const mesh of this.piecesGroup.children) {
        if (!mesh.visible) continue
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        const box = mesh.geometry.boundingBox.clone().translate(mesh.position)
        if (this._raycaster.ray.intersectBox(box, target)) {
          const d = target.distanceTo(this.camera.position)
          if (!best || d < best.d) best = { d, id: mesh.userData.pieceId }
        }
      }
      this.onPieceClick?.(best?.id ?? null)
    })

    this._onResize = () => {
      const { clientWidth: w, clientHeight: h } = canvas.parentElement
      if (!w || !h) return
      this.renderer.setSize(w, h, false)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', this._onResize)
    this._onResize()
  }

  // Surgical update: meshes are reused across renders (no GPU re-creation,
  // no material churn); the camera refits only when the caller says a new
  // model arrived — never on transforms/cuts (that jump read as a freeze).
  setPieces(pieces, explode = 0, refit = false) {
    const byId = new Map(
      [...this.piecesGroup.children].map((m) => [m.userData.pieceId, m])
    )
    this.piecesGroup.clear()
    const box = new THREE.Box3()
    pieces.forEach((p, i) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
      let mesh = byId.get(p.id)
      if (!mesh) {
        mesh = new THREE.Mesh(
          p.geometry,
          new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 })
        )
        mesh.userData.pieceId = p.id
      } else if (mesh.geometry !== p.geometry) {
        mesh.geometry = p.geometry
      }
      mesh.material.color.setHex(PIECE_COLORS[i % PIECE_COLORS.length])
      mesh.material.emissive.setHex(p.id === this.selectedPieceId ? 0x24407a : 0x000000)
      mesh.visible = p.visible
      this.piecesGroup.add(mesh)
    })
    if (!box.isEmpty()) box.getCenter(this.modelCenter)
    this.setExplode(explode)
    if (this.gizmoHelper.visible) this.pivot.position.copy(this.modelCenter)

    if (!box.isEmpty() && refit) this.fitCamera(box)
  }

  fitCamera(box = null) {
    if (!box) {
      box = new THREE.Box3()
      for (const m of this.piecesGroup.children) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
        box.union(m.geometry.boundingBox.clone().translate(m.position))
      }
      if (box.isEmpty()) return
    }
    const center = box.getCenter(new THREE.Vector3())
    const d = Math.max(box.getSize(new THREE.Vector3()).length(), 10)
    this.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.6, 0.8).multiplyScalar(d))
    this.controls.target.copy(center)
  }

  setExplode(factor) {
    const c = new THREE.Vector3()
    for (const mesh of this.piecesGroup.children) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      mesh.geometry.boundingBox.getCenter(c).sub(this.modelCenter)
      mesh.position.copy(c.multiplyScalar(factor))
    }
  }


  setShapeHighlight(positions) {
    if (this._shapeMesh) {
      this.scene.remove(this._shapeMesh)
      this._shapeMesh.geometry.dispose()
      this._shapeMesh.material.dispose()
      this._shapeMesh = null
    }
    if (!positions) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this._shapeMesh = new THREE.Mesh(
      g,
      // Orange, near-opaque: must read clearly on top of the blue pieces.
      new THREE.MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0.85,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
    )
    this.scene.add(this._shapeMesh)
  }

  setSelected(pieceId) {
    this.selectedPieceId = pieceId
    for (const mesh of this.piecesGroup.children) {
      mesh.material.emissive.setHex(mesh.userData.pieceId === pieceId ? 0x24407a : 0x000000)
    }
  }

  setVolumeBox(enabled) {
    if (enabled && this.piecesGroup.children.length) {
      if (!this.volBox) {
        this.volBox = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({
            color: 0xffb347,
            transparent: true,
            opacity: 0.22,
            depthWrite: false
          })
        )
        this.volBox.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
            new THREE.LineBasicMaterial({ color: 0xffb347 })
          )
        )
        this.scene.add(this.volBox)
        this.volGizmo = new TransformControls(this.camera, this.renderer.domElement)
        this.volGizmo.setSize(0.9)
        this.volGizmoHelper = this.volGizmo.getHelper()
        this.scene.add(this.volGizmoHelper)
        this.volGizmo.addEventListener('dragging-changed', (e) => {
          this.controls.enabled = !e.value
        })
      }
      const box = new THREE.Box3()
      for (const mesh of this.piecesGroup.children) box.union(mesh.geometry.boundingBox)
      const size = box.getSize(new THREE.Vector3())
      this.volBox.position.copy(this.modelCenter)
      this.volBox.scale.set(
        Math.max(1, size.x * 0.4),
        Math.max(1, size.y * 0.4),
        Math.max(1, size.z * 0.4)
      )
      this.volBox.rotation.set(0, 0, 0)
      this.volBox.visible = true
      this.volGizmo.attach(this.volBox)
      this.volGizmoHelper.visible = true
    } else if (this.volBox) {
      this.volGizmo.detach()
      this.volGizmoHelper.visible = false
      this.volBox.visible = false
    }
  }

  setVolumeMode(mode) {
    this.volGizmo?.setMode(mode)
  }

  getVolumeMatrix() {
    this.volBox.updateMatrix()
    return this.volBox.matrix.toArray()
  }

  setGizmo(enabled) {
    if (enabled && this.piecesGroup.children.length) {
      this.pivot.position.copy(this.modelCenter)
      this.pivot.quaternion.identity()
      this.gizmo.attach(this.pivot)
      this.gizmoHelper.visible = true
    } else {
      this.gizmo.detach()
      this.gizmoHelper.visible = false
    }
  }

  _applyPivotPreview() {
    const q = this.pivot.quaternion
    const c = this.pivot.position
    this.piecesGroup.quaternion.copy(q)
    this.piecesGroup.position.copy(c).sub(c.clone().applyQuaternion(q))
  }

  _bakeGizmoRotation() {
    const q = this.pivot.quaternion.clone()
    this.piecesGroup.position.set(0, 0, 0)
    this.piecesGroup.quaternion.identity()
    this.pivot.quaternion.identity()
    if (q.angleTo(new THREE.Quaternion()) > 1e-4) this.onRotateEnd?.(q)
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
