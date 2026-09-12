// SPDX-License-Identifier: GPL-3.0-only
// Potree-style EDL. Operates on log2(view depth) stored in alpha, which makes
// the response a ratio of distances, so one strength works at any scene scale.
export const EDL_FS = /* glsl */`
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uRadius, uStrength, uEnabled, uBias, uPointAlpha;
uniform vec3 uBg;
varying vec2 vUv;

const int N = 8;

void main(){
  vec4 c = texture2D(uTex, vUv);
  // uPointAlpha < 1 while a panorama is behind the points: background pixels go
  // transparent so the photo shows through, and points blend on top
  if (c.a <= 0.0) { gl_FragColor = vec4(uBg, uPointAlpha >= 1.0 ? 1.0 : 0.0); return; }
  if (uEnabled < 0.5) { gl_FragColor = vec4(c.rgb, uPointAlpha); return; }

  vec2 step = uRadius / uRes;
  float sum = 0.0; float n = 0.0;
  for (int i = 0; i < N; i++) {
    float a = 6.2831853 * float(i) / float(N);
    vec4 s = texture2D(uTex, vUv + vec2(cos(a), sin(a)) * step);
    if (s.a > 0.0) { sum += max(0.0, c.a - s.a - uBias); n += 1.0; }
  }
  float response = (n > 0.0) ? sum / n : 0.0;
  float shade = exp(-response * 300.0 * uStrength);
  gl_FragColor = vec4(c.rgb * shade, uPointAlpha);
}`;

export const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
