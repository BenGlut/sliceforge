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
    this.onPlanePick = null
    this.onPlaneChange = null
    this.onPinPick = null
    this.faceMode = false
    this.shapeMode = false
    this.planeMode = false
    this.pinMode = false
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
      if (this.planeMode && this.planeGizmo?.dragging) return
      // Connector placement: clicks land on the plane quad, in plane-local mm.
      if (this.pinMode && this.planeObj?.visible) {
        const hit = this._raycaster.intersectObject(this.planeObj, false)[0]
        if (hit) {
          const local = this.planeObj.worldToLocal(hit.point.clone())
          const sc = this.planeObj.scale.x
          this.onPinPick?.(local.x * sc, local.y * sc)
        }
        return
      }
      if (this.faceMode || this.shapeMode || this.planeMode) {
        // Precise triangle raycast (meshes carry no rotation, so face data
        // is already in world space).
        const hits = this._raycaster.intersectObjects(
          this.piecesGroup.children.filter((m) => m.visible),
          false
        )
        const hit = hits[0]
        if (!hit?.face) return
        if (this.shapeMode) this.onShapePick?.(hit.faceIndex, hit.object.userData.pieceId)
        else if (this.planeMode)
          this.onPlanePick?.(hit.point.clone(), hit.face.normal.clone())
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
      // Colored models render their own vertex colors; plain ones get the
      // per-piece palette.
      const hasColor = !!p.geometry.attributes.color
      if (mesh.material.vertexColors !== hasColor) {
        mesh.material.vertexColors = hasColor
        mesh.material.needsUpdate = true
      }
      if (hasColor) mesh.material.color.setHex(0xffffff)
      else mesh.material.color.setHex(PIECE_COLORS[i % PIECE_COLORS.length])
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

  // Exploded view in REAL millimetres: the gap added between neighbouring
  // pieces equals gapMm. Uniform expansion scaled by the median
  // nearest-neighbour centroid distance — even spacing on a puzzle grid as
  // well as on a simple two-half cut.
  setExplode(gapMm) {
    const meshes = this.piecesGroup.children
    if (!meshes.length) return
    const centers = meshes.map((m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      return m.geometry.boundingBox.getCenter(new THREE.Vector3())
    })
    let B = 1
    if (centers.length > 1) {
      const nn = centers.map((c, i) =>
        Math.min(...centers.map((o, j) => (i === j ? Infinity : c.distanceTo(o))))
      )
      nn.sort((a, b) => a - b)
      B = Math.max(1, nn[Math.floor(nn.length / 2)])
    }
    const k = (gapMm || 0) / B
    meshes.forEach((m, i) => {
      m.position.copy(centers[i]).sub(this.modelCenter).multiplyScalar(k)
    })
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

  // The cut plane is a grabbable object: translucent quad + outline, driven
  // by its own TransformControls (translate/rotate, toggled via T/R).
  showPlane(plane, size) {
    if (!this.planeObj) {
      const geo = new THREE.PlaneGeometry(1, 1)
      this.planeObj = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0x2f6bff,
          transparent: true,
          opacity: 0.14,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x2f6bff })
      )
      this.planeObj.add(edges)
      this.scene.add(this.planeObj)
      this.planeGizmo = new TransformControls(this.camera, this.renderer.domElement)
      this.planeGizmo.setSize(0.85)
      this.planeGizmoHelper = this.planeGizmo.getHelper()
      this.scene.add(this.planeGizmoHelper)
      this.planeGizmo.addEventListener('dragging-changed', (e) => {
        this.controls.enabled = !e.value
        if (!e.value) this._commitPlane()
      })
      this.planeGizmo.addEventListener('objectChange', () => this._commitPlane())
    }
    // Don't fight the user's drag with store round-trips.
    if (!this.planeGizmo.dragging) {
      this.planeObj.position.fromArray(plane.pos)
      this.planeObj.quaternion.fromArray(plane.quat)
    }
    this.planeObj.scale.setScalar(Math.max(10, size))
    this.planeObj.visible = true
    this.planeGizmo.attach(this.planeObj)
    this.planeGizmoHelper.visible = true
  }

  _commitPlane() {
    if (!this.planeObj) return
    this.onPlaneChange?.({
      pos: this.planeObj.position.toArray(),
      quat: this.planeObj.quaternion.toArray()
    })
  }

  setPlaneGizmoMode(mode) {
    this.planeGizmo?.setMode(mode)
  }

  // Puzzle preview: one translucent quad per upcoming grid cut, bounded to
  // the model box, updated live as the block size changes.
  setPuzzlePreview(planes, box) {
    if (!this._puzzleGroup) {
      this._puzzleGroup = new THREE.Group()
      this.scene.add(this._puzzleGroup)
    }
    this._puzzleGroup.clear()
    if (!planes?.length || !box) return
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const quad = new THREE.PlaneGeometry(1, 1)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2f6bff,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.6 })
    const edges = new THREE.EdgesGeometry(quad)
    for (const { axis, offset } of planes) {
      const m = new THREE.Mesh(quad, mat)
      m.add(new THREE.LineSegments(edges, lineMat))
      if (axis === 'x') {
        m.rotation.y = Math.PI / 2
        m.scale.set(size.z * 1.02, size.y * 1.02, 1)
        m.position.set(offset, c.y, c.z)
      } else if (axis === 'y') {
        m.rotation.x = -Math.PI / 2
        m.scale.set(size.x * 1.02, size.z * 1.02, 1)
        m.position.set(c.x, offset, c.z)
      } else {
        m.scale.set(size.x * 1.02, size.y * 1.02, 1)
        m.position.set(c.x, c.y, offset)
      }
      this._puzzleGroup.add(m)
    }
  }

  // Connector markers live as children of the plane object, so they follow
  // its drags for free. Positions are plane-local mm; the parent's uniform
  // scale is compensated per marker.
  setPinMarkers(uvList, pinDiameter, pinLength) {
    if (!this.planeObj) return
    if (!this._pinGroup) {
      this._pinGroup = new THREE.Group()
      this.planeObj.add(this._pinGroup)
    }
    this._pinGroup.clear()
    const sc = this.planeObj.scale.x
    for (const [u, v] of uvList) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(pinDiameter / 2, pinDiameter / 2, pinLength, 24),
        new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 })
      )
      m.rotation.x = Math.PI / 2
      m.scale.setScalar(1 / sc)
      m.position.set(u / sc, v / sc, 0)
      this._pinGroup.add(m)
    }
  }

  // Ghost the parts so the plane (and the connectors on it) read through
  // the material while placing.
  setPiecesGhost(on) {
    for (const mesh of this.piecesGroup.children) {
      mesh.material.transparent = on
      mesh.material.opacity = on ? 0.35 : 1
      mesh.material.depthWrite = !on
      mesh.material.needsUpdate = true
    }
  }

  hidePlane() {
    if (this.planeObj) {
      this.planeObj.visible = false
      this.planeGizmo.detach()
      this.planeGizmoHelper.visible = false
    }
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._onResize)
    this.renderer.dispose()
  }
}
