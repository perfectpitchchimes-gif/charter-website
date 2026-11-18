// Live lighthouse for "After dark": the South Lantern, Greywick's reef light, at night, in the
// browser. The same turning optic as the game (two flash panels 54 degrees apart going round once
// in ten seconds, so a ship sees two flashes 1.5 s apart and then dark: Fl(2) 10s), the same beam
// haze, the same lens and the same test the game uses to decide when the lantern blazes at you,
// with the glints it lays on the sea when it does. The model is the game's own GLB.
// Sources: game/assets/buildings/building_beacon.gd, building_beam.gdshader, building_lens.gdshader,
// building_night.gd, and the lamp-glint branch of game/greywick/coast/water.gdshader.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
// building_beacon.gd and the South Lantern's manifest entry.
const PERIOD = 10.0;
const SPLIT = 54 * DEG;
const PANELS = 2;
const DRUM_R = 0.36;
const PANEL_M = 0.45;
const BEAM_M = 650.0;
const BEAM_HALF = 4.2 * DEG;
const SPREAD = 5.0 * DEG;
const BEACON_REST = 0.2;
const LAMP = new THREE.Vector3(0, 12.49, 0);
const TINT = new THREE.Color(1.0, 0.93, 0.8);
const TRACE_SECONDS = 20;

const mod = (a, n) => ((a % n) + n) % n;
const wrap = (a) => mod(a + Math.PI, 2 * Math.PI) - Math.PI;

// Where panel k points at time t, about the up axis from +Z (building_beacon.gd angle()).
function angle(k, t) {
  return -(2 * Math.PI * mod(t, PERIOD) / PERIOD - SPLIT * k);
}

// How squarely a panel faces the eye: 0 between flashes, 1 dead on (building_beacon.gd seen()).
function seen(t, eye) {
  const bearing = Math.atan2(eye.x - LAMP.x, eye.z - LAMP.z);
  let best = 0;
  for (let k = 0; k < PANELS; k++) {
    const off = wrap(bearing - angle(k, t)) / SPREAD;
    best = Math.max(best, Math.exp(-off * off));
  }
  return best;
}

// An open truncated cone along +Z (building_beacon.gd _cone), with smooth normals.
function cone(length, half, start, sides) {
  const end = start + length * Math.tan(half);
  const pos = [], nrm = [];
  for (let i = 0; i < sides; i++) {
    const a0 = 2 * Math.PI * i / sides, a1 = 2 * Math.PI * (i + 1) / sides;
    const n0 = new THREE.Vector3(Math.cos(a0), Math.sin(a0), -Math.tan(half)).normalize();
    const n1 = new THREE.Vector3(Math.cos(a1), Math.sin(a1), -Math.tan(half)).normalize();
    const near0 = [Math.cos(a0) * start, Math.sin(a0) * start, 0], near1 = [Math.cos(a1) * start, Math.sin(a1) * start, 0];
    const far0 = [Math.cos(a0) * end, Math.sin(a0) * end, length], far1 = [Math.cos(a1) * end, Math.sin(a1) * end, length];
    for (const [p, n] of [[near0, n0], [far0, n0], [far1, n1], [near0, n0], [far1, n1], [near1, n1]]) {
      pos.push(...p); nrm.push(n.x, n.y, n.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return geometry;
}

// building_beam.gdshader: forward-scattering haze (Henyey-Greenstein), a soft gaussian edge,
// a path that grows as the eye looks along the beam, and fog that thickens and shortens it.
const BEAM_VERTEX = /* glsl */`
  uniform float length_m;
  varying float along;
  varying vec3 axis;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    along = position.z / length_m;
    axis = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
    vNormal = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vView = -view.xyz;
    gl_Position = projectionMatrix * view;
  }`;
const BEAM_FRAGMENT = /* glsl */`
  uniform vec3 tint;
  uniform float strength, g, side_on, drift_speed, edge, fog, time;
  varying float along;
  varying vec3 axis;
  varying vec3 vNormal;
  varying vec3 vView;
  float wisp(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    vec3 view = normalize(vView);
    float c = clamp(dot(axis, view), -1.0, 1.0);
    float s = max(sqrt(1.0 - c * c), 0.15);
    float x = clamp(abs(dot(normalize(vNormal), view)) / s, 0.0, 1.0);
    float across2 = 1.0 - x * x;
    float soft = (exp(-across2 / (2.0 * edge * edge)) - exp(-1.0 / (2.0 * edge * edge))) / (1.0 - exp(-1.0 / (2.0 * edge * edge)));
    float chord = max(soft, 0.0) / s;
    float reach = exp(-along * (2.4 + 7.0 * fog)) * smoothstep(0.0, 0.02, along) * (1.0 - smoothstep(0.55, 0.98, along));
    float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
    float haze = 0.8 + 0.25 * wisp(vec2(along * 6.0 - time * drift_speed * 2.0, 3.7));
    gl_FragColor = vec4(tint * min(side_on * (1.0 + 2.5 * fog) * chord * reach * phase * haze * strength, 0.7), 1.0);
    #include <colorspace_fragment>
  }`;

// building_lens.gdshader: the bull's-eye panel, ringed like its prisms, blinding face-on.
const LENS_VERTEX = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vView = -view.xyz;
    gl_Position = projectionMatrix * view;
  }`;
const LENS_FRAGMENT = /* glsl */`
  uniform vec3 tint;
  uniform float glow;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float disc = 1.0 - smoothstep(0.82, 1.0, r);
    float rings = 0.8 + 0.2 * cos(r * 26.0);
    float facing = pow(max(dot(normalize(vNormal), normalize(vView)), 0.0), 14.0);
    gl_FragColor = vec4(tint * disc * rings * (0.35 + 7.0 * facing) * glow, 1.0);
    #include <colorspace_fragment>
  }`;

// A night sea for the light to fall on: a dark swell built from a few crossing waves, the sky's
// faint reflection, and the game's lamp glints, a sharp GGX lobe (alpha 0.022) from each lamp
// toward the eye that breaks into a path of sparks across the moving surface.
const SEA_VERTEX = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;
const SEA_FRAGMENT = /* glsl */`
  uniform float time;
  uniform vec3 lamp;
  uniform vec3 lamp_color;
  uniform float lamp_energy;
  uniform vec3 house;
  uniform float house_energy;
  uniform float fog;
  varying vec3 vWorld;
  vec2 waves(vec2 p) {
    vec2 slope = vec2(0.0);
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float a = fi * 2.399 + 0.6;
      vec2 d = vec2(cos(a), sin(a));
      float k = 0.19 * pow(1.55, fi);
      float w = sqrt(9.81 * k);
      float amp = 0.32 / pow(1.6, fi);
      slope += d * k * amp * cos(dot(d, p) * k - w * time * 0.6 + fi * 1.7);
    }
    return slope;
  }
  float ggx(vec3 n, vec3 l, vec3 v, float alpha) {
    vec3 h = normalize(l + v);
    float nh = max(dot(n, h), 0.0);
    float a2 = alpha * alpha;
    float d = 1.0 + (a2 - 1.0) * nh * nh;
    float f = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
    return f * a2 / (3.14159 * d * d) / (4.0 * max(dot(n, v), 0.0001) + 0.1);
  }
  void main() {
    vec2 slope = waves(vWorld.xz);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 v = normalize(cameraPosition - vWorld);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 sky = mix(vec3(0.012, 0.022, 0.045), vec3(0.03, 0.05, 0.09), clamp(reflect(-v, n).y * 3.0, 0.0, 1.0));
    vec3 color = vec3(0.004, 0.012, 0.018) * (1.0 - fresnel) + sky * fresnel;
    vec3 l = normalize(lamp - vWorld);
    float reach = 1.0 - smoothstep(300.0, 450.0, length(lamp.xz - vWorld.xz));
    color += lamp_color * ggx(n, l, v, 0.022) * 0.025 * lamp_energy * reach;
    vec3 lh = normalize(house - vWorld);
    color += vec3(1.0, 0.78, 0.56) * ggx(n, lh, v, 0.022) * 0.025 * house_energy * (1.0 - smoothstep(60.0, 90.0, length(house.xz - vWorld.xz)));
    float far = length(cameraPosition - vWorld);
    float haze = 1.0 - exp(-far * (0.0009 + 0.006 * fog));
    color = mix(color, mix(vec3(0.016, 0.026, 0.045), vec3(0.03, 0.04, 0.055), fog), haze);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// A small sharp point for the lantern once it is down to a few pixels (building_halo.gdshader).
function pointSprite() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,248,235,1)');
  gradient.addColorStop(0.18, 'rgba(255,240,215,0.9)');
  gradient.addColorStop(0.42, 'rgba(255,230,190,0.18)');
  gradient.addColorStop(1, 'rgba(255,230,190,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false, transparent: true }));
}

// Each building material family, with the game's look at night (assets/buildings/materials).
function familyMaterial(name) {
  const family = name.replace(/^bld_/, '');
  const base = { vertexColors: true, roughness: 0.85, metalness: 0.0 };
  if (family === 'glass_lit') return new THREE.MeshStandardMaterial({ ...base, emissive: new THREE.Color(1.0, 0.72, 0.42), emissiveIntensity: 1.4 });
  if (family === 'beacon') return new THREE.MeshStandardMaterial({ ...base, emissive: TINT.clone(), emissiveIntensity: BEACON_REST });
  if (family === 'glass') return new THREE.MeshStandardMaterial({ ...base, roughness: 0.15, metalness: 0.2 });
  if (family === 'brass' || family.startsWith('iron')) return new THREE.MeshStandardMaterial({ ...base, roughness: 0.6, metalness: 0.5 });
  return new THREE.MeshStandardMaterial(base);
}

function build(root) {
  const canvas = root.querySelector('canvas');
  const trace = root.querySelector('[data-trace]');
  const fogInput = root.querySelector('input[type=range]');
  const fogLabel = root.querySelector('[data-fog]');
  const pause = root.querySelector('[data-pause]');
  const small = window.matchMedia('(max-width: 720px)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 2));
  renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x050b16);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050b16);
  scene.fog = new THREE.FogExp2(0x050b16, 0.0009);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 5000);
  camera.position.set(-45, 6.5, 105);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 8, 0);
  controls.enableDamping = true;
  controls.minDistance = 30;
  controls.maxDistance = 700;
  controls.maxPolarAngle = 88 * DEG;
  controls.enablePan = false;

  // Moonless night: a faint sky, starlight and the keeper's lamps.
  scene.add(new THREE.HemisphereLight(0x22324d, 0x020304, 0.5));
  const moon = new THREE.DirectionalLight(0x8ea6c8, 0.12);
  moon.position.set(-200, 300, -150);
  scene.add(moon);
  const stars = new THREE.BufferGeometry();
  const starPositions = [];
  for (let i = 0; i < 900; i++) {
    const a = Math.random() * Math.PI * 2, e = Math.acos(1 - Math.random() * 0.9);
    starPositions.push(Math.sin(e) * Math.cos(a) * 3000, Math.cos(e) * 3000 + 80, Math.sin(e) * Math.sin(a) * 3000);
  }
  stars.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xbfcbe0, size: 1.4, sizeAttenuation: false, fog: false })));

  const seaUniforms = {
    time: { value: 0 }, lamp: { value: LAMP.clone() }, lamp_color: { value: TINT.clone() }, lamp_energy: { value: 0 },
    house: { value: new THREE.Vector3(0, 8.2, 0) }, house_energy: { value: 3.0 }, fog: { value: 0 },
  };
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 1, 1).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ uniforms: seaUniforms, vertexShader: SEA_VERTEX, fragmentShader: SEA_FRAGMENT }));
  scene.add(sea);

  // The optic: panels round the lamp, each throwing a beam and carrying a lens.
  const optic = new THREE.Group();
  optic.position.copy(LAMP);
  scene.add(optic);
  const beamGeometry = cone(BEAM_M, BEAM_HALF, PANEL_M * 0.5, small ? 64 : 128);
  const arms = [], beams = [], lenses = [];
  for (let k = 0; k < PANELS; k++) {
    const arm = new THREE.Group();
    optic.add(arm);
    const beam = new THREE.ShaderMaterial({
      uniforms: { tint: { value: TINT.clone() }, strength: { value: 1 }, length_m: { value: BEAM_M }, g: { value: 0.6 }, side_on: { value: 0.034 },
        drift_speed: { value: 0.08 }, edge: { value: 0.4 }, fog: { value: 0 }, time: { value: 0 } },
      vertexShader: BEAM_VERTEX, fragmentShader: BEAM_FRAGMENT,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false,
    });
    arm.add(new THREE.Mesh(beamGeometry, beam));
    const lens = new THREE.ShaderMaterial({
      uniforms: { tint: { value: TINT.clone() }, glow: { value: 1 } }, vertexShader: LENS_VERTEX, fragmentShader: LENS_FRAGMENT,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_M * 0.85, PANEL_M), lens);
    panel.position.z = DRUM_R + 0.03;
    arm.add(panel);
    arms.push(arm); beams.push(beam); lenses.push(lens);
  }
  const point = pointSprite();
  point.position.copy(LAMP);
  point.scale.setScalar(0.03);
  scene.add(point);
  let beaconMaterial = null;

  new GLTFLoader().load(root.dataset.model, (gltf) => {
    gltf.scene.traverse((node) => {
      if (/colonly/.test(node.name)) { node.visible = false; return; }
      if (node.isMesh) {
        const material = familyMaterial(node.material.name || '');
        if ((node.material.name || '').endsWith('beacon')) beaconMaterial = material;
        node.material = material;
      }
    });
    // The building stands at 45 degrees in the world, as the game places it.
    gltf.scene.rotation.y = 45 * DEG;
    scene.add(gltf.scene);
    const keeper = new THREE.PointLight(0xffc890, 6, 9, 1.4);
    keeper.position.set(2.988, 8.22, -1.725).applyAxisAngle(new THREE.Vector3(0, 1, 0), 45 * DEG);
    scene.add(keeper);
    seaUniforms.house.value.copy(keeper.position);
    const lantern = new THREE.PointLight(0xfff1d6, 8, 16, 1.4);
    lantern.position.copy(LAMP);
    scene.add(lantern);
    root.classList.add('is-ready');
  }, undefined, () => root.classList.add('is-ready'));

  // Fog: the game's air (fog plus mist) thickens and shortens the beams and closes in.
  function setFog(value) {
    for (const beam of beams) beam.uniforms.fog.value = value;
    seaUniforms.fog.value = value;
    scene.fog.density = 0.0009 + 0.006 * value;
    const names = ['Clear night', 'A little haze', 'Mist', 'Sea fog'];
    fogLabel.textContent = names[Math.min(3, Math.round(value * 3))];
  }
  fogInput.addEventListener('input', () => setFog(parseFloat(fogInput.value)));
  setFog(parseFloat(fogInput.value));

  let speed = 1;
  for (const button of root.querySelectorAll('[data-speed]')) {
    button.addEventListener('click', () => {
      speed = parseFloat(button.dataset.speed);
      for (const other of root.querySelectorAll('[data-speed]')) other.setAttribute('aria-pressed', String(other === button));
    });
  }
  let paused = false;
  pause.addEventListener('click', () => { paused = !paused; pause.textContent = paused ? 'Play' : 'Pause'; });

  // The flashes you see from where you are, over the last twenty seconds.
  const history = [];
  const traceContext = trace.getContext('2d');
  function drawTrace(now) {
    const w = trace.width, h = trace.height;
    traceContext.clearRect(0, 0, w, h);
    traceContext.strokeStyle = 'rgba(238,240,234,0.22)';
    traceContext.lineWidth = 1;
    for (let s = 0; s <= TRACE_SECONDS; s += 5) {
      const x = w - (s / TRACE_SECONDS) * w;
      traceContext.beginPath(); traceContext.moveTo(x, h - 1); traceContext.lineTo(x, h - 6); traceContext.stroke();
    }
    traceContext.beginPath();
    traceContext.strokeStyle = '#f4e7c8';
    traceContext.lineWidth = 2;
    for (let i = 0; i < history.length; i++) {
      const [t, v] = history[i];
      const x = w - ((now - t) / TRACE_SECONDS) * w;
      const y = h - 4 - v * (h - 10);
      if (i === 0) traceContext.moveTo(x, y); else traceContext.lineTo(x, y);
    }
    traceContext.stroke();
  }

  function resize() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }

  let visible = false;
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }, { rootMargin: '100px' }).observe(root);
  // Start with the beams side-on to the opening view.
  let clock = 8.1, wall = 0, last = performance.now();
  const sampleStep = 0.05;
  let nextSample = 0;
  function frame(nowMs) {
    requestAnimationFrame(frame);
    const dt = Math.min((nowMs - last) / 1000, 0.1);
    last = nowMs;
    if (!visible) return;
    if (!paused) { clock += dt * speed; wall += dt; }
    resize();
    controls.update();
    const facing = seen(clock, camera.position);
    for (let k = 0; k < PANELS; k++) {
      arms[k].rotation.y = angle(k, clock);
      beams[k].uniforms.time.value = wall;
    }
    // The lantern glass rests at a fifth of its glow and blazes as a panel sweeps past the eye;
    // its reflection on the sea flares with it (building_night.gd, BEACON_GLINT 12).
    if (beaconMaterial) beaconMaterial.emissiveIntensity = (BEACON_REST + (1 - BEACON_REST) * facing) * 3.0;
    seaUniforms.lamp_energy.value = 12 * facing;
    seaUniforms.time.value = wall;
    const distance = camera.position.distanceTo(LAMP);
    point.material.opacity = Math.min(1, 0.12 + facing) * THREE.MathUtils.smoothstep(distance, 120, 300);
    point.scale.setScalar(0.012 + 0.02 * facing);
    if (!paused && clock >= nextSample) {
      history.push([clock, facing]);
      nextSample = clock + sampleStep;
      while (history.length && clock - history[0][0] > TRACE_SECONDS) history.shift();
    }
    drawTrace(clock);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

for (const root of document.querySelectorAll('[data-light-demo]')) {
  try { build(root); } catch (error) { root.classList.add('is-unsupported'); console.error(error); }
}
