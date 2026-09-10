// Triangle renderer for reconstructed surfaces.
//
// It draws into the same render target as the points and writes the same
// (colour, log-depth) pair, so the mesh depth-composites against the cloud and the
// eye-dome pass shades it for free. That is why this is raw WebGL2 rather than a
// three.js mesh in the overlay scene: an overlay would float on top of the points
// instead of being occluded by them.
import * as THREE from 'three';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aCol;
uniform mat4 uVP, uView;
uniform float uColorMode, uZMin, uZMax, uClipZMin, uClipZMax;
out vec3 vCol; out vec3 vNrm; out float vLogDepth; out vec3 vPosV; flat out float vDrop;

vec3 ramp(float t){
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return vec3(0.0, t*4.0, 1.0);
  if (t < 0.50) return vec3(0.0, 1.0, 1.0-(t-0.25)*4.0);
  if (t < 0.75) return vec3((t-0.5)*4.0, 1.0, 0.0);
  return vec3(1.0, 1.0-(t-0.75)*4.0, 0.0);
}

void main(){
  vDrop = (aPos.z < uClipZMin || aPos.z > uClipZMax) ? 1.0 : 0.0;
  vCol = uColorMode > 1.5 ? vec3(0.72, 0.74, 0.76)
       : uColorMode > 0.5 ? ramp((aPos.z - uZMin) / max(uZMax - uZMin, 1e-6))
       : aCol.rgb;
  vNrm = mat3(uView) * aNrm;
  vec4 mv = uView * vec4(aPos, 1.0);
  vPosV = mv.xyz;
  vLogDepth = log2(max(-mv.z, 1e-4));
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform float uBright, uGamma, uFlat, uShade;
in vec3 vCol; in vec3 vNrm; in float vLogDepth; in vec3 vPosV; flat in float vDrop;
out vec4 frag;
void main(){
  if (vDrop > 0.5) discard;
  vec3 n = uFlat > 0.5 ? normalize(cross(dFdx(vPosV), dFdy(vPosV))) : normalize(vNrm + vec3(1e-6));
  if (!gl_FrontFacing) n = -n;
  vec3 c = vCol;
  if (uShade > 0.5) {
    // headlight plus a little ambient from below, so cavities do not go pure black
    float d = clamp(n.z, -1.0, 1.0);
    c *= mix(0.34, 1.18, d * 0.5 + 0.5);
  }
  c = pow(max(c * uBright, 0.0), vec3(1.0 / uGamma));
  frag = vec4(c, vLogDepth);
}`;

function compile(gl: WebGL2RenderingContext, src: string, kind: number): WebGLShader {
  const s = gl.createShader(kind)!;
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('mesh shader: ' + gl.getShaderInfoLog(s));
  return s;
}

export interface MeshDrawParams {
  colorMode: number; zMin: number; zMax: number;
  clipZMin: number; clipZMax: number;
  bright: number; gamma: number; flat: boolean; shade: boolean;
}

export interface MeshData {
  pos: Float32Array; nrm: Float32Array; col: Uint8Array; idx: Uint32Array;
}

export class MeshView {
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private count = 0;
  vertices = 0;
  triangles = 0;
  bytes = 0;
  bounds = new THREE.Box3();
  visible = true;

  constructor(private gl: WebGL2RenderingContext) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, VS, gl.VERTEX_SHADER));
    gl.attachShader(p, compile(gl, FS, gl.FRAGMENT_SHADER));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('mesh link: ' + gl.getProgramInfoLog(p));
    this.prog = p;
    for (const n of ['uVP', 'uView', 'uColorMode', 'uZMin', 'uZMax', 'uClipZMin', 'uClipZMax', 'uBright', 'uGamma', 'uFlat', 'uShade']) {
      this.u[n] = gl.getUniformLocation(p, n);
    }
  }

  get hasMesh() { return this.count > 0; }

  upload(m: MeshData) {
    const gl = this.gl;
    this.clear();
    if (!m.idx.length) return;
    const mk = (target: number, data: ArrayBufferView) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW);
      this.buffers.push(b); this.bytes += data.byteLength;
      return b;
    };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    mk(gl.ARRAY_BUFFER, m.pos);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    mk(gl.ARRAY_BUFFER, m.nrm);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    // colours arrive as tight rgb triples; pad to 4 so the attribute stride stays aligned
    const rgba = new Uint8Array((m.pos.length / 3) * 4);
    for (let i = 0, n = m.pos.length / 3; i < n; i++) {
      rgba[i * 4] = m.col[i * 3]; rgba[i * 4 + 1] = m.col[i * 3 + 1];
      rgba[i * 4 + 2] = m.col[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    mk(gl.ARRAY_BUFFER, rgba);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    mk(gl.ELEMENT_ARRAY_BUFFER, m.idx);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.count = m.idx.length;
    this.vertices = m.pos.length / 3;
    this.triangles = m.idx.length / 3;
    this.bounds.makeEmpty();
    const v = new THREE.Vector3();
    for (let i = 0; i < m.pos.length; i += 3) this.bounds.expandByPoint(v.set(m.pos[i], m.pos[i + 1], m.pos[i + 2]));
  }

  clear() {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    for (const b of this.buffers) gl.deleteBuffer(b);
    this.vao = null; this.buffers = []; this.count = 0;
    this.vertices = 0; this.triangles = 0; this.bytes = 0;
    this.bounds.makeEmpty();
  }

  /** Draw into the currently bound target. Assumes depth test is already on. */
  draw(camera: THREE.PerspectiveCamera, p: MeshDrawParams) {
    if (!this.count || !this.visible || !this.vao) return 0;
    const gl = this.gl;
    // This target holds (colour, log depth), not premultiplied colour: with blending left on
    // from the previous pass the depth in alpha would scale the colour and blow it out.
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);          // scanned surfaces get looked at from both sides
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uVP!, false, vp.elements);
    gl.uniformMatrix4fv(this.u.uView!, false, camera.matrixWorldInverse.elements);
    gl.uniform1f(this.u.uColorMode!, p.colorMode);
    gl.uniform1f(this.u.uZMin!, p.zMin); gl.uniform1f(this.u.uZMax!, p.zMax);
    gl.uniform1f(this.u.uClipZMin!, p.clipZMin); gl.uniform1f(this.u.uClipZMax!, p.clipZMax);
    gl.uniform1f(this.u.uBright!, p.bright); gl.uniform1f(this.u.uGamma!, p.gamma);
    gl.uniform1f(this.u.uFlat!, p.flat ? 1 : 0);
    gl.uniform1f(this.u.uShade!, p.shade ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return this.triangles;
  }

  /** Binary PLY of the surface, ready to write to a file. */
  toPly(m: MeshData, translation: [number, number, number]): Blob {
    const nv = m.pos.length / 3, nf = m.idx.length / 3;
    const header =
      `ply\nformat binary_little_endian 1.0\ncomment e57view surface reconstruction\n` +
      `element vertex ${nv}\nproperty double x\nproperty double y\nproperty double z\n` +
      `property float nx\nproperty float ny\nproperty float nz\n` +
      `property uchar red\nproperty uchar green\nproperty uchar blue\n` +
      `element face ${nf}\nproperty list uchar uint vertex_indices\nend_header\n`;
    const vStride = 8 * 3 + 4 * 3 + 3;
    const body = new ArrayBuffer(nv * vStride + nf * (1 + 12));
    const dv = new DataView(body);
    let o = 0;
    for (let i = 0; i < nv; i++) {
      dv.setFloat64(o, m.pos[i * 3] + translation[0], true); o += 8;
      dv.setFloat64(o, m.pos[i * 3 + 1] + translation[1], true); o += 8;
      dv.setFloat64(o, m.pos[i * 3 + 2] + translation[2], true); o += 8;
      dv.setFloat32(o, m.nrm[i * 3], true); o += 4;
      dv.setFloat32(o, m.nrm[i * 3 + 1], true); o += 4;
      dv.setFloat32(o, m.nrm[i * 3 + 2], true); o += 4;
      dv.setUint8(o++, m.col[i * 3]); dv.setUint8(o++, m.col[i * 3 + 1]); dv.setUint8(o++, m.col[i * 3 + 2]);
    }
    for (let f = 0; f < nf; f++) {
      dv.setUint8(o++, 3);
      dv.setUint32(o, m.idx[f * 3], true); o += 4;
      dv.setUint32(o, m.idx[f * 3 + 1], true); o += 4;
      dv.setUint32(o, m.idx[f * 3 + 2], true); o += 4;
    }
    return new Blob([header, body], { type: 'application/octet-stream' });
  }

  /** Wavefront OBJ. Text, so much larger than PLY, but every tool reads it. */
  toObj(m: MeshData, translation: [number, number, number]): Blob {
    const parts: string[] = ['# e57view surface reconstruction\n'];
    const nv = m.pos.length / 3;
    let chunk: string[] = [];
    for (let i = 0; i < nv; i++) {
      chunk.push(`v ${(m.pos[i * 3] + translation[0]).toFixed(4)} ${(m.pos[i * 3 + 1] + translation[1]).toFixed(4)} ${(m.pos[i * 3 + 2] + translation[2]).toFixed(4)} ${(m.col[i * 3] / 255).toFixed(3)} ${(m.col[i * 3 + 1] / 255).toFixed(3)} ${(m.col[i * 3 + 2] / 255).toFixed(3)}\n`);
      if (chunk.length > 20000) { parts.push(chunk.join('')); chunk = []; }
    }
    parts.push(chunk.join('')); chunk = [];
    for (let i = 0; i < nv; i++) {
      chunk.push(`vn ${m.nrm[i * 3].toFixed(4)} ${m.nrm[i * 3 + 1].toFixed(4)} ${m.nrm[i * 3 + 2].toFixed(4)}\n`);
      if (chunk.length > 20000) { parts.push(chunk.join('')); chunk = []; }
    }
    parts.push(chunk.join('')); chunk = [];
    for (let f = 0; f < m.idx.length; f += 3) {
      const a = m.idx[f] + 1, b = m.idx[f + 1] + 1, c = m.idx[f + 2] + 1;
      chunk.push(`f ${a}//${a} ${b}//${b} ${c}//${c}\n`);
      if (chunk.length > 20000) { parts.push(chunk.join('')); chunk = []; }
    }
    parts.push(chunk.join(''));
    return new Blob(parts, { type: 'text/plain' });
  }
}
