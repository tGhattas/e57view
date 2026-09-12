import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EDL_FS, QUAD_VS } from './shaders';
import { CellRenderer, pointInRegion, polyHalf, simplifyRing, PRISM_MAX_V, REC, type DrawStats, type LeafMeta, type Region, type UndoRecord } from './cells';
import { MeshView, type MeshData } from './meshview';
import { Entity } from './entities';

const BG = new THREE.Color(0x05090b);
const TEAL = 0x46c6d2;
const ROLE_COLOR: Record<string, number> = { keep: TEAL, pending: 0xf2b544, delete: 0xff7b72 };

export const isTouch = matchMedia('(pointer: coarse)').matches;
export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const maxDPR = 2;

export type Knobs = {
  colorMode: number; size: number; sizeMode: number; round: boolean; maxPx: number;
  edl: boolean; edlStrength: number; edlRadius: number; normalShade: boolean;
  bright: number; gamma: number; iMin: number; iMax: number;
  clipZMin: number; clipZMax: number;
  budget: number; density: number; movingQuality: number;
  flySpeed: number;
};
export type Tool = 'none' | 'measure' | 'segment' | 'place';
export type Display = 'points' | 'mesh' | 'both';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

function occlusion(): { right: number; bottom: number } {
  const panel = document.getElementById('panel');
  if (!panel || panel.classList.contains('hidden')) return { right: 0, bottom: 0 };
  const r = panel.getBoundingClientRect();
  const coversBottom = r.bottom >= innerHeight - 2 && r.width >= innerWidth - 2;
  if (coversBottom) return { right: 0, bottom: Math.max(0, innerHeight - r.top) };
  return { right: Math.max(0, innerWidth - r.left), bottom: 0 };
}
/** True when a matrix's upper-left 3x3 is the identity — a pure translation. */
function sameLinear(m: THREE.Matrix4): boolean {
  const e = m.elements;
  for (const [i, want] of [[0, 1], [1, 0], [2, 0], [4, 0], [5, 1], [6, 0], [8, 0], [9, 0], [10, 1]] as [number, number][]) {
    if (Math.abs(e[i] - want) > 1e-12) return false;
  }
  return true;
}
function halfToFloat(h: number): number {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
function discTexture(color: string, ring = '#05090b'): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  g.lineWidth = 6; g.strokeStyle = ring; g.stroke();
  g.beginPath(); g.arc(32, 32, 10, 0, Math.PI * 2); g.fillStyle = ring; g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ----------------------------------------------------------------- fly mode
class Fly {
  enabled = false;
  keys = new Set<string>();
  yaw = 0; pitch = 0;
  private dragging = false; private lx = 0; private ly = 0;
  speed = 2.0;
  constructor(private cam: THREE.PerspectiveCamera, private el: HTMLElement, private onMove: () => void) {
    el.addEventListener('pointerdown', e => { if (!this.enabled) return; this.dragging = true; this.lx = e.clientX; this.ly = e.clientY; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => {
      if (!this.enabled || !this.dragging) return;
      const dx = e.clientX - this.lx, dy = e.clientY - this.ly; this.lx = e.clientX; this.ly = e.clientY;
      this.yaw -= dx * 0.0032; this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0032));
      this.apply(); onMove();
    });
    el.addEventListener('pointerup', () => { this.dragging = false; });
    el.addEventListener('pointercancel', () => { this.dragging = false; });
    addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this.enabled || e.metaKey || e.ctrlKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase(); this.keys.add(k);
      if (['w','a','s','d','q','e','arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('wheel', e => { if (!this.enabled) return; e.preventDefault(); this.speed = Math.min(60, Math.max(0.05, this.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); }, { passive: false });
  }
  enter() { const f = new THREE.Vector3(); this.cam.getWorldDirection(f); this.yaw = Math.atan2(f.y, f.x); this.pitch = Math.asin(Math.max(-1, Math.min(1, f.z))); this.enabled = true; this.apply(); }
  exit() { this.enabled = false; this.keys.clear(); }
  private apply() {
    const cp = Math.cos(this.pitch);
    const f = new THREE.Vector3(Math.cos(this.yaw) * cp, Math.sin(this.yaw) * cp, Math.sin(this.pitch));
    this.cam.up.set(0, 0, 1); this.cam.lookAt(this.cam.position.clone().add(f));
  }
  update(dt: number): boolean {
    if (!this.enabled || !this.keys.size) return false;
    const k = this.keys;
    const f = new THREE.Vector3(); this.cam.getWorldDirection(f);
    const r = new THREE.Vector3().crossVectors(f, this.cam.up).normalize();
    const v = new THREE.Vector3();
    if (k.has('w') || k.has('arrowup')) v.add(f); if (k.has('s') || k.has('arrowdown')) v.sub(f);
    if (k.has('d') || k.has('arrowright')) v.add(r); if (k.has('a') || k.has('arrowleft')) v.sub(r);
    if (k.has('e') || k.has(' ')) v.z += 1; if (k.has('q')) v.z -= 1;
    if (v.lengthSq() === 0) return false;
    this.cam.position.addScaledVector(v.normalize(), this.speed * (k.has('shift') ? 4 : 1) * dt);
    return true;
  }
}

const PANO_VS = `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PANO_FS = `
uniform sampler2D uTex; uniform mat3 uInvRot; uniform float uFlipU, uOffU, uOpacity;
varying vec3 vDir;
void main(){
  vec3 d = normalize(uInvRot * vDir);
  float az = atan(d.y, d.x); float el = asin(clamp(d.z, -1.0, 1.0));
  float u = fract(0.5 - az / 6.2831853 + uOffU); if (uFlipU > 0.5) u = 1.0 - u;
  float v = 0.5 - el / 3.14159265;
  gl_FragColor = vec4(texture2D(uTex, vec2(u, v)).rgb, uOpacity);
}`;

export interface CameraRecord {
  projection: 'orthographic' | 'perspective';
  position: number[]; target: number[]; up: number[];
  fovDeg: number | null; aspect: number;
  width: number; height: number; devicePixelRatio: number;
  near: number; far: number; distanceToTarget: number;
  metresPerPixel: number; metresPerPixelNote: string;
  viewProjection: number[];
}
/** The pixel-to-metre mapping of an orthographic render. `topLeft` plus the two per-pixel
 *  world steps is exact for any orientation; originX/originY/extentX/extentY are the plan
 *  and elevation form, and are null when the view is not axis aligned. */
export interface OrthoMap {
  width: number; height: number; metresPerPixel: number;
  topLeft: number[]; perPixelRight: number[]; perPixelDown: number[];
  rightAxis: string | null; upAxis: string | null; viewAxis: string | null;
  originX: number | null; originY: number | null; extentX: number; extentY: number;
  centre: number[]; depthRange: number[]; note: string;
}

export interface Station { image: number; t: [number, number, number]; q: [number, number, number, number]; w: number; h: number; bytes: number; name: string | null }

export class Viewer {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  fly: Fly;
  /** Every cloud in memory. Exactly one is active; the draw loop shows all the visible ones. */
  entities: Entity[] = [];
  activeId = '';
  mesh!: MeshView;
  meshTris = 0;
  /** Display range and value filter for the active scalar field. hi <= lo disables the filter. */
  sf = { min: 0, max: 1, lo: 0, hi: -1, hide: false };
  display: Display = 'points';
  meshFlat = false;
  meshShade = true;
  canvas: HTMLCanvasElement;
  private rt!: THREE.WebGLRenderTarget;
  private rtType: THREE.TextureDataType = THREE.FloatType;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private edlMat: THREE.ShaderMaterial;
  private emptyScene = new THREE.Scene();
  overlay = new THREE.Scene();
  private panoScene = new THREE.Scene();
  knobs!: Knobs;
  onEntitiesChange: (() => void) | null = null;
  /** Set while an orthographic projection is swapped in: its half extents in metres. */
  private ortho: { halfW: number; halfH: number } | null = null;
  /** World box the surface is clipped to while a section is rendered. */
  meshClip: { min: THREE.Vector3; max: THREE.Vector3 } | null = null;
  zRange: [number, number] = [0, 1];
  private cw = innerWidth; private ch = innerHeight;

  // regions + gizmo
  regions: Region[] = [];
  regionHide = false;
  private regionGroups = new Map<string, THREE.Group>();
  activeRegion: string | null = null;
  /** Public so the Transform panel can borrow it for the cloud proxy. Only ever attached to
   *  one object at a time, which is what stops the crop gizmo and the cloud gizmo fighting. */
  tc: TransformControls;
  gizmoMode: GizmoMode = 'translate';
  gizmoBusy = false;
  onRegionChange: ((r: Region) => void) | null = null;
  onSuggestionDecision: ((id: string, accept: boolean) => void) | null = null;
  /** Interactive cloud transform: a proxy object at the bounding-box centre carries the
   *  gizmo, and its movement is turned into a delta on the model matrix. */
  private proxy: THREE.Object3D | null = null;
  private dragBase: THREE.Matrix4 | null = null;
  private dragFrom = new THREE.Matrix4();
  modelGizmo = false;
  /** Fires on every gizmo frame, then once with done=true carrying the matrix the drag
   *  started from, so the caller can push exactly one undo step per drag. */
  onModelDrag: ((done: boolean, base: THREE.Matrix4) => void) | null = null;
  private slabels = new Map<string, HTMLDivElement>();

  // tools / clicks
  tool: Tool = 'none';
  onClick: ((world: THREE.Vector3 | null, cx: number, cy: number) => void) | null = null;
  onStationClick: ((index: number) => void) | null = null;
  private pdown: { x: number; y: number; t: number } | null = null;
  private stationTimer = 0;

  // measurements
  private measures: { a: THREE.Vector3; b: THREE.Vector3; line: THREE.Line; label: HTMLDivElement; dist: number }[] = [];
  private pending: THREE.Vector3 | null = null;
  private pendingMark: THREE.Sprite | null = null;
  private labelsEl = document.getElementById('labels')!;
  private dotTex = discTexture('#46c6d2');
  private stationTex = discTexture('#f2b544', '#3a2c13');

  // stations / bubble
  private stationGroup = new THREE.Group();
  private stationSprites: THREE.Sprite[] = [];
  stations: Station[] = [];
  bubble: { index: number; pos: THREE.Vector3; mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null = null;
  pointAlpha = 0.35;
  onBubbleExit: (() => void) | null = null;

  // render-on-demand
  private dirty = true;
  private moving = false;
  private movingTimer = 0;
  private lastT = performance.now();
  stats: DrawStats = { leavesVisible: 0, leavesDrawn: 0, pointsDrawn: 0, pointsTotal: 0 };
  frameMs = 0;
  private frames = 0; private lastFps = performance.now();
  fps = 0;
  onStats: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, maxDPR));
    this.renderer.setClearColor(BG, 1);
    this.renderer.autoClear = false;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(40, -60, 45);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = true; this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.05; this.controls.maxDistance = 5000;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.rotateSpeed = isTouch ? 0.6 : 0.9;
    this.controls.addEventListener('change', () => this.touch());

    this.fly = new Fly(this.camera, canvas, () => this.touch());

    this.tc = new TransformControls(this.camera, canvas);
    this.tc.size = isTouch ? 1.1 : 0.8;
    this.tc.enabled = false;
    this.overlay.add(this.tc.getHelper());
    this.tc.addEventListener('dragging-changed', (e: any) => {
      this.gizmoBusy = !!e.value;
      if (!this.fly.enabled) this.controls.enabled = !e.value;
      if (this.modelGizmo && this.proxy) {
        if (e.value) { this.dragBase = this.cells.model.clone(); this.proxy.updateMatrixWorld(true); this.dragFrom.copy(this.proxy.matrixWorld); }
        else { const base = this.dragBase; this.dragBase = null; this.retightenBounds(); this.recentreProxy(); if (base) this.onModelDrag?.(true, base); }
      } else if (!e.value && this.activeRegion) {
        // one more notification now the handle is released, so anything too expensive to
        // recompute per frame (a point count, say) gets its turn
        const r = this.regions.find(x => x.id === this.activeRegion);
        if (r) this.onRegionChange?.(r);
      }
      this.touch();
    });
    this.tc.addEventListener('objectChange', () => { if (this.modelGizmo) this.dragModel(); else this.syncActiveFromGroup(); });

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.entities.push(new Entity(gl, 'e1', 'Scan 1'));
    this.activeId = 'e1';
    this.mesh = new MeshView(gl);

    this.edlMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: EDL_FS,
      uniforms: { uTex: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uRadius: { value: 1.4 }, uStrength: { value: 0.32 }, uEnabled: { value: 1 }, uBias: { value: 0.02 }, uPointAlpha: { value: 1 }, uBg: { value: new THREE.Vector3(BG.r, BG.g, BG.b) } },
      depthTest: false, depthWrite: false, transparent: true,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edlMat));
    this.overlay.add(this.stationGroup);

    const hasFull = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalf = !!gl.getExtension('EXT_color_buffer_half_float');
    this.rtType = hasFull ? THREE.FloatType : (hasHalf ? THREE.HalfFloatType : THREE.UnsignedByteType);
    if (this.rtType === THREE.UnsignedByteType) this.edlMat.uniforms.uEnabled.value = 0;

    this.resize();
    addEventListener('resize', () => this.resize());
    canvas.addEventListener('dblclick', e => { clearTimeout(this.stationTimer); this.pickTarget(e.clientX, e.clientY); });
    canvas.addEventListener('pointerdown', e => { this.pdown = (this.tc.enabled && this.tc.axis) ? null : { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', e => {
      const d = this.pdown; this.pdown = null;
      if (this.gizmoBusy || (this.tc.enabled && this.tc.axis)) return;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
      this.handleClick(e.clientX, e.clientY);
    });
  }

  // --------------------------------------------------------- entities
  get active(): Entity { return this.entities.find(e => e.id === this.activeId) ?? this.entities[0]; }
  /** The active entity's renderer. Every tool works through this, which is what keeps the
   *  single-cloud code in main.ts unchanged. */
  get cells(): CellRenderer { return this.active.cells; }
  get robust(): THREE.Box3 | null { return this.active.robust; }
  set robust(b: THREE.Box3 | null) { this.active.robust = b; }
  get gl(): WebGL2RenderingContext { return this.renderer.getContext() as WebGL2RenderingContext; }
  get visibleEntities(): Entity[] { return this.entities.filter(e => e.visible && e.cells.total > 0); }
  addEntity(name: string, id?: string): Entity {
    const e = new Entity(this.gl, id ?? 'e' + (++this.entitySeq + this.entities.length), name);
    this.entities.push(e);
    this.dirty = true; this.onEntitiesChange?.();
    return e;
  }
  private entitySeq = 1;
  removeEntity(id: string): boolean {
    if (this.entities.length <= 1) return false;
    const i = this.entities.findIndex(e => e.id === id);
    if (i < 0) return false;
    const [gone] = this.entities.splice(i, 1);
    gone.dispose(this.gl);
    if (this.activeId === id) this.activeId = this.entities[Math.max(0, i - 1)].id;
    this.recomputeVisible();
    this.dirty = true; this.onEntitiesChange?.();
    return true;
  }
  setActiveEntity(id: string) {
    if (!this.entities.some(e => e.id === id) || id === this.activeId) return;
    this.activeId = id;
    this.setActiveRegion(null); this.setModelGizmo(false);
    this.syncMeshModel();
    this.applyZRange();
    this.dirty = true; this.onEntitiesChange?.();
  }
  private recomputeVisible() { this.applyZRange(); }
  /** Union of every visible entity's box: what fitting and the height range should describe. */
  visibleBounds(): THREE.Box3 {
    const b = new THREE.Box3();
    for (const e of this.visibleEntities) b.union(e.bounds());
    return b.isEmpty() ? this.bounds() : b;
  }
  get loadedAll() { return this.entities.reduce((n, e) => n + e.cells.total, 0); }

  touch() {
    this.dirty = true; this.moving = true;
    clearTimeout(this.movingTimer);
    this.movingTimer = window.setTimeout(() => { this.moving = false; this.dirty = true; }, 160);
  }

  resize() { this.resizeTo(innerWidth, innerHeight); }
  private resizeTo(w: number, h: number) {
    this.cw = w; this.ch = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const dpr = this.renderer.getPixelRatio();
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    if (this.rt) this.rt.dispose();
    this.rt = new THREE.WebGLRenderTarget(pw, ph, { type: this.rtType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.edlMat.uniforms.uRes.value.set(pw, ph);
    this.dirty = true;
  }

  // ------------------------------------------------------------ data
  addLeaf(blocks: ArrayBuffer[], count: number, meta: LeafMeta, preview = false, capacity?: number, tag?: number) { this.cells.enqueue(blocks, count, meta, preview, capacity, tag); this.dirty = true; }
  /** Uploads pending across every entity, so a caller can wait for a load to settle. */
  get pendingUploads() { return this.entities.reduce((n, e) => n + e.cells.pendingCount, 0); }
  appendLeaf(tag: number, recs: Uint8Array, n: number) { this.cells.appendLeaf(tag, recs, n); this.dirty = true; }
  dropPreview() { this.cells.dropPreview(); this.dirty = true; }
  /** Empty the active entity. Other entities are untouched: "Open file…" clearing everything
   *  is main.ts's business, not the renderer's. */
  clear() { this.cells.clear(); this.robust = null; this.setRegions([]); this.clearMeasures(); this.setStations([]); this.exitBubble(); this.dirty = true; }
  /** Points in the active entity — what every readout and every tool means by "loaded". */
  get loaded() { return this.cells.total; }
  /** Percentile bounds from the loader, in the cloud's own frame; stored transformed, since
   *  everything that reads `bounds()` works in world space. */
  setRobustBounds(lo: [number, number, number], hi: [number, number, number]) {
    this.robust = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)).applyMatrix4(this.cells.model);
    this.applyZRange(); this.dirty = true;
  }
  /** The box a tool should work in: the active entity's. */
  bounds() { return this.active.bounds(); }
  applyZRange() { const b = this.visibleBounds(); if (!b.isEmpty()) this.zRange = [b.min.z, b.max.z]; }
  setKnobs(k: Knobs) {
    this.knobs = k; this.fly.speed = k.flySpeed;
    this.edlMat.uniforms.uEnabled.value = k.edl && this.rtType !== THREE.UnsignedByteType ? 1 : 0;
    this.edlMat.uniforms.uStrength.value = k.edlStrength; this.edlMat.uniforms.uRadius.value = k.edlRadius;
    this.dirty = true;
  }

  // ------------------------------------------------------------ cloud transform
  /** Replace the cloud's model matrix. Nothing is baked: the points stay quantised in their
   *  leaf cubes and every consumer reads them through this matrix. The robust framing box
   *  and the station markers ride along on the delta so the derived state stays consistent. */
  setModel(m: THREE.Matrix4, tight = true) {
    const delta = m.clone().multiply(this.cells.model.clone().invert());
    this.cells.setModel(m);
    // Re-boxing a rotated box inflates it, and the framing box drives fitting, the elevation
    // ramp and the clipping sliders — so when the linear part changes it is measured again
    // from a sample rather than carried through the delta. A pure translation carries over
    // exactly, so it is left alone. During a drag the readback would stall every frame, so
    // the cheap carry-over stands in until the handle is released.
    const linear = !sameLinear(delta);
    const s = tight && linear ? this.sampledBox() : null;
    if (s) this.robust = s;
    else if (this.robust && !this.robust.isEmpty()) this.robust.applyMatrix4(delta);
    this.syncMeshModel();
    this.refreshStations();
    this.applyZRange();
    if (this.proxy && !this.gizmoBusy) this.recentreProxy();
    this.dirty = true;
  }
  /** World box of a uniform sample of the points. The leaves are shuffled, so a prefix of
   *  each is a uniform subsample — the same trick the level-of-detail draw uses. */
  private sampledBox(): THREE.Box3 | null {
    return this.sampleBoxOf(this.active);
  }
  private sampleBoxOf(e: Entity): THREE.Box3 | null {
    const b = new THREE.Box3(), v = new THREE.Vector3();
    let n = 0;
    for (const { leaf, recs, n: cnt } of e.cells.sample(800)) {
      const xyz = e.cells.transformRecordsInto(recs, cnt, leaf, new Float64Array(cnt * 3));
      for (let i = 0; i < cnt; i++) b.expandByPoint(v.set(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]));
      n += cnt;
    }
    return n ? b : null;
  }
  /** A box measured the same way whichever entity it belongs to.
   *
   *  `bounds()` returns whatever that entity happens to hold: the loader's percentile box for
   *  one that has just been read, a resampled box for one that has been rotated. Comparing
   *  those two across entities is comparing two different measurements — which is how coarse
   *  alignment invented a 2% scale error between two copies of the same room, and a rigid ICP
   *  cannot undo a scale error, so it then stalled at 47 mm. */
  measuredBox(e: Entity): THREE.Box3 { return this.sampleBoxOf(e) ?? e.bounds(); }
  /** Measure the framing box again — after a gizmo drag, where it was only inflated. */
  retightenBounds() { const s = this.sampledBox(); if (s) { this.robust = s; this.applyZRange(); this.dirty = true; } }
  get model() { return this.cells.model; }
  /** Attach (or drop) the drag gizmo for the whole cloud. */
  setModelGizmo(on: boolean) {
    if (!on) {
      if (this.proxy) { if (this.tc.object === this.proxy) this.tc.detach(); this.overlay.remove(this.proxy); this.proxy = null; }
      this.modelGizmo = false; this.tc.enabled = false; this.dirty = true; return;
    }
    this.setActiveRegion(null);            // one gizmo at a time
    if (!this.proxy) { this.proxy = new THREE.Object3D(); this.overlay.add(this.proxy); }
    this.modelGizmo = true;
    this.recentreProxy();
    this.tc.attach(this.proxy); this.tc.enabled = true;
    this.tc.setMode(this.gizmoMode === 'scale' ? 'scale' : this.gizmoMode);
    this.dirty = true;
  }
  private recentreProxy() {
    if (!this.proxy) return;
    const b = this.bounds();
    this.proxy.position.copy(b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3()));
    this.proxy.quaternion.identity(); this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld(true);
  }
  /** One gizmo frame: the proxy's movement since the drag began, applied to the model. */
  private dragModel() {
    if (!this.proxy || !this.dragBase) return;
    this.proxy.updateMatrixWorld(true);
    const delta = this.proxy.matrixWorld.clone().multiply(this.dragFrom.clone().invert());
    const base = this.dragBase;
    this.setModel(delta.multiply(base), false);
    this.onModelDrag?.(false, base);
  }

  // ------------------------------------------------------------ regions
  /** A signature of the things that change a prism's geometry rather than its placement. */
  private static prismSig(r: Region) { return `${r.half[2].toFixed(5)}|${(r.poly ?? []).map(v => v[0].toFixed(4) + ',' + v[1].toFixed(4)).join(';')}`; }

  private buildRegionGroup(r: Region): THREE.Group {
    const g = new THREE.Group();
    const col = ROLE_COLOR[r.role] ?? TEAL;
    const fillMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: r.role === 'keep' ? 0.06 : 0.14, depthTest: false, depthWrite: false });
    if (r.kind === 'prism') {
      // the outline at both caps plus the edges between them: the shape has to be legible
      // from any angle, which is the whole reason a drawn selection became a region
      const poly = r.poly ?? [];
      const hz = Math.max(r.half[2], 1e-3);
      const pos: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        pos.push(a[0], a[1], -hz, b[0], b[1], -hz);
        pos.push(a[0], a[1], hz, b[0], b[1], hz);
        pos.push(a[0], a[1], -hz, a[0], a[1], hz);
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false })));
      if (poly.length >= 3) {
        const cap = new THREE.ShapeGeometry(new THREE.Shape(poly.map(v => new THREE.Vector2(v[0], v[1]))));
        const near = new THREE.Mesh(cap, fillMat), far = new THREE.Mesh(cap, fillMat);
        near.position.z = -hz; far.position.z = hz;
        g.add(near, far);
      }
      g.userData = { kind: r.kind, role: r.role, sig: Viewer.prismSig(r) };
      return g;
    }
    if (r.kind === 'sphere') {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 20), new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false })));
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 20), fillMat));
    } else {
      const h = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)), new THREE.Color(col));
      (h.material as THREE.LineBasicMaterial).depthTest = false; (h.material as THREE.LineBasicMaterial).transparent = true;
      g.add(h, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), fillMat));
    }
    g.userData = { kind: r.kind, role: r.role };
    return g;
  }
  private slabSpan(): number { const b = this.visibleBounds(); if (b.isEmpty()) return 200; const s = b.getSize(new THREE.Vector3()); return Math.max(s.x, s.y, s.z) * 3; }
  private applyRegionToGroup(r: Region, g: THREE.Group) {
    g.position.set(r.center[0], r.center[1], r.center[2]);
    g.quaternion.set(r.quat[0], r.quat[1], r.quat[2], r.quat[3]);
    // a prism's geometry is already in local metres, so it is never scaled
    if (r.kind === 'prism') g.scale.set(1, 1, 1);
    else if (r.kind === 'box') g.scale.set(r.half[0] * 2, r.half[1] * 2, r.half[2] * 2);
    else if (r.kind === 'sphere') g.scale.set(r.radius * 2, r.radius * 2, r.radius * 2);
    else { const s = this.slabSpan(); g.scale.set(s, s, r.half[2] * 2); }
  }

  setRegions(list: Region[]) {
    this.regions = list;
    const ids = new Set(list.map(r => r.id));
    for (const [id, g] of this.regionGroups) if (!ids.has(id)) { this.overlay.remove(g); this.regionGroups.delete(id); if (this.activeRegion === id) this.setActiveRegion(null); }
    for (const r of list) {
      let g = this.regionGroups.get(r.id);
      const stale = !!g && r.kind === 'prism' && g.userData.sig !== Viewer.prismSig(r);
      if (!g || stale || g.userData.kind !== r.kind || g.userData.role !== r.role) {
        if (g) { this.overlay.remove(g); if (this.tc.object === g) this.tc.detach(); }
        g = this.buildRegionGroup(r); this.overlay.add(g); this.regionGroups.set(r.id, g);
        if (this.activeRegion === r.id) this.tc.attach(g);
      }
      if (!this.gizmoBusy || this.activeRegion !== r.id) this.applyRegionToGroup(r, g);
      g.visible = this.regionOverlayVisible(r);
    }
    this.syncSuggestionLabels();
    this.dirty = true;
  }
  /** Pending tags/boxes outside a keep (crop) region stay in the list but are not shown. */
  private regionOverlayVisible(r: Region): boolean {
    if (r.role === 'keep' || r.role === 'delete') return true;
    const keeps = this.regions.filter(x => x.role === 'keep');
    if (!keeps.length) {
      const b = this.cells.bounds;
      if (b.isEmpty()) return true;
      const m = Math.max(1, b.getSize(new THREE.Vector3()).length() * 0.02);
      return r.center[0] >= b.min.x - m && r.center[0] <= b.max.x + m
        && r.center[1] >= b.min.y - m && r.center[1] <= b.max.y + m
        && r.center[2] >= b.min.z - m && r.center[2] <= b.max.z + m;
    }
    return keeps.some(k => pointInRegion(r.center, k));
  }

  setActiveRegion(id: string | null) {
    this.activeRegion = id;
    const g = id ? this.regionGroups.get(id) : undefined;
    if (g && this.modelGizmo) this.setModelGizmo(false);      // one gizmo at a time
    if (g) { this.tc.attach(g); this.tc.enabled = true; this.tc.setMode(this.gizmoMode); }
    else { if (this.tc.object) this.tc.detach(); this.tc.enabled = false; }
    this.dirty = true;
  }
  setGizmoMode(m: GizmoMode) { this.gizmoMode = m; this.tc.setMode(m); this.dirty = true; }
  get gizmoTarget(): 'none' | 'region' | 'cloud' { return this.modelGizmo ? 'cloud' : this.activeRegion ? 'region' : 'none'; }

  private syncActiveFromGroup() {
    const r = this.regions.find(x => x.id === this.activeRegion); const g = r && this.regionGroups.get(r.id);
    if (!r || !g) return;
    if (r.kind === 'prism') {
      // Resize scales the outline uniformly about its own centroid (the X handle) and sets
      // the depth (the Z handle); the geometry is then rebuilt and the group's scale reset.
      r.center = g.position.toArray() as [number, number, number];
      r.quat = [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w];
      const sx = Math.max(0.05, Math.abs(g.scale.x)), sz = Math.max(0.02, Math.abs(g.scale.z));
      if (r.poly && Math.abs(sx - 1) > 1e-6) r.poly = r.poly.map(v => [v[0] * sx, v[1] * sx] as [number, number]);
      const [hx, hy] = r.poly ? polyHalf(r.poly) : [r.half[0], r.half[1]];
      r.half = [hx, hy, Math.max(1e-3, r.half[2] * sz)];
      g.scale.set(1, 1, 1);
      this.dirty = true;
      this.onRegionChange?.(r);
      return;
    }
    const min = 0.3;
    g.scale.set(Math.max(min, Math.abs(g.scale.x)), Math.max(min, Math.abs(g.scale.y)), Math.max(min, Math.abs(g.scale.z)));
    r.center = g.position.toArray() as [number, number, number];
    r.quat = [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w];
    if (r.kind === 'sphere') { const u = Math.max(g.scale.x, g.scale.y, g.scale.z); g.scale.set(u, u, u); r.radius = u / 2; }
    else if (r.kind === 'box') r.half = [g.scale.x / 2, g.scale.y / 2, g.scale.z / 2];
    else { const s = this.slabSpan(); r.half = [s, s, g.scale.z / 2]; g.scale.set(s, s, g.scale.z); }
    this.dirty = true;
    this.onRegionChange?.(r);
  }

  /** Replace the reconstructed surface. Passing null drops it.
   *
   *  The mesher is fed the cloud's transform, so the vertices come back in the world the
   *  cloud was in when they were built. Remember that matrix: the surface is then drawn
   *  through `current × build⁻¹`, which is the identity right after a build and follows the
   *  points exactly when the cloud is moved afterwards. Without it a transform applied at
   *  build time would be applied twice. */
  setMesh(m: MeshData | null, builtWith?: THREE.Matrix4) {
    if (!m) { this.mesh.clear(); if (this.display !== 'points') this.setDisplay('points'); }
    else { this.mesh.upload(m); this.active.state.meshBase.copy(builtWith ?? this.cells.model); }
    this.syncMeshModel();
    this.dirty = true;
  }
  private syncMeshModel() { this.mesh.model.copy(this.cells.model).multiply(this.active.state.meshBase.clone().invert()); }
  setDisplay(d: Display) {
    this.display = this.mesh.hasMesh || d === 'points' ? d : 'points';
    this.mesh.visible = this.display !== 'points';
    this.dirty = true;
  }

  applyRegions(list: Region[], record = false) {
    const r = this.cells.applyRegions(list, record);
    const keeps = list.filter(x => x.role === 'keep');
    if (keeps.length) {
      const bb = new THREE.Box3();
      for (const k of keeps) {
        const c = new THREE.Vector3(...k.center);
        const reach = k.kind === 'sphere' ? k.radius : Math.hypot(k.half[0], k.half[1], k.half[2]);
        bb.expandByPoint(c.clone().addScalar(-reach)); bb.expandByPoint(c.clone().addScalar(reach));
      }
      if (this.robust) bb.intersect(this.robust);
      if (!bb.isEmpty()) this.robust = bb;
    }
    if (this.robust && !this.cells.bounds.isEmpty()) this.robust.intersect(this.cells.bounds);
    if (!this.robust || this.robust.isEmpty()) this.robust = this.cells.bounds.clone();
    this.applyZRange();
    this.dirty = true;
    return r;
  }
  /** After an undo/redo the cells changed underneath: put the robust box back and refresh derived state. */
  restoreBounds(robust: THREE.Box3 | null) {
    this.robust = robust && !robust.isEmpty() ? robust.clone() : this.cells.bounds.clone();
    if (!this.cells.bounds.isEmpty()) this.robust.intersect(this.cells.bounds);
    this.applyZRange(); this.dirty = true;
  }
  undoRegions(rec: UndoRecord, fetch: (i: number) => Promise<Uint8Array> | Uint8Array) {
    return this.cells.undoApply(rec, fetch);
  }
  redoRegions(rec: UndoRecord) {
    return this.cells.redoApply(rec);
  }

  private syncSuggestionLabels() {
    const want = new Set<string>();
    for (const r of this.regions) {
      if (!(r.role === 'pending' || r.role === 'delete') || !r.label) continue;
      if (!this.regionOverlayVisible(r)) continue;
      want.add(r.id);
      let el = this.slabels.get(r.id);
      if (!el) {
        el = document.createElement('div'); el.className = 'slabel';
        const txt = document.createElement('span'); txt.className = 'txt';
        const y = document.createElement('button'); y.className = 'y'; y.textContent = '✓'; y.title = 'Approve';
        const n = document.createElement('button'); n.className = 'n'; n.textContent = '✗'; n.title = 'Decline';
        y.onclick = (e) => { e.stopPropagation(); this.onSuggestionDecision?.(r.id, true); };
        n.onclick = (e) => { e.stopPropagation(); this.onSuggestionDecision?.(r.id, false); };
        el.append(txt, y, n); this.labelsEl.appendChild(el); this.slabels.set(r.id, el);
      }
      (el.querySelector('.txt') as HTMLElement).textContent = r.label;
      el.classList.toggle('acc', r.role === 'delete');
      (el.querySelector('.y') as HTMLElement).style.display = r.role === 'pending' ? '' : 'none';
    }
    for (const [id, el] of this.slabels) if (!want.has(id)) { el.remove(); this.slabels.delete(id); }
  }

  /** Turn a polygon traced on screen into a prism region: the outline extruded along the view
   *  direction of the camera that drew it.
   *
   *  The outline is converted from pixels to metres **at the orbit target's depth**, so what
   *  was drawn around the points at the centre of the view lands exactly on them. The region's
   *  frame is the camera's own rotation, so local X and Y are the screen's right and up and
   *  local Z is the view axis; depth is symmetric about the centre, so which way Z points does
   *  not matter. The default depth spans the whole cloud, because a drawn outline means "these
   *  things, at whatever range" until the user says otherwise. */
  prismFromScreen(poly: [number, number][], w: number, h: number, id: string, depthHalf?: number): Region {
    if (poly.length < 3) throw new Error('a prism needs at least three points');
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
    const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
    const depth = Math.max(0.05, this.controls.target.clone().sub(this.camera.position).dot(fwd));
    const tanV = Math.tan((this.camera.fov * Math.PI / 180) / 2);
    const halfH = depth * tanV, halfW = halfH * (w / h);
    // pixels -> metres on the plane through the orbit target
    const local = poly.map(([px, py]) => [((px / w) * 2 - 1) * halfW, (1 - (py / h) * 2) * halfH] as [number, number]);
    let cx = 0, cy = 0;
    for (const [x, y] of local) { cx += x; cy += y; }
    cx /= local.length; cy /= local.length;
    let ring = local.map(([x, y]) => [x - cx, y - cy] as [number, number]);
    // one uniform decides how many vertices the shader can hold, so simplify until it fits
    let tol = Math.max(halfW, halfH) * 0.004;
    for (let i = 0; i < 24 && ring.length > PRISM_MAX_V; i++) { ring = simplifyRing(ring, tol) as [number, number][]; tol *= 1.6; }
    if (ring.length > PRISM_MAX_V) ring = ring.slice(0, PRISM_MAX_V);
    const centre = this.camera.position.clone().addScaledVector(fwd, depth).addScaledVector(right, cx).addScaledVector(up, cy);
    let hz = depthHalf ?? 0;
    if (!(hz > 0)) {
      const bb = this.bounds();
      hz = 1;
      if (!bb.isEmpty()) {
        const v = new THREE.Vector3();
        let reach = 0;
        for (let i = 0; i < 8; i++) {
          v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).sub(centre);
          reach = Math.max(reach, Math.abs(v.dot(fwd)));
        }
        hz = reach * 1.05 + 0.05;
      }
    }
    const [hx, hy] = polyHalf(ring);
    const q = this.camera.quaternion;
    return {
      id, kind: 'prism', role: 'keep',
      center: centre.toArray() as [number, number, number],
      half: [hx, hy, hz], radius: Math.hypot(hx, hy),
      quat: [q.x, q.y, q.z, q.w], poly: ring,
      label: 'Drawn region',
    };
  }

  // ------------------------------------------------------------ picking
  pickWorld(cx: number, cy: number): THREE.Vector3 | null {
    if (!this.rt) return null;
    const dpr = this.renderer.getPixelRatio();
    const x = Math.floor(cx * dpr), y = Math.floor((this.ch - cy) * dpr);
    if (x < 0 || y < 0 || x >= this.rt.width || y >= this.rt.height) return null;
    let logD: number;
    if (this.rtType === THREE.FloatType) { const buf = new Float32Array(4); this.renderer.readRenderTargetPixels(this.rt, x, y, 1, 1, buf); logD = buf[3]; }
    else if (this.rtType === THREE.HalfFloatType) { const buf = new Uint16Array(4); this.renderer.readRenderTargetPixels(this.rt, x, y, 1, 1, buf); logD = halfToFloat(buf[3]); }
    else return null;
    if (!(logD > 0)) return null;
    const viewZ = -Math.pow(2, logD);
    const ndcX = (x / this.rt.width) * 2 - 1, ndcY = (y / this.rt.height) * 2 - 1;
    this.camera.updateMatrixWorld();
    // Orthographic: the ray through a pixel is parallel to the view axis, so the depth only
    // says how far along it the point sits. Perspective: the ray spreads with depth.
    if (this.ortho) {
      return new THREE.Vector3(ndcX * this.ortho.halfW, ndcY * this.ortho.halfH, viewZ).applyMatrix4(this.camera.matrixWorld);
    }
    const P = this.camera.projectionMatrix.elements;
    return new THREE.Vector3(ndcX / P[0] * -viewZ, ndcY / P[5] * -viewZ, viewZ).applyMatrix4(this.camera.matrixWorld);
  }
  pickTarget(cx: number, cy: number) {
    const world = this.pickWorld(cx, cy); if (!world || this.bubble) return;
    if (this.fly.enabled) { const dir = world.clone().sub(this.camera.position); this.camera.position.addScaledVector(dir, 0.8); }
    else { this.controls.target.copy(world); this.controls.update(); }
    this.touch();
  }
  private handleClick(cx: number, cy: number) {
    if (this.tool === 'none' && this.stationSprites.length && this.stationGroup.visible && !this.bubble) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2((cx / this.cw) * 2 - 1, -(cy / this.ch) * 2 + 1), this.camera);
      const hit = rc.intersectObjects(this.stationSprites, false)[0];
      if (hit) { const i = this.stationSprites.indexOf(hit.object as THREE.Sprite); if (i >= 0) { clearTimeout(this.stationTimer); this.stationTimer = window.setTimeout(() => this.onStationClick?.(i), 280); return; } }
    }
    const world = this.pickWorld(cx, cy);
    if (this.tool === 'measure' && world) this.addMeasurePoint(world);
    this.onClick?.(world, cx, cy);
  }

  // ------------------------------------------------------------ measure
  private sprite(tex: THREE.Texture, scale = 0.018): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
    s.scale.set(scale, scale, 1); return s;
  }
  addMeasurePoint(p: THREE.Vector3) {
    if (!this.pending) { this.pending = p.clone(); this.pendingMark = this.sprite(this.dotTex); this.pendingMark.position.copy(p); this.overlay.add(this.pendingMark); this.dirty = true; return; }
    const a = this.pending, b = p.clone(); this.pending = null;
    if (this.pendingMark) { this.overlay.remove(this.pendingMark); this.pendingMark = null; }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: TEAL, depthTest: false, transparent: true }));
    const ma = this.sprite(this.dotTex), mb = this.sprite(this.dotTex); ma.position.copy(a); mb.position.copy(b); line.add(ma, mb);
    this.overlay.add(line);
    const label = document.createElement('div'); label.className = 'mlabel';
    const dist = a.distanceTo(b); label.textContent = `${dist.toFixed(dist < 10 ? 3 : 2)} m`;
    this.labelsEl.appendChild(label);
    this.measures.push({ a, b, line, label, dist });
    this.dirty = true;
  }
  measureBetween(a: THREE.Vector3, b: THREE.Vector3) { this.pending = null; if (this.pendingMark) { this.overlay.remove(this.pendingMark); this.pendingMark = null; } this.addMeasurePoint(a); this.addMeasurePoint(b); return a.distanceTo(b); }
  clearMeasures() { for (const m of this.measures) { this.overlay.remove(m.line); m.label.remove(); } this.measures = []; this.pending = null; if (this.pendingMark) { this.overlay.remove(this.pendingMark); this.pendingMark = null; } this.dirty = true; }
  get measureList() { return this.measures.map(m => ({ a: m.a, b: m.b, dist: m.dist })); }
  setTool(t: Tool) {
    this.tool = t;
    // a lasso needs the pointer for drawing, so orbiting stands down while it is armed
    // Placement keeps the orbit alive: you look around for the thing you want, then click it.
    this.controls.enabled = t !== 'segment' && !this.fly.enabled && !this.bubble;
    if (t !== 'measure') { this.pending = null; if (this.pendingMark) { this.overlay.remove(this.pendingMark); this.pendingMark = null; } } this.dirty = true; }

  // ------------------------------------------------------------ stations / bubbles
  private stationLocal: THREE.Vector3[] = [];
  setStations(list: Station[], translation: [number, number, number] = [0, 0, 0]) {
    for (const s of this.stationSprites) this.stationGroup.remove(s);
    this.stationSprites = []; this.stations = list; this.stationLocal = [];
    for (const st of list) {
      const s = this.sprite(this.stationTex, 0.028);
      this.stationLocal.push(new THREE.Vector3(st.t[0] - translation[0], st.t[1] - translation[1], st.t[2] - translation[2]));
      this.stationGroup.add(s); this.stationSprites.push(s);
    }
    this.refreshStations();
  }
  /** Put the markers where the transformed cloud puts them. A station is part of the scan,
   *  so it moves with it — and the analyser needs them in the same frame as the points. */
  private refreshStations() {
    for (let i = 0; i < this.stationSprites.length; i++) {
      this.stationSprites[i].position.copy(this.stationLocal[i]).applyMatrix4(this.cells.model);
    }
    if (this.bubble) this.bubble.pos.copy(this.stationSprites[this.bubble.index]?.position ?? this.bubble.pos);
    this.dirty = true;
  }
  stationPositions() { return this.stationSprites.map(s => s.position.toArray()); }
  setStationsVisible(v: boolean) { this.stationGroup.visible = v; this.dirty = true; }
  enterBubble(index: number, bitmap: ImageBitmap) {
    this.exitBubble();
    const st = this.stations[index]; const sp = this.stationSprites[index]; if (!st || !sp) return;
    const tex = new THREE.Texture(bitmap as any); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const q = new THREE.Quaternion(st.q[1], st.q[2], st.q[3], st.q[0]);
    const inv = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q.clone().invert()));
    const mat = new THREE.ShaderMaterial({ vertexShader: PANO_VS, fragmentShader: PANO_FS, uniforms: { uTex: { value: tex }, uInvRot: { value: inv }, uFlipU: { value: 0 }, uOffU: { value: 0 }, uOpacity: { value: 1 } }, side: THREE.BackSide, depthTest: false, depthWrite: false, transparent: true });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 40), mat); mesh.position.copy(sp.position);
    this.panoScene.add(mesh);
    this.bubble = { index, pos: sp.position.clone(), mesh, mat };
    this.setFly(false);
    const f = new THREE.Vector3(); this.camera.getWorldDirection(f);
    this.camera.position.copy(sp.position); this.controls.target.copy(sp.position).addScaledVector(f, 0.02);
    this.controls.minDistance = 0.02; this.controls.zoomToCursor = false; this.controls.update();
    this.edlMat.uniforms.uPointAlpha.value = this.pointAlpha;
    this.touch();
  }
  exitBubble() {
    if (!this.bubble) return;
    this.panoScene.remove(this.bubble.mesh); (this.bubble.mat.uniforms.uTex.value as THREE.Texture).dispose(); this.bubble = null;
    this.edlMat.uniforms.uPointAlpha.value = 1; this.controls.minDistance = 0.05; this.controls.zoomToCursor = true;
    const f = new THREE.Vector3(); this.camera.getWorldDirection(f); this.controls.target.copy(this.camera.position).addScaledVector(f, 3); this.controls.update();
    this.onBubbleExit?.(); this.touch();
  }
  setPointAlpha(a: number) { this.pointAlpha = a; if (this.bubble) { this.edlMat.uniforms.uPointAlpha.value = a; this.dirty = true; } }

  // ------------------------------------------------------------ navigation
  setFly(on: boolean) {
    if (on === this.fly.enabled) return;
    if (on) { if (this.bubble) this.exitBubble(); this.controls.enabled = false; this.fly.enter(); }
    else { this.fly.exit(); const f = new THREE.Vector3(); this.camera.getWorldDirection(f); this.controls.target.copy(this.camera.position).addScaledVector(f, 3); this.controls.enabled = true; this.controls.update(); }
    this.touch();
  }
  private viewDir(bb: THREE.Box3): THREE.Vector3 {
    const s = bb.getSize(new THREE.Vector3());
    const portrait = this.ch > this.cw;
    const L = s.y >= s.x ? new THREE.Vector2(0, 1) : new THREE.Vector2(1, 0);
    const rt = portrait ? new THREE.Vector2(-L.y, L.x) : L.clone();
    return new THREE.Vector3(rt.y, -rt.x, portrait ? 0.62 : 0.52).normalize();
  }
  fit(quiet = false) {
    const bb = this.visibleBounds(); if (bb.isEmpty()) return;
    if (!quiet) { this.exitBubble(); this.setFly(false); }
    this.camera.up.set(0, 0, 1);
    const c = bb.getCenter(new THREE.Vector3()); const dir = this.viewDir(bb);
    const { right: occR, bottom: occB } = quiet ? { right: 0, bottom: 0 } : occlusion();
    const fracW = Math.max(this.cw - occR, 200) / this.cw, fracH = Math.max(this.ch - occB, 200) / this.ch;
    const fwd = dir.clone().negate(); const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize(); const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const halfV = (this.camera.fov * Math.PI / 180) / 2, tanV = Math.tan(halfV), tanVe = tanV * fracH, tanH = tanV * (this.cw / this.ch) * fracW;
    let dist = 0; const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) { v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).sub(c); const a = v.dot(right), b = v.dot(up), d = v.dot(fwd); dist = Math.max(dist, Math.abs(a) / tanH - d, Math.abs(b) / tanVe - d); }
    dist *= 1.06; if (!isFinite(dist) || dist <= 0) dist = bb.getBoundingSphere(new THREE.Sphere()).radius * 2;
    this.controls.target.copy(c); this.camera.position.copy(c).addScaledVector(dir, dist);
    const worldPerPx = (2 * dist * tanV) / this.ch;
    if (occR) { const s = (occR / 2) * worldPerPx; this.controls.target.addScaledVector(right, s); this.camera.position.addScaledVector(right, s); }
    if (occB) { const s = (occB / 2) * worldPerPx; this.controls.target.addScaledVector(up, -s); this.camera.position.addScaledVector(up, -s); }
    this.controls.update(); this.touch();
  }
  topDown() {
    const bb = this.visibleBounds(); if (bb.isEmpty()) return;
    this.exitBubble(); this.setFly(false);
    const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
    const { right: occR, bottom: occB } = occlusion();
    const usableW = Math.max(this.cw - occR, 200), usableH = Math.max(this.ch - occB, 200);
    const halfV = (this.camera.fov * Math.PI / 180) / 2;
    const halfVe = Math.atan(Math.tan(halfV) * (usableH / this.ch)), halfH = Math.atan(Math.tan(halfV) * (usableW / this.ch));
    const r = 0.5 * Math.hypot(s.x, s.y); const dist = (r / Math.sin(Math.min(halfVe, halfH))) * 0.95;
    const portrait = this.ch > this.cw, longY = s.y >= s.x;
    if (portrait === longY) this.camera.up.set(0, 1, 0); else this.camera.up.set(1, 0, 0);
    this.controls.target.copy(c); this.camera.position.set(c.x, c.y, c.z + dist); this.controls.update(); this.touch();
  }
  setOrbit(azDeg: number, elDeg: number, distance?: number) {
    this.exitBubble(); this.setFly(false); this.camera.up.set(0, 0, 1);
    const t = this.controls.target; const d = distance ?? this.camera.position.distanceTo(t);
    const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
    this.camera.position.set(t.x + d * Math.cos(el) * Math.cos(az), t.y + d * Math.cos(el) * Math.sin(az), t.z + d * Math.sin(el));
    this.controls.update(); this.touch();
  }
  getView() { return { p: this.camera.position.toArray(), t: this.controls.target.toArray(), fly: this.fly.enabled }; }
  setView(v: { p: number[]; t: number[] }) { this.setFly(false); this.exitBubble(); this.camera.position.fromArray(v.p); this.controls.target.fromArray(v.t); this.controls.update(); this.touch(); }

  /** Per-leaf keep mask for a screen-space polygon. `inside` picks which side survives.
   *
   *  Folds each leaf's quantisation into the view-projection matrix, so a point costs three
   *  multiply-adds rather than a full matrix product, and skips a leaf outright when its
   *  projected box misses the polygon.
   */
  polygonMask(poly: [number, number][], inside: boolean, w: number, h: number): Uint8Array[] {
    // view-projection times the cloud's model: the lasso tests the points where they are
    // drawn, and the per-leaf folding below still costs three multiply-adds per point
    const vp = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.cells.model);
    const e = vp.elements;
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (const [x, y] of poly) { px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y); }
    const hit = (x: number, y: number) => {
      if (x < px0 || x > px1 || y < py0 || y > py1) return false;
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const out: Uint8Array[] = [];
    const corner = new THREE.Vector3();
    for (const l of this.cells.leavesForMask()) {
      const m = new Uint8Array(l.count);
      // cheap rejection: does this leaf's box project anywhere near the polygon?
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, anyFront = false;
      for (let c = 0; c < 8; c++) {
        corner.set(c & 1 ? l.bmax.x : l.bmin.x, c & 2 ? l.bmax.y : l.bmin.y, c & 4 ? l.bmax.z : l.bmin.z);
        const cw = e[3] * corner.x + e[7] * corner.y + e[11] * corner.z + e[15];
        if (cw <= 0) continue;
        anyFront = true;
        const cx = (e[0] * corner.x + e[4] * corner.y + e[8] * corner.z + e[12]) / cw;
        const cy = (e[1] * corner.x + e[5] * corner.y + e[9] * corner.z + e[13]) / cw;
        const sx = (cx + 1) * 0.5 * w, sy = (1 - cy) * 0.5 * h;
        bx0 = Math.min(bx0, sx); by0 = Math.min(by0, sy); bx1 = Math.max(bx1, sx); by1 = Math.max(by1, sy);
      }
      if (!anyFront || bx1 < px0 || bx0 > px1 || by1 < py0 || by0 > py1) {
        m.fill(inside ? 0 : 1); out.push(m); continue;
      }
      const recs = l.readback(this.cells.gl2);
      const u16 = new Uint16Array(recs.buffer, recs.byteOffset, (l.count * REC) >> 1);
      const k = l.size / 65536, o = l.origin;
      const b0 = e[0] * o.x + e[4] * o.y + e[8] * o.z + e[12];
      const b1 = e[1] * o.x + e[5] * o.y + e[9] * o.z + e[13];
      const b3 = e[3] * o.x + e[7] * o.y + e[11] * o.z + e[15];
      const ax0 = e[0] * k, ay0 = e[4] * k, az0 = e[8] * k;
      const ax1 = e[1] * k, ay1 = e[5] * k, az1 = e[9] * k;
      const ax3 = e[3] * k, ay3 = e[7] * k, az3 = e[11] * k;
      for (let i = 0; i < l.count; i++) {
        const q = i * 7, qx = u16[q], qy = u16[q + 1], qz = u16[q + 2];
        const cw = b3 + qx * ax3 + qy * ay3 + qz * az3;
        if (cw <= 0) { m[i] = inside ? 0 : 1; continue; }
        const sx = ((b0 + qx * ax0 + qy * ay0 + qz * az0) / cw + 1) * 0.5 * w;
        const sy = (1 - (b1 + qx * ax1 + qy * ay1 + qz * az1) / cw) * 0.5 * h;
        m[i] = (hit(sx, sy) === inside) ? 1 : 0;
      }
      out.push(m);
    }
    return out;
  }

  // ------------------------------------------------------------ snapshots
  snapshot(maxWidth = 1280, type: 'png' | 'jpeg' = 'png'): string {
    this.dirty = true; this.render();
    const w = this.canvas.width, h = this.canvas.height;
    const sc = Math.min(1, maxWidth / w);
    const mime = type === 'jpeg' ? 'image/jpeg' : 'image/png';
    const q = type === 'jpeg' ? 0.72 : undefined;
    if (sc >= 1) return this.canvas.toDataURL(mime, q);
    const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    c.getContext('2d')!.drawImage(this.canvas, 0, 0, c.width, c.height);
    return c.toDataURL(mime, q);
  }
  /** Run `fn` with overlays hidden and a denser, brighter point pass — what an agent should
   *  look at: no station markers, no gizmo, no labels, and the full point budget. */
  cleanRender<T>(fn: () => T): T {
    const k = this.knobs; const saved = { ...k };
    const ov = this.overlay.visible, lb = this.labelsEl.style.display, pa = this.panoScene.visible, pAlpha = this.edlMat.uniforms.uPointAlpha.value;
    this.overlay.visible = false; this.labelsEl.style.display = 'none'; this.panoScene.visible = false; this.edlMat.uniforms.uPointAlpha.value = 1;
    // The colour mode is deliberately left alone: a scalar field is often the thing worth
    // photographing, and forcing RGB threw that away.
    Object.assign(k, { budget: Math.max(k.budget, 24_000_000), density: Math.max(k.density, 3), size: Math.max(k.size, 2.5), maxPx: Math.max(k.maxPx, 9), bright: Math.min(Math.max(k.bright, 1.0), 1.1), edlStrength: Math.min(k.edlStrength, 0.25), clipZMin: -1e9, clipZMax: 1e9 });
    this.moving = false;
    try { return fn(); }
    finally { Object.assign(k, saved); this.overlay.visible = ov; this.labelsEl.style.display = lb; this.panoScene.visible = pa; this.edlMat.uniforms.uPointAlpha.value = pAlpha; this.dirty = true; }
  }
  private saveCam() { return { p: this.camera.position.clone(), q: this.camera.quaternion.clone(), up: this.camera.up.clone(), fov: this.camera.fov, near: this.camera.near, far: this.camera.far, t: this.controls.target.clone(), w: this.cw, h: this.ch }; }
  private restoreCam(s: ReturnType<Viewer['saveCam']>) {
    if (this.cw !== s.w || this.ch !== s.h) this.resizeTo(s.w, s.h);
    this.camera.position.copy(s.p); this.camera.quaternion.copy(s.q); this.camera.up.copy(s.up); this.camera.fov = s.fov; this.camera.near = s.near; this.camera.far = s.far;
    this.camera.updateProjectionMatrix(); this.controls.target.copy(s.t); this.controls.update(); this.dirty = true;
  }
  /** Near-orthographic top-down render covering the bounds exactly, with the metres-to-pixels mapping. */
  renderTopDown(bb: THREE.Box3, px = 1024) {
    const s = this.saveCam(); const wasFly = this.fly.enabled; if (wasFly) this.fly.exit();
    const size = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
    const ex = Math.max(size.x, 1), ey = Math.max(size.y, 1);
    const w = ex >= ey ? px : Math.round(px * ex / ey), h = ex >= ey ? Math.round(px * ey / ex) : px;
    this.resizeTo(w, h);
    const fov = 10, tanH = Math.tan(fov / 2 * Math.PI / 180);
    const H = Math.max(ex / (w / h), ey) / (2 * tanH);
    this.camera.fov = fov; this.camera.up.set(0, 1, 0);
    this.controls.target.copy(c);               // controls.update() re-aims at it during render
    this.camera.position.set(c.x, c.y, c.z + H); this.camera.lookAt(c);
    this.camera.near = Math.max(0.1, H - size.z); this.camera.far = H + size.z + 10; this.camera.updateProjectionMatrix();
    const dataUrl = this.cleanRender(() => this.snapshot(px));
    this.restoreCam(s); if (wasFly) this.fly.enter();
    return { dataUrl, originX: c.x - ex / 2, originY: c.y - ey / 2, extentX: ex, extentY: ey, width: w, height: h };
  }
  /** Clean snapshot looking at `target` from (dist, az, el); also returns where `marks` land on the image. */
  snapshotAt(target: THREE.Vector3, dist: number, az: number, el: number, w: number, h: number, marks: THREE.Vector3[] = []): { dataUrl: string; marks2d: [number, number][] } {
    const s = this.saveCam(); const wasFly = this.fly.enabled; if (wasFly) this.fly.exit();
    this.resizeTo(w, h);
    this.camera.fov = 40; this.camera.up.set(0, 0, 1);
    this.controls.target.copy(target);
    this.camera.position.set(target.x + dist * Math.cos(el) * Math.cos(az), target.y + dist * Math.cos(el) * Math.sin(az), target.z + dist * Math.sin(el));
    this.camera.lookAt(target); this.camera.near = Math.max(0.05, dist * 0.02); this.camera.far = dist * 30 + 200; this.camera.updateProjectionMatrix();
    this.controls.update();
    const dataUrl = this.cleanRender(() => this.snapshot(w));
    const marks2d = marks.map(m => { const v = m.clone().project(this.camera); return [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h] as [number, number]; });
    this.restoreCam(s); if (wasFly) this.fly.enter();
    return { dataUrl, marks2d };
  }
  snapshotFromFit(px = 1024): string {
    const s = this.saveCam(); const wasFly = this.fly.enabled; if (wasFly) this.fly.exit();
    this.resizeTo(px, Math.round(px * 0.66));
    this.fit(true);
    const d = this.cleanRender(() => this.snapshot(px));
    this.restoreCam(s); if (wasFly) this.fly.enter();
    return d;
  }

  // ------------------------------------------------------- calibrated views for an agent
  /** Everything needed to turn a pixel of the last frame back into a ray. */
  cameraRecord(): CameraRecord {
    const c = this.camera;
    const dpr = this.renderer.getPixelRatio();
    const dist = c.position.distanceTo(this.controls.target);
    const vp = new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    const e = vp.elements;
    const mpp = this.ortho
      ? (2 * this.ortho.halfH) / (this.ch * dpr)
      : (2 * dist * Math.tan((c.fov * Math.PI / 180) / 2)) / (this.ch * dpr);
    return {
      projection: this.ortho ? 'orthographic' : 'perspective',
      position: c.position.toArray(), target: this.controls.target.toArray(), up: c.up.toArray(),
      fovDeg: this.ortho ? null : c.fov, aspect: c.aspect,
      width: Math.round(this.cw * dpr), height: Math.round(this.ch * dpr), devicePixelRatio: dpr,
      near: c.near, far: c.far, distanceToTarget: dist,
      metresPerPixel: mpp,
      metresPerPixelNote: this.ortho
        ? 'exact everywhere: the projection is orthographic'
        : 'at the orbit target only; a perspective pixel covers more ground further away',
      // row-major, so a caller can project a world point itself: ndc = VP * [x,y,z,1]
      viewProjection: [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]],
    };
  }

  /** Run `fn` with an orthographic camera looking along `forward` and framing `bb`, then put
   *  the camera back. The projection is genuinely orthographic — a swapped projection matrix
   *  on the same camera object, so the controls, the shaders and the picker are untouched —
   *  which is what makes one metre the same number of pixels everywhere in the image. */
  withOrtho<T>(o: { forward: THREE.Vector3; upHint?: THREE.Vector3; bb: THREE.Box3; px?: number; pad?: number },
               fn: (m: OrthoMap) => T): T {
    const saved = this.saveCam(); const wasFly = this.fly.enabled; if (wasFly) this.fly.exit();
    const savedDpr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);                 // one image pixel is one render pixel
    try {
      const f = o.forward.clone().normalize();
      const hint = (o.upHint ?? (Math.abs(f.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1))).clone().normalize();
      const back = f.clone().negate();
      const right = new THREE.Vector3().crossVectors(hint, back).normalize();
      const up = new THREE.Vector3().crossVectors(back, right).normalize();
      const bb = o.bb, c = bb.getCenter(new THREE.Vector3());
      let ex = 1e-3, ey = 1e-3, ez = 1e-3;
      const v = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).sub(c);
        ex = Math.max(ex, Math.abs(v.dot(right))); ey = Math.max(ey, Math.abs(v.dot(up))); ez = Math.max(ez, Math.abs(v.dot(back)));
      }
      const pad = o.pad ?? 1.02;
      ex *= pad; ey *= pad;
      const px = Math.max(64, Math.min(2048, Math.round(o.px ?? 1024)));
      const w = ex >= ey ? px : Math.max(64, Math.round(px * ex / ey));
      const h = ex >= ey ? Math.max(64, Math.round(px * ey / ex)) : px;
      this.resizeTo(w, h);
      // square pixels: whichever half extent is short for the image aspect is stretched
      const halfH = Math.max(ey, ex * h / w), halfW = halfH * w / h;
      const dist = ez + 1;
      this.camera.up.copy(up);
      // The orbit target has to move as well. render() calls controls.update(), which ends in
      // lookAt(target) — so with a stale target the camera is quietly swung off axis and the
      // mapping this function returns describes a frame that was never rendered.
      this.controls.target.copy(c);
      this.camera.position.copy(c).addScaledVector(back, dist);
      this.camera.lookAt(c);
      this.camera.near = 0.01; this.camera.far = dist + ez + 10;
      this.camera.updateMatrixWorld();
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      this.camera.projectionMatrix.makeOrthographic(-halfW, halfW, halfH, -halfH, this.camera.near, this.camera.far);
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      this.ortho = { halfW, halfH };
      const mpp = (2 * halfW) / w;
      // world position of the centre of pixel (0,0), and the world step per pixel
      const topLeft = c.clone()
        .addScaledVector(right, -halfW + mpp / 2)
        .addScaledVector(up, halfH - mpp / 2);
      const axisName = (a: THREE.Vector3) => {
        const n: [string, number][] = [['x', a.x], ['y', a.y], ['z', a.z]];
        n.sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]));
        return Math.abs(n[0][1]) > 0.999 ? `${n[0][1] > 0 ? '+' : '-'}${n[0][0]}` : null;
      };
      const axes = [axisName(right), axisName(up), axisName(f)];
      const map: OrthoMap = {
        width: w, height: h, metresPerPixel: mpp,
        topLeft: topLeft.toArray(),
        perPixelRight: right.clone().multiplyScalar(mpp).toArray(),
        perPixelDown: up.clone().multiplyScalar(-mpp).toArray(),
        rightAxis: axes[0], upAxis: axes[1], viewAxis: axes[2],
        // the friendly form, only meaningful when the view is axis aligned
        originX: axes[0] ? topLeft.dot(right) - mpp / 2 : null,
        originY: axes[1] ? topLeft.dot(up) - (h - 0.5) * mpp : null,
        extentX: 2 * halfW, extentY: 2 * halfH,
        centre: c.toArray(), depthRange: [c.dot(f) - ez, c.dot(f) + ez],
        note: 'world = topLeft + x * perPixelRight + y * perPixelDown, for the centre of pixel (x, y). When rightAxis and upAxis are set the same thing reads: world[rightAxis] = originX + (x + 0.5) * metresPerPixel, world[upAxis] = originY + (height - 0.5 - y) * metresPerPixel.',
      };
      return fn(map);
    } finally {
      this.ortho = null;
      this.renderer.setPixelRatio(savedDpr);
      this.restoreCam(saved);
      if (wasFly) this.fly.enter();
    }
  }

  /** One clean frame into the render target, ready to be read back or picked from. */
  renderClean() { this.cleanRender(() => { this.dirty = true; this.render(); }); }

  benchmark(frames = 30): number {
    const gl = this.renderer.getContext(); this.moving = false;
    const px = new Uint8Array(4);
    const sync = () => { this.renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    this.dirty = true; this.render(); sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { this.dirty = true; this.render(); sync(); }
    return (performance.now() - t0) / frames;
  }

  // ---------------------------------------------------------------- frame
  render(): boolean {
    const now = performance.now();
    const dt = Math.min((now - this.lastT) / 1000, 0.1); this.lastT = now;
    if (this.fly.update(dt)) this.touch();
    if (this.controls.enabled) this.controls.update();
    for (const e of this.entities) if (e.cells.pendingCount && e.cells.flushUploads()) this.dirty = true;
    if (this.bubble) {
      const d = this.camera.position.distanceTo(this.bubble.pos);
      const op = 1 - Math.min(1, Math.max(0, (d - 0.3) / 2.0));
      if (d > 2.5) this.exitBubble();
      else if (Math.abs(this.bubble.mat.uniforms.uOpacity.value - op) > 0.01) { this.bubble.mat.uniforms.uOpacity.value = op; this.dirty = true; }
    }
    if (!this.dirty) return false;
    this.dirty = false;
    const k = this.knobs;
    const t0 = performance.now();
    const budget = this.moving ? Math.max(200_000, k.budget * k.movingQuality) : k.budget;

    this.renderer.setRenderTarget(this.rt);
    this.renderer.setClearColor(BG, 0); this.renderer.clear(true, true, false);
    this.renderer.render(this.emptyScene, this.camera);
    this.camera.updateMatrixWorld(); this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    // Surface first, points on top: both write depth into the same target, so the closer
    // one wins per pixel and the eye-dome pass shades whatever ends up visible.
    const k2 = this.knobs;
    this.meshTris = this.display === 'points' ? 0 : this.mesh.draw(this.camera, {
      colorMode: k2.colorMode, zMin: this.zRange[0], zMax: this.zRange[1],
      clipZMin: k2.clipZMin, clipZMax: k2.clipZMax, bright: k2.bright, gamma: k2.gamma,
      flat: this.meshFlat, shade: this.meshShade,
      clipMin: this.meshClip?.min, clipMax: this.meshClip?.max,
    });
    if (this.display === 'mesh') {
      this.stats = { leavesVisible: 0, leavesDrawn: 0, pointsDrawn: 0, pointsTotal: this.cells.total };
    } else {
      // Every visible entity into the same target. They write the same (colour, log depth)
      // pair, so depth composites them correctly and the eye-dome pass shades whatever ended
      // up in front — no per-entity pass, no sorting. The frame budget is shared out by point
      // count, so adding a second cloud thins both rather than starving one.
      const vis = this.visibleEntities;
      const all = Math.max(1, vis.reduce((n, e) => n + e.cells.total, 0));
      const params = {
        budget, density: k.density, ptSize: k.size, sizeMode: k.sizeMode, minPx: 1, maxPx: k.maxPx,
        colorMode: k.colorMode, zMin: this.zRange[0], zMax: this.zRange[1], iMin: k.iMin, iMax: k.iMax,
        clipZMin: k.clipZMin, clipZMax: k.clipZMax, round: k.round, normalShade: k.normalShade, bright: k.bright, gamma: k.gamma,
        screenH: this.rt.height, fovDeg: this.camera.fov, regions: this.regions.filter(r => this.regionOverlayVisible(r)), regionHide: this.regionHide,
        sfMin: this.sf.min, sfMax: this.sf.max, sfLo: this.sf.lo, sfHi: this.sf.hi, sfHide: this.sf.hide,
        orthoMpp: this.ortho ? (2 * this.ortho.halfH) / Math.max(1, this.rt.height) : 0,
      };
      this.stats = { leavesVisible: 0, leavesDrawn: 0, pointsDrawn: 0, pointsTotal: 0 };
      for (const e of vis) {
        const s = e.cells.draw(this.camera, { ...params, budget: Math.max(50_000, Math.round(budget * e.cells.total / all)), tint: e.tintRgb() });
        this.stats.leavesVisible += s.leavesVisible; this.stats.leavesDrawn += s.leavesDrawn;
        this.stats.pointsDrawn += s.pointsDrawn; this.stats.pointsTotal += s.pointsTotal;
      }
      if (!vis.length) this.stats.pointsTotal = this.cells.total;
    }
    this.renderer.resetState();

    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(BG, 1); this.renderer.clear(true, true, false);
    if (this.bubble) this.renderer.render(this.panoScene, this.camera);
    this.edlMat.uniforms.uTex.value = this.rt.texture;
    this.renderer.render(this.quadScene, this.quadCam);
    this.renderer.render(this.overlay, this.camera);
    this.placeLabels();

    this.frameMs = performance.now() - t0;
    this.frames++;
    if (now - this.lastFps > 500) { this.fps = (this.frames * 1000) / (now - this.lastFps); this.frames = 0; this.lastFps = now; }
    if (this.moving) this.dirty = true;
    this.onStats?.();
    return true;
  }

  private placeLabels() {
    const v = new THREE.Vector3();
    const place = (el: HTMLElement, p: THREE.Vector3) => {
      v.copy(p).project(this.camera);
      const behind = v.z > 1 || v.z < -1;
      el.style.display = behind ? 'none' : '';
      if (!behind) { el.style.left = ((v.x + 1) / 2 * this.cw) + 'px'; el.style.top = ((1 - v.y) / 2 * this.ch) + 'px'; }
    };
    for (const m of this.measures) place(m.label, m.a.clone().add(m.b).multiplyScalar(0.5));
    for (const [id, el] of this.slabels) { const r = this.regions.find(x => x.id === id); if (r) place(el, new THREE.Vector3(...r.center)); }
  }
}
