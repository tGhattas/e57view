import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EDL_FS, QUAD_VS } from './shaders';
import { CellRenderer, pointInRegion, type DrawStats, type LeafMeta, type Region, type UndoRecord } from './cells';
import { MeshView, type MeshData } from './meshview';

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
export type Tool = 'none' | 'measure';
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

export interface Station { image: number; t: [number, number, number]; q: [number, number, number, number]; w: number; h: number; bytes: number; name: string | null }

export class Viewer {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  fly: Fly;
  cells: CellRenderer;
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
  zRange: [number, number] = [0, 1];
  robust: THREE.Box3 | null = null;
  private cw = innerWidth; private ch = innerHeight;

  // regions + gizmo
  regions: Region[] = [];
  regionHide = false;
  private regionGroups = new Map<string, THREE.Group>();
  activeRegion: string | null = null;
  private tc: TransformControls;
  gizmoMode: GizmoMode = 'translate';
  gizmoBusy = false;
  onRegionChange: ((r: Region) => void) | null = null;
  onSuggestionDecision: ((id: string, accept: boolean) => void) | null = null;
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
    this.tc.addEventListener('dragging-changed', (e: any) => { this.gizmoBusy = !!e.value; if (!this.fly.enabled) this.controls.enabled = !e.value; this.touch(); });
    this.tc.addEventListener('objectChange', () => this.syncActiveFromGroup());

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.cells = new CellRenderer(gl);
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
  appendLeaf(tag: number, recs: Uint8Array, n: number) { this.cells.appendLeaf(tag, recs, n); this.dirty = true; }
  dropPreview() { this.cells.dropPreview(); this.dirty = true; }
  clear() { this.cells.clear(); this.robust = null; this.setRegions([]); this.clearMeasures(); this.setStations([]); this.exitBubble(); this.dirty = true; }
  get loaded() { return this.cells.total; }
  setRobustBounds(lo: [number, number, number], hi: [number, number, number]) { this.robust = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)); this.applyZRange(); this.dirty = true; }
  bounds() { return this.robust && !this.robust.isEmpty() ? this.robust : this.cells.bounds; }
  applyZRange() { const b = this.bounds(); if (!b.isEmpty()) this.zRange = [b.min.z, b.max.z]; }
  setKnobs(k: Knobs) {
    this.knobs = k; this.fly.speed = k.flySpeed;
    this.edlMat.uniforms.uEnabled.value = k.edl && this.rtType !== THREE.UnsignedByteType ? 1 : 0;
    this.edlMat.uniforms.uStrength.value = k.edlStrength; this.edlMat.uniforms.uRadius.value = k.edlRadius;
    this.dirty = true;
  }

  // ------------------------------------------------------------ regions
  private buildRegionGroup(r: Region): THREE.Group {
    const g = new THREE.Group();
    const col = ROLE_COLOR[r.role] ?? TEAL;
    const fillMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: r.role === 'keep' ? 0.06 : 0.14, depthTest: false, depthWrite: false });
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
  private slabSpan(): number { const b = this.bounds(); if (b.isEmpty()) return 200; const s = b.getSize(new THREE.Vector3()); return Math.max(s.x, s.y, s.z) * 3; }
  private applyRegionToGroup(r: Region, g: THREE.Group) {
    g.position.set(r.center[0], r.center[1], r.center[2]);
    g.quaternion.set(r.quat[0], r.quat[1], r.quat[2], r.quat[3]);
    if (r.kind === 'box') g.scale.set(r.half[0] * 2, r.half[1] * 2, r.half[2] * 2);
    else if (r.kind === 'sphere') g.scale.set(r.radius * 2, r.radius * 2, r.radius * 2);
    else { const s = this.slabSpan(); g.scale.set(s, s, r.half[2] * 2); }
  }

  setRegions(list: Region[]) {
    this.regions = list;
    const ids = new Set(list.map(r => r.id));
    for (const [id, g] of this.regionGroups) if (!ids.has(id)) { this.overlay.remove(g); this.regionGroups.delete(id); if (this.activeRegion === id) this.setActiveRegion(null); }
    for (const r of list) {
      let g = this.regionGroups.get(r.id);
      if (!g || g.userData.kind !== r.kind || g.userData.role !== r.role) {
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
    if (g) { this.tc.attach(g); this.tc.enabled = true; this.tc.setMode(this.gizmoMode); }
    else { if (this.tc.object) this.tc.detach(); this.tc.enabled = false; }
    this.dirty = true;
  }
  setGizmoMode(m: GizmoMode) { this.gizmoMode = m; this.tc.setMode(m); this.dirty = true; }

  private syncActiveFromGroup() {
    const r = this.regions.find(x => x.id === this.activeRegion); const g = r && this.regionGroups.get(r.id);
    if (!r || !g) return;
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

  /** Replace the reconstructed surface. Passing null drops it. */
  setMesh(m: MeshData | null) {
    if (!m) { this.mesh.clear(); if (this.display !== 'points') this.setDisplay('points'); }
    else this.mesh.upload(m);
    this.dirty = true;
  }
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
    const P = this.camera.projectionMatrix.elements;
    this.camera.updateMatrixWorld();
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
  setTool(t: Tool) { this.tool = t; if (t !== 'measure') { this.pending = null; if (this.pendingMark) { this.overlay.remove(this.pendingMark); this.pendingMark = null; } } this.dirty = true; }

  // ------------------------------------------------------------ stations / bubbles
  setStations(list: Station[], translation: [number, number, number] = [0, 0, 0]) {
    for (const s of this.stationSprites) this.stationGroup.remove(s);
    this.stationSprites = []; this.stations = list;
    for (const st of list) { const s = this.sprite(this.stationTex, 0.028); s.position.set(st.t[0] - translation[0], st.t[1] - translation[1], st.t[2] - translation[2]); this.stationGroup.add(s); this.stationSprites.push(s); }
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
    const bb = this.bounds(); if (bb.isEmpty()) return;
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
    const bb = this.bounds(); if (bb.isEmpty()) return;
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
  /** Run `fn` with overlays hidden and a denser, brighter point pass — what an AI should look at. */
  cleanRender<T>(fn: () => T): T {
    const k = this.knobs; const saved = { ...k };
    const ov = this.overlay.visible, lb = this.labelsEl.style.display, pa = this.panoScene.visible, pAlpha = this.edlMat.uniforms.uPointAlpha.value;
    this.overlay.visible = false; this.labelsEl.style.display = 'none'; this.panoScene.visible = false; this.edlMat.uniforms.uPointAlpha.value = 1;
    Object.assign(k, { budget: Math.max(k.budget, 24_000_000), density: Math.max(k.density, 3), size: Math.max(k.size, 2.5), maxPx: Math.max(k.maxPx, 9), colorMode: 0, bright: Math.min(Math.max(k.bright, 1.0), 1.1), edlStrength: Math.min(k.edlStrength, 0.25), clipZMin: -1e9, clipZMax: 1e9 });
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
    if (this.cells.pendingCount && this.cells.flushUploads()) this.dirty = true;
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
    });
    if (this.display === 'mesh') {
      this.stats = { leavesVisible: 0, leavesDrawn: 0, pointsDrawn: 0, pointsTotal: this.cells.total };
    } else
    this.stats = this.cells.draw(this.camera, {
      budget, density: k.density, ptSize: k.size, sizeMode: k.sizeMode, minPx: 1, maxPx: k.maxPx,
      colorMode: k.colorMode, zMin: this.zRange[0], zMax: this.zRange[1], iMin: k.iMin, iMax: k.iMax,
      clipZMin: k.clipZMin, clipZMax: k.clipZMax, round: k.round, normalShade: k.normalShade, bright: k.bright, gamma: k.gamma,
      screenH: this.rt.height, fovDeg: this.camera.fov, regions: this.regions.filter(r => this.regionOverlayVisible(r)), regionHide: this.regionHide,
      sfMin: this.sf.min, sfMax: this.sf.max, sfLo: this.sf.lo, sfHi: this.sf.hi, sfHide: this.sf.hide,
    });
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
