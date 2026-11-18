// Live ocean for "The water". A browser port of Charter's own sea: the same JONSWAP/TMA
// spectrum, the same two wave layers and four sea states, the same foam bookkeeping and a
// cut-down version of the water material, with the real ship riding on top. The game runs
// this on the GPU at a much higher resolution; here a 128 x 128 FFT runs in JavaScript.
// Sources: game/ocean_fft/assets/shaders/compute/*.glsl, water.gdshader, ocean_conditions.gd,
// sea_states/*.tres. The "first sea" mode is CharterOcean.height_at's original three sines.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const G = 9.81;
const DEPTH = 20.0;
const WAVE_SPEED = 0.765; // temperate coast pace
const FETCH_M = 150e3;
const WIND_DIRECTION = 20.0;
const WATERLINE = 1.25;

// SeaStateProfile defaults, then each preset's own values (sea_states/*.tres).
const BASE = {
  swell_amplitude: 0.34, swell_wind_speed: 10.0, swell_choppiness: 1.15, swell_detail: 0.58, swell_spread: 0.22,
  chop_amplitude: 0.19, wind_speed: 5.5, chop_choppiness: 1.05, crossing_angle: 38.0, chop_detail: 0.9, chop_spread: 0.48,
  whitecap_threshold: 0.82, foam_production: 1.9, foam_lifetime: 3.8, foam_coverage: 1.0,
  breaker_start: 0.38, breaker_full: 0.74, breaker_strength: 0.76, roughness: 0.65, crest_light_strength: 0.48,
};
const PRESETS = [
  { ...BASE, swell_amplitude: 0.115, swell_wind_speed: 8.0, swell_choppiness: 0.65, swell_detail: 0.48, swell_spread: 0.2,
    chop_amplitude: 0.065, wind_speed: 3.3, chop_choppiness: 0.65, crossing_angle: 30.0, chop_detail: 0.8, chop_spread: 0.45,
    whitecap_threshold: 0.46, foam_production: 0.18, foam_lifetime: 2.8, foam_coverage: 0.65,
    breaker_start: 0.62, breaker_full: 0.90, breaker_strength: 0.50, roughness: 0.45, crest_light_strength: 0.30 },
  { ...BASE },
  { ...BASE, swell_amplitude: 0.47, swell_wind_speed: 11.5, swell_choppiness: 1.22, swell_detail: 0.65, swell_spread: 0.27,
    chop_amplitude: 0.265, wind_speed: 6.0, chop_choppiness: 1.18, crossing_angle: 46.0, chop_detail: 0.93, chop_spread: 0.56,
    whitecap_threshold: 0.86, foam_production: 2.9, foam_lifetime: 5.0, foam_coverage: 0.9,
    breaker_start: 0.34, breaker_full: 0.68, breaker_strength: 0.84, roughness: 0.72, crest_light_strength: 0.55 },
  { ...BASE, swell_amplitude: 0.67, swell_wind_speed: 13.0, swell_choppiness: 1.24, swell_detail: 0.67, swell_spread: 0.30,
    chop_amplitude: 0.34, wind_speed: 7.0, chop_choppiness: 1.18, crossing_angle: 55.0, chop_detail: 0.95, chop_spread: 0.62,
    whitecap_threshold: 0.89, foam_production: 3.2, foam_lifetime: 4.5, foam_coverage: 0.95,
    breaker_start: 0.30, breaker_full: 0.66, breaker_strength: 0.90, roughness: 0.77, crest_light_strength: 0.60 },
];
const STATE_NAMES = ['Calm', 'Everyday', 'Rough', 'Extreme'];

// OceanConditions._profile_values: 0..1.5 across calm, everyday, rough, extreme.
function profile(value) {
  const coordinate = Math.min(Math.max(value, 0), 1.5) * 2;
  const segment = Math.min(Math.floor(coordinate), 2);
  const blend = coordinate - segment;
  const low = PRESETS[segment], high = PRESETS[segment + 1], out = {};
  for (const key in BASE) out[key] = low[key] + (high[key] - low[key]) * blend;
  return out;
}

// Two layers: an 88 m swell and a 57 m local chop crossing it (OceanConditions.configure).
function cascades(state) {
  return [
    { length: 88, wind: state.swell_wind_speed, direction: WIND_DIRECTION, swell: 0.9, detail: state.swell_detail, spread: state.swell_spread,
      scale: state.swell_amplitude, chop: state.swell_choppiness, whitecap: state.whitecap_threshold, foam: state.foam_production, life: state.foam_lifetime, seed: [3211, -7042] },
    { length: 57, wind: state.wind_speed, direction: WIND_DIRECTION + state.crossing_angle, swell: 0.35, detail: state.chop_detail, spread: state.chop_spread,
      scale: state.chop_amplitude, chop: state.chop_choppiness, whitecap: Math.max(0.2, state.whitecap_threshold - 0.12), foam: state.foam_production * 0.65, life: state.foam_lifetime * 0.75, seed: [-904, 5518] },
  ];
}

// ---- spectrum_compute.glsl ----
function hash(x, y) {
  let h = (y + 374761393 + Math.imul(x, 3266489917)) >>> 0;
  h = Math.imul(2246822519, (h ^ (h >>> 15)) >>> 0) >>> 0;
  h = Math.imul(3266489917, (h ^ (h >>> 13)) >>> 0) >>> 0;
  const n = (h ^ (h >>> 16)) >>> 0;
  const m = Math.imul(n, 48271) >>> 0;
  return [((n >>> 1) & 0x7fffffff) / 0x7fffffff, ((m >>> 1) & 0x7fffffff) / 0x7fffffff];
}
function gaussian(u, v) {
  const r = Math.sqrt(-2 * Math.log(Math.max(u, 1e-7)));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}
function dispersion(k) {
  const a = k * DEPTH, b = Math.tanh(Math.min(a, 10));
  const w = Math.sqrt(G * k * b);
  return [w, 0.5 * G * (b + a * (1 - b * b)) / w];
}
function lhNormalization(s) {
  const a = Math.sqrt(s);
  return s < 0.4 ? 0.5 / Math.PI + s * (0.220636 + s * (-0.109 + s * 0.090)) : (1 / Math.sqrt(Math.PI)) * (a * 0.5 + (1 / a) * 0.0625);
}
function spread(w, wp, wind, theta, angle, swell) {
  const p = w / wp;
  const s = w <= wp ? 6.97 * Math.pow(Math.abs(p), 4.06) : 9.77 * Math.pow(Math.abs(p), -2.33 - 1.45 * (wind * wp / G - 1.17));
  const sXi = 16 * Math.tanh(Math.min(wp / w, 10)) * swell * swell;
  const shaped = s + sXi;
  return lhNormalization(shaped) * Math.pow(Math.abs(Math.cos((theta - angle) * 0.5)), 2 * shaped);
}
function tma(w, wp, alpha) {
  const sigma = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-(w - wp) * (w - wp) / (2 * sigma * sigma * wp * wp));
  const jonswap = (alpha * G * G) / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(3.3, r);
  const wh = Math.min(w * Math.sqrt(DEPTH / G), 2);
  return jonswap * (wh <= 1 ? 0.5 * wh * wh : 1 - 0.5 * (2 - wh) * (2 - wh));
}

class Layer {
  constructor(n) {
    this.n = n;
    const size = n * n;
    this.h0 = new Float32Array(size * 4); // h0(k) and conj(h0(-k))
    this.fields = Array.from({ length: 4 }, () => ({ re: new Float32Array(size), im: new Float32Array(size) }));
    this.disp = new Float32Array(size * 4);
    this.grad = new Float32Array(size * 4);
    this.height = new Float32Array(size);
    this.dispTex = new THREE.DataTexture(this.disp, n, n, THREE.RGBAFormat, THREE.FloatType);
    this.gradTex = new THREE.DataTexture(this.grad, n, n, THREE.RGBAFormat, THREE.FloatType);
    for (const tex of [this.dispTex, this.gradTex]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
    }
  }
  amplitude(a, b, p, alpha, wp) {
    const n = this.n, dk = 2 * Math.PI / p.length;
    const kx = (a - n / 2) * dk, kz = (b - n / 2) * dk;
    const k = Math.hypot(kx, kz);
    if (k < 1e-5) return [0, 0];
    const theta = Math.atan2(kz, kx);
    const [w, dw] = dispersion(k);
    const wNorm = dw / k * dk * dk;
    const s = tma(w, wp, alpha);
    const dir = 0.5 / Math.PI + (spread(w, wp, p.wind, theta, p.direction * Math.PI / 180, p.swell) - 0.5 / Math.PI) * (1 - p.spread);
    const d = dir * Math.exp(-(1 - p.detail) * (1 - p.detail) * k * k);
    const [u, v] = hash((a + p.seed[0]) >>> 0, (b + p.seed[1]) >>> 0);
    const [gr, gi] = gaussian(u, v);
    const m = Math.sqrt(2 * s * d * wNorm);
    return [gr * m, gi * m];
  }
  setSpectrum(p) {
    const n = this.n;
    const alpha = 0.076 * Math.pow(p.wind * p.wind / (FETCH_M * G), 0.22);
    const wp = 22 * Math.pow(G * G / (p.wind * FETCH_M), 1 / 3);
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const i = (b * n + a) * 4;
      const [r0, i0] = this.amplitude(a, b, p, alpha, wp);
      const [r1, i1] = this.amplitude((n - a) % n, (n - b) % n, p, alpha, wp);
      this.h0[i] = r0; this.h0[i + 1] = i0; this.h0[i + 2] = r1; this.h0[i + 3] = -i1;
    }
    // Per-wave frequency and direction, fixed until the sea state changes.
    this.omega = new Float32Array(n * n);
    this.unit = new Float32Array(n * n * 2);
    const dk = 2 * Math.PI / p.length;
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const idx = b * n + a, kx = (a - n / 2) * dk, kz = (b - n / 2) * dk, k = Math.hypot(kx, kz) + 1e-6;
      this.omega[idx] = Math.sqrt(G * k * Math.tanh(Math.min(k * DEPTH, 10)));
      this.unit[idx * 2] = kx / k; this.unit[idx * 2 + 1] = kz / k;
    }
    this.params = p;
  }
  // spectrum_modulate.glsl, written in world axes, then four inverse FFTs and fft_unpack.glsl.
  update(time, dt, fft) {
    const n = this.n, p = this.params, dk = 2 * Math.PI / p.length, [A, B, C, D] = this.fields;
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const idx = b * n + a, i = idx * 4;
      const kx = (a - n / 2) * dk, kz = (b - n / 2) * dk;
      const phase = this.omega[idx] * time;
      const c = Math.cos(phase), s = Math.sin(phase);
      // h = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
      const hr = this.h0[i] * c - this.h0[i + 1] * s + this.h0[i + 2] * c + this.h0[i + 3] * s;
      const hi = this.h0[i] * s + this.h0[i + 1] * c - this.h0[i + 2] * s + this.h0[i + 3] * c;
      const ux = this.unit[idx * 2], uz = this.unit[idx * 2 + 1];
      // i*h, used for horizontal displacement and slopes
      const jr = -hi, ji = hr;
      const hxr = jr * ux, hxi = ji * ux, hzr = jr * uz, hzi = ji * uz;
      const dyxr = jr * kx, dyxi = ji * kx, dyzr = jr * kz, dyzi = ji * kz;
      const dxxr = -hr * kx * ux, dxxi = -hi * kx * ux;
      const dzzr = -hr * kz * uz, dzzi = -hi * kz * uz;
      const dzxr = -hr * kx * uz, dzxi = -hi * kx * uz;
      // Two real fields per complex transform: X + iY.
      A.re[idx] = hxr - hi; A.im[idx] = hxi + hr;
      B.re[idx] = hzr - dyxi; B.im[idx] = hzi + dyxr;
      C.re[idx] = dyzr - dxxi; C.im[idx] = dyzi + dxxr;
      D.re[idx] = dzzr - dzxi; D.im[idx] = dzzi + dzxr;
    }
    for (const f of this.fields) fft.inverse2d(f.re, f.im);
    const scale = p.scale * p.chop, grow = dt * p.foam * 3, decay = Math.exp(-dt / Math.max(p.life, 0.2));
    for (let m = 0; m < n; m++) for (let x = 0; x < n; x++) {
      const idx = m * n + x, o = idx * 4, sign = ((x + m) & 1) ? -1 : 1;
      const hx = A.re[idx] * sign, hy = A.im[idx] * sign, hz = B.re[idx] * sign;
      const dhyDx = B.im[idx] * sign, dhyDz = C.re[idx] * sign, dhxDx = C.im[idx] * sign;
      const dhzDz = D.re[idx] * sign, dhzDx = D.im[idx] * sign;
      this.disp[o] = hx * p.chop; this.disp[o + 1] = hy; this.disp[o + 2] = hz * p.chop;
      this.height[idx] = hy;
      const jacobian = (1 + dhxDx * scale) * (1 + dhzDz * scale) - dhzDx * dhzDx * scale * scale;
      const foamFactor = -Math.min(0, jacobian - p.whitecap);
      let foam = this.grad[o + 3] * decay;
      foam = Math.min(1, Math.max(0, foam + foamFactor * grow * (1 - foam)));
      const det = Math.max(jacobian, 0.18);
      this.grad[o] = p.scale * ((1 + dhzDz * scale) * dhyDx - dhzDx * scale * dhyDz) / det;
      this.grad[o + 1] = p.scale * ((1 + dhxDx * scale) * dhyDz - dhzDx * scale * dhyDx) / det;
      this.grad[o + 2] = Math.max(0, 1 - jacobian);
      this.grad[o + 3] = foam;
    }
    this.dispTex.needsUpdate = true;
    this.gradTex.needsUpdate = true;
  }
  heightAt(x, z) {
    const n = this.n, L = this.params.length;
    const u = ((x / L) % 1 + 1) % 1 * n - 0.5, v = ((z / L) % 1 + 1) % 1 * n - 0.5;
    const x0 = Math.floor(u), z0 = Math.floor(v), fx = u - x0, fz = v - z0;
    const at = (i, j) => this.height[((j % n + n) % n) * n + ((i % n + n) % n)];
    const top = at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx;
    const bottom = at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx;
    return (top * (1 - fz) + bottom * fz) * this.params.scale;
  }
}

class FFT {
  constructor(n) {
    this.n = n;
    this.bits = Math.log2(n);
    this.rev = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.bits; b++) r |= ((i >> b) & 1) << (this.bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }
  // In-place inverse transform of one line (positive exponent, no normalisation, like the game).
  line(re, im, offset, stride) {
    const n = this.n, r = this.re, m = this.im;
    for (let i = 0; i < n; i++) { const j = offset + this.rev[i] * stride; r[i] = re[j]; m[i] = im[j]; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = r[b] * wr - m[b] * wi, ti = r[b] * wi + m[b] * wr;
          r[b] = r[a] - tr; m[b] = m[a] - ti;
          r[a] += tr; m[a] += ti;
        }
      }
    }
    for (let i = 0; i < n; i++) { const j = offset + i * stride; re[j] = r[i]; im[j] = m[i]; }
  }
  inverse2d(re, im) {
    const n = this.n;
    for (let row = 0; row < n; row++) this.line(re, im, row * n, 1);
    for (let col = 0; col < n; col++) this.line(re, im, col, n);
  }
}

// The first sea, CharterOcean.height_at with ocean_seed 731: three sines and nothing else.
const FIRST_PHASE = (731 % 97) * 0.13;
function firstSea(x, z, t) {
  return Math.sin(x * 0.18 + z * 0.11 + t * 0.85 + FIRST_PHASE) * 0.32
    + Math.sin(z * 0.32 - t * 1.2 + FIRST_PHASE * 0.7) * 0.16
    + Math.sin(x * 0.52 - z * 0.24 + t * 1.7) * 0.06;
}

const VERTEX = /* glsl */`
uniform sampler2D disp0, disp1;
uniform vec4 scale0, scale1;
uniform float time, mode;
uniform float phase;
varying vec3 vWorld;
varying float vHeight, vFade;
float firstSea(vec2 p, float t) {
  return sin(p.x*0.18 + p.y*0.11 + t*0.85 + phase)*0.32 + sin(p.y*0.32 - t*1.2 + phase*0.7)*0.16 + sin(p.x*0.52 - p.y*0.24 + t*1.7)*0.06;
}
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  float fade = min(exp(-(length(world.xz - cameraPosition.xz) - 150.0) * 0.007), 1.0);
  vec3 d;
  if (mode < 0.5) {
    d = texture2D(disp0, world.xz * scale0.xy).xyz * scale0.z + texture2D(disp1, world.xz * scale1.xy).xyz * scale1.z;
  } else {
    d = vec3(0.0, firstSea(world.xz, time), 0.0);
  }
  world.xyz += d * fade;
  vHeight = d.y;
  vFade = fade;
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */`
uniform sampler2D grad0, grad1;
uniform vec4 scale0, scale1;
uniform float time, mode, phase;
uniform vec3 waterColor, foamColor, crestTint, crestLightColor, sunDir, sunColor, skyZenith, skyHorizon;
uniform float facetStrength, normalStrength, detailStrength, foamCoverage, foamBreakup;
uniform float breakerStart, breakerFull, breakerStrength, crestTintStrength, crestLightStrength, roughness;
uniform vec2 windDir;
uniform mat4 shipInverse;
uniform vec3 hullHalf, hullCentre;
varying vec3 vWorld;
varying float vHeight, vFade;

float cellHash(vec2 p) {
  vec3 h = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  h += dot(h, h.yzx + 33.33);
  return fract((h.x + h.y) * h.z);
}
vec3 noiseGradient(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  vec2 u = f*f*(3.0 - 2.0*f), du = 6.0*f*(1.0 - f);
  float a = cellHash(cell), b = cellHash(cell + vec2(1.0, 0.0)), c = cellHash(cell + vec2(0.0, 1.0)), d = cellHash(cell + vec2(1.0, 1.0));
  return vec3(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(b-a, d-c, u.y)*du.x, mix(c-a, d-b, u.x)*du.y);
}
vec3 sky(vec3 dir, float halo) {
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 col = mix(skyHorizon, skyZenith, pow(up, 0.55));
  float sun = max(dot(dir, sunDir), 0.0);
  return col + sunColor * (pow(sun, 900.0) * 6.0 + pow(sun, 10.0) * 0.16 * halo);
}
void main() {
  // The game discards water inside the hull; this is a rounded box in ship space.
  vec3 local = (shipInverse * vec4(vWorld, 1.0)).xyz - vec3(hullCentre.x, 0.0, hullCentre.z);
  float taper = 1.0 - smoothstep(0.35, 1.0, clamp(-local.z / hullHalf.z, 0.0, 1.0)) * 0.85;
  if (abs(local.x) < hullHalf.x * taper && abs(local.z) < hullHalf.z && local.y < hullHalf.y) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  float dist = length(vWorld - cameraPosition);
  vec2 dx = dFdx(vWorld.xz), dy = dFdy(vWorld.xz);
  float footprint = max(length(dx), length(dy));
  float fineVisibility = (1.0 - smoothstep(16.0, 68.0, dist)) * (1.0 - smoothstep(0.08, 0.30, footprint));
  vec3 faceNormal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (faceNormal.y < 0.0) faceNormal = -faceNormal;
  vec3 color;

  if (mode > 0.5) {
    // The first sea's banded material, as it shipped.
    float t = time;
    vec3 n = normalize(vec3(
      -(cos(vWorld.x*0.18 + vWorld.z*0.11 + t*0.85 + phase)*0.32*0.18 + cos(vWorld.x*0.52 - vWorld.z*0.24 + t*1.7)*0.06*0.52),
      1.0,
      -(cos(vWorld.x*0.18 + vWorld.z*0.11 + t*0.85 + phase)*0.32*0.11 + cos(vWorld.z*0.32 - t*1.2 + phase*0.7)*0.16*0.32 - cos(vWorld.x*0.52 - vWorld.z*0.24 + t*1.7)*0.06*0.24)));
    float facets = sin(vWorld.x*0.53 + vWorld.z*0.38 + t*0.65) * sin(vWorld.z*0.29 - t*0.4);
    float band = floor((facets + 1.0) * 3.0) / 6.0;
    vec3 albedo = mix(vec3(0.014, 0.12, 0.18), vec3(0.045, 0.28, 0.31), band*0.85 + 0.12);
    albedo = mix(albedo, vec3(0.65, 0.85, 0.77), smoothstep(0.82, 0.98, facets) * 0.35);
    float lambert = max(dot(n, sunDir), 0.0);
    vec3 H = normalize(sunDir + V);
    float spec = pow(max(dot(n, H), 0.0), 60.0) * 0.24;
    color = albedo * (skyHorizon * 0.55 + sunColor * lambert * 0.75) + sunColor * spec;
  } else {
    vec2 gradient = vec2(0.0);
    float unfoamed = 1.0, compression = 0.0;
    vec4 f0 = texture2D(grad0, vWorld.xz * scale0.xy);
    vec4 f1 = texture2D(grad1, vWorld.xz * scale1.xy);
    gradient = f0.xy * scale0.w + f1.xy * scale1.w;
    unfoamed = (1.0 - clamp(f0.a, 0.0, 1.0)) * (1.0 - clamp(f1.a, 0.0, 1.0));
    // The game's 1024-point maps resolve sharper crests than this 128-point version, so
    // compression is lifted a little to land on the same breaker thresholds.
    compression = max(f0.b, f1.b) * 1.3;
    float persistentFoam = 1.0 - unfoamed;
    gradient *= vFade;
    vec3 smoothNormal = normalize(vec3(-gradient.x, 1.0, -gradient.y));
    float facets = facetStrength * (1.0 - smoothstep(38.0, 138.0, dist)) * (1.0 - smoothstep(0.25, 1.1, footprint));
    vec3 N = normalize(mix(smoothNormal, faceNormal, facets));
    N = normalize(vec3(N.x * normalStrength, N.y, N.z * normalStrength));

    mat2 rotation = mat2(vec2(0.80, 0.60), vec2(-0.60, 0.80));
    vec2 xz = vWorld.xz;
    vec2 drift = vec2(0.045, -0.028) * time;
    vec3 broad = noiseGradient(rotation * (xz * 0.34 + drift * 0.25));
    vec2 warped = rotation * (xz * 1.16 + drift) + broad.yz * 0.24;
    vec3 patchN = noiseGradient(warped + vec2(17.8, -9.2));
    vec3 fine = noiseGradient(rotation * (xz * 4.1 - drift * 1.9) + vec2(-31.4, 6.7));
    float history = smoothstep(0.26, 0.72, persistentFoam);
    float variation = (broad.x - 0.5) * 0.12;
    float activeCrest = smoothstep(breakerStart + variation, max(breakerFull, breakerStart + 0.08) + variation, compression);
    float expanded = smoothstep(breakerStart*0.87 + variation, max(breakerFull*0.94, breakerStart + 0.08) + variation, compression);
    float tip = smoothstep(0.28, 0.95, vHeight * vFade) * smoothstep(breakerStart*0.65 + variation, breakerFull*0.78 + variation, compression);
    activeCrest = max(activeCrest, max(expanded, tip));
    activeCrest *= smoothstep(0.025, 0.14, persistentFoam);
    float shreds = smoothstep(0.38, 0.67, mix(patchN.x, fine.x, 0.72 * fineVisibility));
    float broken = mix(1.0, shreds, min(foamBreakup * 1.4, 1.0));
    float crestFoam = activeCrest * min(breakerStrength * 1.22, 1.0) * mix(0.35, 1.0, broken);
    float islands = smoothstep(0.64, 0.85, mix(broad.x, patchN.x, 0.35));
    float grain = smoothstep(0.49, 0.80, noiseGradient(rotation * (xz * vec2(23.0, 19.0) + drift) + fine.yz * 0.24).x);
    float eroding = smoothstep(0.32 + 0.15 * patchN.x, 0.85, persistentFoam);
    float trail = history * 0.012 * broken + eroding * 0.09 * islands * grain * (1.0 - smoothstep(18.0, 60.0, dist));
    float foam = (crestFoam + trail * (1.0 - smoothstep(0.12, 0.60, activeCrest))) * foamCoverage;
    foam *= 1.0 - 0.65 * smoothstep(55.0, 250.0, dist);
    foam = clamp(foam, 0.0, 1.0);

    vec2 wind = normalize(windDir), side = vec2(-wind.y, wind.x);
    vec3 ripple = noiseGradient(vec2(dot(xz, wind), dot(xz, side)) * vec2(2.4, 7.0) - vec2(time*0.16, time*0.035));
    vec2 detail = transpose(rotation) * (patchN.yz*0.024 + fine.yz*0.015) + wind*ripple.y*0.045 + side*ripple.z*0.024;
    detail *= detailStrength * fineVisibility * (1.0 - foam*0.75);
    N = normalize(N + vec3(-detail.x, 0.0, -detail.y));

    float crest = smoothstep(0.12, 1.05, vHeight * vFade) * mix(0.35, 1.0, smoothstep(0.08, 0.65, length(gradient)));
    vec3 albedo = mix(waterColor, crestTint, crestTintStrength * crest * 0.55);
    albedo = mix(albedo, foamColor, foam);

    float facing = clamp(dot(V, N), 0.0, 1.0);
    float rough = mix(clamp(roughness*0.6, 0.22, 0.65), 0.86, foam);
    float fresnel = mix(pow(1.0 - facing, 5.0*exp(-2.69*roughness)) / (1.0 + 22.7*pow(roughness, 1.5)), 1.0, 0.02);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 reflection = sky(R, 0.25) * (1.0 - foam*0.8);
    float lambert = max(dot(N, sunDir), 0.0);
    vec3 diffuse = albedo * (mix(skyHorizon, skyZenith, 0.5) * (0.85 + foam * 0.9) + sunColor * lambert * (0.55 + foam * 0.5));
    vec3 H = normalize(sunDir + V);
    float a = rough * 0.7, a2 = a * a * a * a;
    float nh = max(dot(N, H), 0.0);
    float ggx = a2 / (3.14159 * pow(nh*nh*(a2 - 1.0) + 1.0, 2.0));
    float schlick = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    vec3 specular = sunColor * ggx * schlick * 0.25 / max(dot(N, V), 0.2) * step(0.0, dot(N, sunDir)) * (1.0 - foam);
    // Green light through thin, lifted, compressing wave faces when you look toward the sun.
    float crestMask = smoothstep(0.13, 0.72, vHeight * vFade) * smoothstep(0.16, 0.55, compression) * (1.0 - smoothstep(0.05, 0.52, foam)) * (1.0 - smoothstep(26.0, 110.0, dist));
    float through = pow(max(dot(-V, sunDir) * 0.5 + 0.5, 0.0), 3.0);
    vec3 crestLight = crestLightColor * crestMask * crestLightStrength * (0.12 + 1.1 * through) * 0.7;
    color = mix(diffuse + crestLight, reflection, max(fresnel, 0.06) * (1.0 - foam)) + specular;
    color += foamColor * foam * 0.16;
  }
  float fog = 1.0 - exp(-dist * 0.0011);
  color = mix(color, sky(normalize(vec3(vWorld.x - cameraPosition.x, 0.02, vWorld.z - cameraPosition.z)), 1.0), fog);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Dense near the ship, coarse towards the horizon: about a metre per cell in the middle.
function seaGeometry(segments) {
  const along = t => {
    const s = Math.sign(t), a = Math.abs(t);
    return s * (a < 0.7 ? a / 0.7 * 190 : 190 + Math.pow((a - 0.7) / 0.3, 2.2) * 3800);
  };
  const g = new THREE.PlaneGeometry(2, 2, segments, segments);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, along(p.getX(i)), 0, along(p.getZ(i)));
  g.computeBoundingSphere();
  g.boundingSphere.radius = 1e5;
  return g;
}

const linear = hex => new THREE.Color(hex).convertSRGBToLinear();

function build(root) {
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const n = 128;
  const canvas = root.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 2));
  renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const linearFloat = renderer.extensions.has('OES_texture_float_linear');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 9000);
  camera.position.set(-31, 7.0, -6);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 2.2, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 8;
  controls.maxDistance = 140;
  controls.enablePan = false;

  // Late afternoon: a low sun off the starboard bow lays a glitter path to the horizon.
  const sunDir = new THREE.Vector3(0.80, 0.15, -0.58).normalize();
  const sunColor = linear('#ffe6c4').multiplyScalar(2.0);
  const skyZenith = linear('#5b84a3'), skyHorizon = linear('#c4d1d3');
  scene.add(new THREE.HemisphereLight(0xdfe8ea, 0x2c4a52, 1.1));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { sunDir: { value: sunDir }, sunColor: { value: sunColor }, skyZenith: { value: skyZenith }, skyHorizon: { value: skyHorizon } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 sunDir, sunColor, skyZenith, skyHorizon; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float up = clamp(d.y, 0.0, 1.0); vec3 c = mix(skyHorizon, skyZenith, pow(up, 0.55));
      float s = max(dot(d, sunDir), 0.0); c += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 10.0) * 0.16 + pow(s, 3.0) * 0.06 * (1.0 - up)); gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMaterial);
  skyDome.frustumCulled = false;
  scene.add(skyDome);

  const fft = new FFT(n);
  const layers = [new Layer(n), new Layer(n)];
  if (!linearFloat) for (const l of layers) for (const t of [l.dispTex, l.gradTex]) t.magFilter = t.minFilter = THREE.NearestFilter;

  const uniforms = {
    disp0: { value: layers[0].dispTex }, disp1: { value: layers[1].dispTex },
    grad0: { value: layers[0].gradTex }, grad1: { value: layers[1].gradTex },
    scale0: { value: new THREE.Vector4() }, scale1: { value: new THREE.Vector4() },
    time: { value: 0 }, mode: { value: 0 }, phase: { value: FIRST_PHASE },
    waterColor: { value: linear('#182e39') }, foamColor: { value: linear('#d0d8d0') },
    crestTint: { value: linear('#417a70') }, crestLightColor: { value: linear('#72b998') },
    sunDir: { value: sunDir }, sunColor: { value: sunColor }, skyZenith: { value: skyZenith }, skyHorizon: { value: skyHorizon },
    facetStrength: { value: 0.70 }, normalStrength: { value: 1.55 }, detailStrength: { value: 0.20 },
    foamCoverage: { value: 1 }, foamBreakup: { value: 0.62 },
    breakerStart: { value: 0.38 }, breakerFull: { value: 0.74 }, breakerStrength: { value: 0.76 },
    crestTintStrength: { value: 0.10 }, crestLightStrength: { value: 0.48 }, roughness: { value: 0.65 },
    windDir: { value: new THREE.Vector2(Math.cos(WIND_DIRECTION * Math.PI / 180), Math.sin(WIND_DIRECTION * Math.PI / 180)) },
    shipInverse: { value: new THREE.Matrix4() }, hullHalf: { value: new THREE.Vector3(0, -1e3, 0) }, hullCentre: { value: new THREE.Vector3() },
  };
  const sea = new THREE.Mesh(seaGeometry(small ? 300 : 460), new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT }));
  sea.frustumCulled = false;
  scene.add(sea);

  // ---- state and controls ----
  let seaValue = Number(root.dataset.sea ?? 0.75);
  let layerMode = 'both';
  let firstSeaMode = false;
  let paused = false;
  let spectrumDirty = true;
  const ui = root.querySelector('.ocean-ui');
  const slider = ui.querySelector('input[type=range]');
  const stateLabel = ui.querySelector('[data-state]');
  slider.value = String(seaValue);
  const applyState = () => {
    const s = profile(seaValue);
    const cs = cascades(s);
    layers.forEach((layer, i) => {
      const on = layerMode === 'both' || (layerMode === 'swell' ? i === 0 : i === 1);
      layer.setSpectrum({ ...cs[i], scale: on ? cs[i].scale : 0 });
    });
    uniforms.foamCoverage.value = s.foam_coverage;
    uniforms.breakerStart.value = s.breaker_start;
    uniforms.breakerFull.value = s.breaker_full;
    uniforms.breakerStrength.value = s.breaker_strength;
    uniforms.crestLightStrength.value = s.crest_light_strength;
    uniforms.roughness.value = s.roughness;
    const coordinate = seaValue * 2;
    const nearest = Math.min(3, Math.round(coordinate));
    stateLabel.textContent = Math.abs(coordinate - nearest) < 0.08 ? STATE_NAMES[nearest] : `${STATE_NAMES[Math.min(3, Math.floor(coordinate))]} to ${STATE_NAMES[Math.min(3, Math.floor(coordinate) + 1)]}`;
    drawSpectrum(root.querySelector('.ocean-spectrum canvas'), layers);
    spectrumDirty = false;
  };
  slider.addEventListener('input', () => { seaValue = Number(slider.value); spectrumDirty = true; });
  for (const button of ui.querySelectorAll('[data-sea-mode]')) button.addEventListener('click', () => {
    firstSeaMode = button.dataset.seaMode === 'first';
    uniforms.mode.value = firstSeaMode ? 1 : 0;
    for (const b of ui.querySelectorAll('[data-sea-mode]')) b.setAttribute('aria-pressed', String(b === button));
    root.classList.toggle('is-first-sea', firstSeaMode);
  });
  for (const button of ui.querySelectorAll('[data-layer]')) button.addEventListener('click', () => {
    layerMode = button.dataset.layer;
    for (const b of ui.querySelectorAll('[data-layer]')) b.setAttribute('aria-pressed', String(b === button));
    spectrumDirty = true;
  });
  const pauseButton = ui.querySelector('[data-pause]');
  pauseButton.addEventListener('click', () => { paused = !paused; pauseButton.textContent = paused ? 'Play' : 'Pause'; });

  // ---- the ship ----
  let ship = null, shipSize = new THREE.Vector3(5, 3, 20), shipCentre = new THREE.Vector3();
  const motion = { heave: 0, pitch: 0, roll: 0, vHeave: 0, vPitch: 0, vRoll: 0 };
  new GLTFLoader().load(root.dataset.ship, gltf => {
    ship = gltf.scene;
    ship.traverse(o => {
      if (!o.isMesh) return;
      for (const m of [o.material].flat()) {
        if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.anisotropy = 4; }
        m.envMapIntensity = 0;
        if (m.transparent) m.depthWrite = false;
      }
    });
    const box = new THREE.Box3().setFromObject(ship);
    box.getSize(shipSize);
    box.getCenter(shipCentre);
    uniforms.hullHalf.value.set(shipSize.x * 0.47, WATERLINE + 0.9, shipSize.z * 0.48);
    uniforms.hullCentre.value.copy(shipCentre);
    scene.add(ship);
    root.classList.add('is-ready');
  }, undefined, () => root.classList.add('is-ready'));

  const heightAt = (x, z, t) => firstSeaMode ? firstSea(x, z, t) : layers[0].heightAt(x, z) + layers[1].heightAt(x, z);
  function moveShip(t, dt) {
    if (!ship) return;
    const half = shipSize.z * 0.38, beam = shipSize.x * 0.42;
    const cx = shipCentre.x, cz = shipCentre.z;
    const bow = heightAt(cx, cz - half, t), stern = heightAt(cx, cz + half, t);
    const port = heightAt(cx - beam, cz, t), star = heightAt(cx + beam, cz, t);
    const target = { heave: (bow + stern + port + star) / 4, pitch: Math.atan2(bow - stern, half * 2), roll: Math.atan2(star - port, beam * 2) };
    // A heavy hull follows the water late and softly instead of snapping to it.
    for (const [key, k, c] of [['heave', 6, 4.2], ['pitch', 5, 3.6], ['roll', 4, 2.4]]) {
      const v = 'v' + key[0].toUpperCase() + key.slice(1);
      motion[v] += ((target[key] - motion[key]) * k - motion[v] * c) * dt;
      motion[key] += motion[v] * dt;
    }
    // The hull's waterline sits 1.25 m above its origin (ShipDefinition.WATERLINE).
    ship.position.set(0, motion.heave - WATERLINE, 0);
    ship.rotation.set(motion.pitch, 0, motion.roll, 'YXZ');
    ship.updateMatrixWorld();
    uniforms.shipInverse.value.copy(ship.matrixWorld).invert();
  }

  // ---- loop ----
  let clock = 0, waveTime = 0, lastUpdate = -1, visible = true, last = performance.now();
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  };
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }, { rootMargin: '100px' }).observe(root);
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!visible) return;
    resize();
    if (spectrumDirty) applyState();
    if (!paused) { clock += dt; waveTime += dt * WAVE_SPEED; }
    // The game updates its wave maps 50 times a second; 30 is plenty here.
    if (!paused && !firstSeaMode && clock - lastUpdate >= 1 / 30) {
      const step = lastUpdate < 0 ? 1 / 30 : clock - lastUpdate;
      for (const layer of layers) layer.update(waveTime, step * WAVE_SPEED, fft);
      lastUpdate = clock;
    }
    layers.forEach((layer, i) => uniforms['scale' + i].value.set(1 / layer.params.length, 1 / layer.params.length, layer.params.scale, 1));
    uniforms.time.value = firstSeaMode ? clock : waveTime;
    moveShip(firstSeaMode ? clock : waveTime, dt);
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  root.oceanDebug = { layers, uniforms, camera, controls, profile, fft };
}

// The wave recipe the game generates: each pixel is one wave, brighter is taller.
// Only the middle of the grid is drawn: the long waves that carry most of the energy.
function drawSpectrum(canvas, layers) {
  if (!canvas) return;
  const n = layers[0].n, crop = 32, from = n / 2 - crop / 2, ctx = canvas.getContext('2d');
  canvas.width = canvas.height = crop;
  const img = ctx.createImageData(crop, crop);
  const values = new Float32Array(crop * crop);
  let max = 1e-9;
  for (let y = 0; y < crop; y++) for (let x = 0; x < crop; x++) {
    const i = (from + y) * n + from + x;
    let v = 0;
    for (const l of layers) v += Math.hypot(l.h0[i * 4], l.h0[i * 4 + 1]) * l.params.scale;
    values[y * crop + x] = v;
    max = Math.max(max, v);
  }
  for (let i = 0; i < crop * crop; i++) {
    const t = Math.log(1 + 60 * values[i] / max) / Math.log(61);
    img.data[i * 4] = 20 + 210 * Math.pow(t, 1.6);
    img.data[i * 4 + 1] = 40 + 200 * Math.pow(t, 0.9);
    img.data[i * 4 + 2] = 52 + 170 * Math.pow(t, 0.6);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

for (const root of document.querySelectorAll('[data-ocean-demo]')) {
  try { build(root); } catch (error) { root.classList.add('is-unsupported'); console.error(error); }
}
