/**
 * High-Performance EMBER Volumetric Flame Renderer (WebGL2 GLSL 300 es + Canvas2D Sprite Fallback)
 *
 * Visual model adapted from PyroTensor/EMBER's razor-crisp volumetric reaction-sheet &
 * 3D soot-filament shader, heavily optimized for locked 60 FPS across laptops & integrated GPUs:
 *  1. Precomputed tileable 32^3 RGBA8 WebGL2 TEXTURE_3D noise volume (~128 KB, L1/L2 cache resident)
 *     replacing 32 procedural 3D hash evaluations per step with 2 hardware trilinear texture fetches.
 *  2. Exact analytical Z-chord bounding slab (marching only through [-zSpan, +zSpan]) +
 *     early screen-space culling + Interleaved Gradient Noise (IGN) ray dithering.
 *  3. Zero transcendental calls (atan/sin/cos/pow) inside the raymarch loop via hoisted trig &
 *     exact triple-angle algebraic flute identities.
 *  4. Direct WebGL2 rendering (no offscreen 2D blit, antialias:false, depth:false, stencil:false) +
 *     ResizeObserver (zero per-frame getBoundingClientRect reflows).
 *  5. Dynamic adaptive quality governor (scale + step count) with software-GPU detection.
 */

const VERT_SRC = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision mediump sampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler3D uNoiseTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uVitality;
uniform float uShapeBf;
uniform float uScale;
uniform float uSootDom;
uniform float uCool;
uniform float uIgnite;
uniform float uFuelMode;
uniform vec3 uGeomScale;
uniform vec2 uWind;
uniform float uFlowDirX;
uniform int uSteps;

// Interleaved Gradient Noise (Jimenez 2014) for artifact-free ray dithering
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// 4-octave 3D FBM + sharp ridged filament creases via 2 cached hardware trilinear 3D texture reads
void fbmDetail(vec3 p, out float fbmVal, out float ridgeVal) {
  vec4 s1 = texture(uNoiseTex, p * 0.072) * 2.0 - 1.0;
  vec4 s2 = texture(uNoiseTex, p * 0.158 + vec3(0.37, 0.71, 0.19)) * 2.0 - 1.0;

  float n1 = s1.r;
  float n2 = 0.65 * s1.g + 0.35 * s2.r;
  float n3 = 0.60 * s1.b + 0.40 * s2.a;
  float n4 = s2.b;

  fbmVal = 0.52 * n1 + 0.27 * n2 + 0.14 * n3 + 0.07 * n4;
  float r = clamp(1.0 - abs(0.55 * n2 + 0.30 * n3 + 0.15 * n4), 0.0, 1.0);
  ridgeVal = r * r;
}

// Lightweight scientific combustion chamber background & physical fuel holder silhouette
vec3 evalBackground(vec2 screenPos, float aspect) {
  vec2 uv = screenPos * 0.5;
  float vig = max(0.22, 1.0 - 0.32 * dot(uv, uv));
  vec3 bg = vec3(0.016, 0.025, 0.048) * vig;

  // Cheap anti-aliased chamber reticle grid (zero fwidth() dependency)
  vec2 gp = abs(fract(uv * 5.0 - 0.5) - 0.5);
  float lineW = 3.2 / max(240.0, min(uRes.x, uRes.y));
  float gx = smoothstep(lineW, 0.0, gp.x);
  float gy = smoothstep(lineW, 0.0, gp.y);
  bg += vec3(0.032, 0.072, 0.115) * max(gx, gy) * 0.20;

  // Physical fuel holder silhouette matched to fuel mode
  if (uFuelMode < 0.5) {
    // FLEX droplet on thin SiC fiber
    float d = length(uv - vec2(0.0, -0.02));
    if (d < 0.044) {
      bg = mix(bg, vec3(0.28, 0.21, 0.15), smoothstep(0.044, 0.028, d));
    }
    float fiber = smoothstep(0.005, 0.001, abs(uv.y + 0.02)) * smoothstep(0.48, 0.05, abs(uv.x));
    bg += vec3(0.16, 0.20, 0.26) * fiber * 0.48;
  } else if (uFuelMode < 1.5) {
    // ACME gas burner nozzle positioned cleanly beneath the flame base
    float nozzleTop = mix(-0.18, -0.34, uShapeBf);
    if (abs(uv.x) < 0.055 && uv.y < nozzleTop && uv.y > -0.58) {
      bg = vec3(0.15, 0.19, 0.26) * (0.68 + 0.32 * (1.0 - abs(uv.x) / 0.055));
    }
  } else if (uFuelMode < 2.5) {
    // BASS-II PMMA rod
    if (abs(uv.x) < 0.032 && uv.y < -0.10 && uv.y > -0.56) {
      bg = vec3(0.24, 0.32, 0.40) * 0.65;
    }
  } else {
    // SAFFIRE flat sheet sample frame
    if (abs(uv.x) < 0.25 && uv.y < -0.23 && uv.y > -0.27) {
      bg = vec3(0.24, 0.26, 0.30);
    }
  }

  return bg;
}

void main() {
  float aspect = uRes.x / max(1.0, uRes.y);
  float nyScreen = vUv.y * 2.0 - 1.0;
  float nxScreen = (vUv.x * 2.0 - 1.0) * aspect;
  vec3 bg = evalBackground(vec2(nxScreen, nyScreen), aspect);

  // Ambient subtle halo around flame center
  float haloDist = length(vec2(nxScreen - uWind.x * 0.35, nyScreen + 0.22 * uShapeBf));
  vec3 haloCol = mix(vec3(0.06, 0.40, 0.92), vec3(0.95, 0.42, 0.10), uSootDom);
  haloCol = mix(haloCol, vec3(0.20, 0.32, 0.95), uCool);
  vec3 halo = haloCol * exp(-haloDist * 2.4) * 0.16 * clamp(uVitality, 0.0, 1.0);

  if (uVitality <= 0.01 && uIgnite <= 0.01) {
    fragColor = vec4(bg, 1.0);
    return;
  }

  float invScale = 1.0 / max(0.25, uScale);
  float baseY = -0.44 * uShapeBf;
  float lyRaw = (nyScreen - baseY) * invScale / uGeomScale.y;

  float minLy = uShapeBf > 0.1 ? -0.58 : -0.76;
  float maxLy = uShapeBf > 0.1 ? 1.18 : 0.76;

  // Early vertical rejection: 0 raymarch steps outside vertical envelope
  if (lyRaw < minLy || lyRaw > maxLy || uVitality <= 0.01) {
    vec3 outCol = bg + halo;
    if (uIgnite > 0.01) {
      outCol += vec3(0.55, 0.84, 1.0) * exp(-length(vec2(nxScreen, nyScreen)) * 4.5) * uIgnite * 0.9;
    }
    fragColor = vec4(clamp(outCol, 0.0, 1.0), 1.0);
    return;
  }

  float h = clamp((lyRaw + 0.36) / 1.32, 0.0, 1.15);
  float hPos = max(0.0, h);
  float heightWeight = uShapeBf > 0.05 ? pow(hPos, 1.25) : 0.45;
  float swirlTime = uTime * (1.2 + 2.0 * uShapeBf);
  float swayX = sin(swirlTime - h * 4.2) * 0.042 * uShapeBf * h;
  float lxCenter = (nxScreen * invScale - uWind.x * heightWeight - swayX) / uGeomScale.x;

  float rSphere = 0.54;
  float rPlume = 0.42 * pow(clamp(1.08 - h * 0.88, 0.02, 1.2), 0.58) *
                 (1.0 - 0.14 * uShapeBf * sin(clamp(h, 0.0, 1.0) * 3.14159265));
  float maxR = mix(rSphere, rPlume, uShapeBf) + 0.19;

  // Early horizontal + exact Z-chord rejection
  float zHalfSq = maxR * maxR - lxCenter * lxCenter;
  if (zHalfSq <= 0.0) {
    vec3 outCol = bg + halo;
    if (uIgnite > 0.01) {
      outCol += vec3(0.55, 0.84, 1.0) * exp(-length(vec2(nxScreen, nyScreen)) * 4.5) * uIgnite * 0.9;
    }
    fragColor = vec4(clamp(outCol, 0.0, 1.0), 1.0);
    return;
  }

  // Exact analytical Z-chord span: march ONLY through the flame volume!
  float zSpan = min(0.92, sqrt(zHalfSq) * uGeomScale.z);
  int steps = clamp(uSteps, 12, 32);
  float dz = (2.0 * zSpan) / float(steps);
  float invGeomZ = 1.0 / uGeomScale.z;

  // Hoist ALL loop-invariant terms outside the raymarch loop!
  float advectY = uTime * (0.95 + 3.2 * uShapeBf);
  float advectX = uTime * 0.45 * uFlowDirX;
  float lySample = (lyRaw - uWind.y * heightWeight) * 3.4 - advectY;

  float swirlAngle = h * 2.4 * uShapeBf + swirlTime * 0.35;
  float cosS = cos(swirlAngle);
  float sinS = sin(swirlAngle);

  float flutePhi = swirlTime * 0.8 - h * 5.0;
  float cosPhi = cos(flutePhi);
  float sinPhi = sin(flutePhi);
  float fluteAmp = 0.042 * h * uShapeBf;

  float turbCoeff = 0.032 + 0.13 * pow(hPos, 1.35) * (0.28 + 0.72 * uShapeBf);
  float hasBot = lyRaw < -0.22 ? 1.0 : 0.0;
  float botDist = hasBot * ((-0.22 - lyRaw) / 0.15);
  float tipFade = max(0.0, (h - 0.85) / 0.24);
  float tipPenalty = tipFade * tipFade * 0.88;

  float pyrolysisBase = clamp((h - 0.14) / 0.25, 0.0, 1.0);
  float hSootDecay = clamp(1.15 - h * 0.34, 0.2, 1.0);
  float blueSootAtten = 1.0 - 0.66 * uSootDom * clamp((h - 0.12) / 0.35, 0.0, 1.0);
  float blueBaseBoost = uShapeBf > 0.05 ? clamp(1.32 - h * 2.4, 0.18, 1.28) : 1.05;
  float hTempDecay = clamp(1.08 - pow(max(0.0, h - 0.35), 1.4) * 0.75, 0.25, 1.0);
  float innerCellBase = (1.0 - uShapeBf) * (0.28 + 0.45 * uSootDom);
  float extinctionFactor = (1.55 + 1.25 * uSootDom) * dz * 1.92;
  float igniteBoost = 1.0 + 0.55 * uIgnite;
  float lxSq = lxCenter * lxCenter;
  float lySq = lyRaw * lyRaw;
  float invRSphere = 1.0 / rSphere;
  float isDroplet = uFuelMode < 0.5 ? 1.0 : 0.0;

  // Dither ray start with IGN so 16-26 steps are band-free
  float jitter = ign(gl_FragCoord.xy + fract(uTime * 13.7) * 64.0);

  vec3 accColor = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    float z = (-zSpan + (float(i) + jitter) * dz) * invGeomZ;
    float zSq = z * z;
    float radialXZ = sqrt(lxSq + zSq);
    float dist3DSphere = sqrt(lxSq + lySq + zSq);

    // Coarse bounding skip before 3D texture reads
    float coarseSphere = dist3DSphere * invRSphere;
    float coarsePlume = radialXZ / max(0.04, rPlume + 0.16) + tipPenalty;
    if (mix(coarseSphere, coarsePlume, uShapeBf) > 1.24) continue;

    // 3D helical swirl around vertical axis (zero trig inside loop)
    float rx = lxCenter * cosS - z * sinS;
    float rz = lxCenter * sinS + z * cosS;

    vec3 samplePos = vec3(rx * 3.4 + advectX, lySample, rz * 3.4 + 4.7);
    float turb;
    float ridge;
    fbmDetail(samplePos, turb, ridge);

    // 1. 0g 3D Spherical Diffusion Field
    float normSphere = (dist3DSphere + turb * 0.042) * invRSphere;

    // 2. >0g 3D Buoyant Plume Field (exact triple-angle flutes, zero atan/sin/cos)
    float invRad = 1.0 / max(1e-4, radialXZ);
    float c1 = lxCenter * invRad;
    float s1 = z * invRad;
    float cos3 = c1 * (4.0 * c1 * c1 - 3.0);
    float sin3 = s1 * (3.0 - 4.0 * s1 * s1);
    float flutes = (sin3 * cosPhi + cos3 * sinPhi) * fluteAmp;

    float effRPlume = max(0.022, rPlume + flutes - turb * turbCoeff);
    float normPlume = radialXZ / effRPlume;
    if (hasBot > 0.5) {
      normPlume = sqrt(normPlume * normPlume + botDist * botDist);
    }
    normPlume += tipPenalty;

    float rNorm = mix(normSphere, normPlume, uShapeBf);
    if (rNorm > 1.04) continue;

    float outerCrispEdge = smoothstep(1.03, 0.88, rNorm);

    // Thin, razor-crisp 3D stoichiometric reaction front at rNorm ~ 0.85
    float sheetDelta = (rNorm - 0.85) * 14.7059; // / 0.068
    float reactionSheet = exp(-sheetDelta * sheetDelta) * outerCrispEdge;
    float sheetDetail = 0.78 + 0.48 * ridge;

    // Dark unburned fuel-vapor pyrolysis hollow above the base
    float pyrolysisHollow = pyrolysisBase * (1.0 - 0.68 * exp(-rNorm * rNorm * 6.0));
    float sootDelta = (rNorm - 0.56) * 4.7619; // / 0.21
    float sootShell = exp(-sootDelta * sootDelta) * pyrolysisHollow * hSootDecay * outerCrispEdge;
    float filamentDetail = clamp(0.65 + 0.65 * ridge + 0.25 * turb, 0.25, 1.5);

    float blueRadicalWeight = reactionSheet * sheetDetail * blueSootAtten;
    float sootWeight = sootShell * uSootDom * filamentDetail;

    // Subtle internal 3D cellular wisps inside the 0g sphere
    float cellDelta = (rNorm - 0.52) * 4.5455; // / 0.22
    float innerCell = innerCellBase * exp(-cellDelta * cellDelta) * (ridge * sqrt(ridge));

    // Cut out tiny central fuel droplet in 0g droplet mode
    float dropletMask = isDroplet > 0.5 ? smoothstep(0.08, 0.16, dist3DSphere) : 1.0;

    float totalDensity = (blueRadicalWeight * 1.65 + sootWeight * 2.1 + innerCell * 0.85) * uVitality * dropletMask;
    if (totalDensity < 0.008) continue;

    vec3 em = vec3(0.0);
    if (uCool > 0.5) {
      em = vec3(92.0, 114.0, 252.0) * (reactionSheet * sheetDetail * 1.55);
    } else {
      // 1. Crisp Blue CH* / OH* radical reaction front
      float bRad = blueRadicalWeight * blueBaseBoost;
      vec3 blueCol = mix(
        vec3(22.0, 115.0, 245.0),
        vec3(88.0, 198.0, 255.0),
        clamp(reactionSheet * ridge * 1.2, 0.0, 1.0)
      );
      em += blueCol * bRad;

      // 2. Crisp 0g interior warm cellular filaments
      if (innerCell > 0.002) {
        em += vec3(215.0, 110.0, 55.0) * innerCell * 0.9;
      }

      // 3. Sharp 3D Soot Incandescence Filaments
      if (sootWeight > 0.004) {
        float localTemp = clamp(
          (1.0 - abs(rNorm - 0.50) * 1.55) * hTempDecay + (ridge - 0.5) * 0.24,
          0.05,
          0.96
        );
        float tBlue = max(0.0, (localTemp - 0.38) * 1.6129);
        vec3 sootCol = vec3(
          255.0 * clamp(localTemp * 1.68, 0.35, 1.0),
          234.0 * localTemp * sqrt(localTemp),
          94.0 * tBlue * tBlue
        );
        em += sootCol * sootWeight * 1.3;
      }
    }

    float stepAlpha = 1.0 - exp(-totalDensity * extinctionFactor);
    accColor += transmittance * stepAlpha * em * igniteBoost;
    transmittance *= 1.0 - stepAlpha * 0.80;

    if (transmittance < 0.025) break;
  }

  // Filmic tone-mapping + razor-sharp contrast curve (EMBER palette)
  vec3 flameCol = vec3(1.0) - exp(-accColor / 185.0);
  flameCol = smoothstep(0.015, 0.985, flameCol);
  flameCol *= vec3(0.996, 0.885, 0.985);

  // Ignition spark flash ring
  vec3 spark = vec3(0.0);
  if (uIgnite > 0.01) {
    spark = vec3(0.62, 0.88, 1.0) * exp(-length(vec2(nxScreen, nyScreen)) * 4.8) * uIgnite * 1.15;
  }

  vec3 finalCol = bg * transmittance + flameCol + halo * (0.4 + 0.6 * transmittance) + spark;
  fragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
}
`;

/**
 * Generates a seamlessly tileable RGBA8 3D value-noise texture (size^3 * 4 bytes)
 * using precomputed 1D quintic interpolation LUTs (~4 ms for 32^3).
 */
function buildPeriodicNoise3D(size = 32) {
  let seed = 13374201;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const buildChannel = (freq, out, chOffset) => {
    const f = freq;
    const f2 = f * f;
    const g = new Float32Array(f * f * f);
    for (let i = 0; i < g.length; i++) g[i] = rand();

    const i0 = new Int32Array(size);
    const i1 = new Int32Array(size);
    const w = new Float32Array(size);
    for (let k = 0; k < size; k++) {
      const v = (k * f) / size;
      const fl = Math.floor(v);
      const frac = v - fl;
      i0[k] = fl % f;
      i1[k] = (fl + 1) % f;
      w[k] = frac * frac * frac * (frac * (frac * 6 - 15) + 10);
    }

    let ptr = chOffset;
    for (let z = 0; z < size; z++) {
      const z0 = i0[z] * f2;
      const z1 = i1[z] * f2;
      const tz = w[z];
      for (let y = 0; y < size; y++) {
        const y0 = i0[y] * f;
        const y1 = i1[y] * f;
        const ty = w[y];
        const y0z0 = y0 + z0;
        const y1z0 = y1 + z0;
        const y0z1 = y0 + z1;
        const y1z1 = y1 + z1;
        for (let x = 0; x < size; x++) {
          const x0 = i0[x];
          const x1 = i1[x];
          const tx = w[x];
          const c000 = g[x0 + y0z0];
          const c100 = g[x1 + y0z0];
          const c010 = g[x0 + y1z0];
          const c110 = g[x1 + y1z0];
          const c001 = g[x0 + y0z1];
          const c101 = g[x1 + y0z1];
          const c011 = g[x0 + y1z1];
          const c111 = g[x1 + y1z1];
          const nx00 = c000 + (c100 - c000) * tx;
          const nx10 = c010 + (c110 - c010) * tx;
          const nx01 = c001 + (c101 - c001) * tx;
          const nx11 = c011 + (c111 - c011) * tx;
          const nxy0 = nx00 + (nx10 - nx00) * ty;
          const nxy1 = nx01 + (nx11 - nx01) * ty;
          out[ptr] = ((nxy0 + (nxy1 - nxy0) * tz) * 255) | 0;
          ptr += 4;
        }
      }
    }
  };

  const data = new Uint8Array(size * size * size * 4);
  buildChannel(4, data, 0);
  buildChannel(8, data, 1);
  buildChannel(16, data, 2);
  buildChannel(8, data, 3);
  return data;
}

const SCALE_TIERS = [0.45, 0.58, 0.72, 0.85, 1.0];
const STEP_TIERS = [16, 18, 22, 24, 28];

export class FlameRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.onStats = options.onStats || null;
    this.gl = null;
    this.ctx2d = null;
    this.program = null;
    this.noiseTex = null;
    this.vao = null;
    this.shaders = [];
    this.uniforms = {};
    this.mode = 'none';
    this.isSoftwareGpu = false;

    this.time = 0;
    this.vitality = 1.0;
    this.ignite = 0.0;
    this.speed = 1.0;
    this.running = false;
    this.paused = false;
    this.rafId = null;
    this.lastTs = 0;

    // Backing store tracking (managed exclusively by ResizeObserver — zero per-frame layout reads)
    this.cssWidth = 640;
    this.cssHeight = 440;
    this.tierIndex = 3; // start at 0.85x scale, 24 steps (~60 FPS target)
    this.emaFrameMs = 16.6;
    this.tierCooldown = 0;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.fps = 60;
    this.lastStatsEmit = 0;
    this.sprites2d = null;

    this.state = {
      buoyancy: 0.0,
      shapeBf: 0.0,
      soot: 0.15,
      sootDom: 0.15,
      intensity: 0.9,
      scale: 0.95,
      windNorm: 0.3,
      windX: 0.10,
      windY: 0.0,
      flowDirX: 1.0,
      isCool: 0.0,
      regimeKind: 'sustained',
      fuelIndex: 0,
      geomScale: [1.0, 1.0, 1.0],
    };

    this._initWebGL2();
    if (this.mode === 'none') {
      this._initCanvas2D();
    }
    this._bindResizeObserver();
  }

  _initWebGL2() {
    try {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) return;

      // Detect software renderers so we start immediately in fast tier
      try {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const r = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
          if (/swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(r)) {
            this.isSoftwareGpu = true;
            this.tierIndex = 1; // 0.58x, 18 steps immediately
          }
        }
      } catch {
        // ignore renderer info errors
      }

      const vs = this._compile(gl, gl.VERTEX_SHADER, VERT_SRC);
      const fs = this._compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
      if (!vs || !fs) return;

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('FlameRenderer link error:', gl.getProgramInfoLog(prog));
        return;
      }

      // Upload precomputed 32^3 RGBA8 tileable noise texture
      const NOISE_SIZE = 32;
      const noiseData = buildPeriodicNoise3D(NOISE_SIZE);
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA8,
        NOISE_SIZE,
        NOISE_SIZE,
        NOISE_SIZE,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        noiseData
      );

      this.gl = gl;
      this.program = prog;
      this.noiseTex = tex;
      this.shaders = [vs, fs];
      this.vao = gl.createVertexArray();

      const names = [
        'uNoiseTex',
        'uRes',
        'uTime',
        'uVitality',
        'uShapeBf',
        'uScale',
        'uSootDom',
        'uCool',
        'uIgnite',
        'uFuelMode',
        'uGeomScale',
        'uWind',
        'uFlowDirX',
        'uSteps',
      ];
      for (const n of names) {
        this.uniforms[n] = gl.getUniformLocation(prog, n);
      }

      gl.useProgram(prog);
      gl.uniform1i(this.uniforms.uNoiseTex, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);

      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.stop();
      });

      this.mode = 'webgl2';
    } catch (err) {
      console.warn('WebGL2 unavailable, falling back to Canvas2D:', err);
    }
  }

  _compile(gl, type, src) {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Shader compile error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  _initCanvas2D() {
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    if (!this.ctx2d) return;
    this.mode = 'canvas2d';
    // Pre-bake radial gradient sprites once (zero per-frame gradient allocations)
    const makeSprite = (stops) => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d');
      const rad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
      for (const [off, col] of stops) rad.addColorStop(off, col);
      g.fillStyle = rad;
      g.fillRect(0, 0, 64, 64);
      return c;
    };
    this.sprites2d = {
      blue: makeSprite([
        [0, 'rgba(186, 234, 255, 0.92)'],
        [0.45, 'rgba(34, 155, 255, 0.56)'],
        [0.82, 'rgba(14, 92, 230, 0.18)'],
        [1, 'rgba(14, 92, 230, 0)'],
      ]),
      soot: makeSprite([
        [0, 'rgba(255, 248, 214, 0.96)'],
        [0.36, 'rgba(255, 165, 58, 0.80)'],
        [0.72, 'rgba(232, 68, 24, 0.30)'],
        [1, 'rgba(232, 68, 24, 0)'],
      ]),
      cool: makeSprite([
        [0, 'rgba(155, 185, 255, 0.84)'],
        [0.52, 'rgba(84, 110, 248, 0.44)'],
        [1, 'rgba(42, 60, 195, 0)'],
      ]),
    };
  }

  _bindResizeObserver() {
    const updateSize = (w, h) => {
      if (w > 0 && h > 0) {
        this.cssWidth = w;
        this.cssHeight = h;
        this._syncBackingStore();
        if (this.paused) this.renderFrame();
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          updateSize(width, height);
        }
      });
      this._ro.observe(this.canvas);
    } else {
      this._onWindowResize = () => {
        const rect = this.canvas.getBoundingClientRect();
        updateSize(rect.width, rect.height);
      };
      window.addEventListener('resize', this._onWindowResize);
    }
  }

  _syncBackingStore() {
    const scale = SCALE_TIERS[this.tierIndex] ?? 0.85;
    // Cap effective DPR so Retina 2x screens never render 2M+ volumetric pixels
    const dprCap = this.isSoftwareGpu ? 0.85 : Math.min(window.devicePixelRatio || 1, 1.15);
    let w = Math.max(160, Math.round(this.cssWidth * dprCap * scale));
    let h = Math.max(120, Math.round(this.cssHeight * dprCap * scale));

    // Hard pixel ceiling (~768px on long edge) keeps fragment count bounded on 4K displays
    const maxEdge = Math.round(768 * scale);
    const longEdge = Math.max(w, h);
    if (longEdge > maxEdge) {
      const k = maxEdge / longEdge;
      w = Math.max(160, Math.round(w * k));
      h = Math.max(120, Math.round(h * k));
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _updateAdaptiveQuality(rawDtMs) {
    if (this.mode !== 'webgl2') return;
    // Ignore spikes from tab wake-up (> 120 ms)
    const clampedMs = Math.min(100, Math.max(4, rawDtMs));
    this.emaFrameMs = this.emaFrameMs * 0.88 + clampedMs * 0.12;
    this.tierCooldown++;

    if (this.emaFrameMs > 23.5 && this.tierIndex > 0 && this.tierCooldown >= 14) {
      this.tierIndex--;
      this.tierCooldown = 0;
      this._syncBackingStore();
    } else if (
      !this.isSoftwareGpu &&
      this.emaFrameMs < 13.0 &&
      this.tierIndex < SCALE_TIERS.length - 1 &&
      this.tierCooldown >= 45
    ) {
      this.tierIndex++;
      this.tierCooldown = 0;
      this._syncBackingStore();
    }
  }

  setPhysics(vis) {
    this.state = { ...this.state, ...vis };
    if (this.paused) {
      this.renderFrame();
    }
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Math.min(3.0, Number(speed) || 1.0));
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      this.stop();
      this.renderFrame();
    } else {
      this.start();
    }
  }

  triggerIgnite() {
    this.ignite = 1.0;
    this.vitality = 1.0;
    if (this.paused) this.renderFrame();
  }

  getStats() {
    return {
      mode: this.mode,
      fps: Math.round(this.fps),
      scale: SCALE_TIERS[this.tierIndex],
      steps: STEP_TIERS[this.tierIndex],
      paused: this.paused,
      vitality: this.vitality,
    };
  }

  start() {
    if (this.running || this.paused) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
    }
    this._syncBackingStore();
    this.running = true;
    this.lastTs = performance.now();
    this.fpsAcc = 0;
    this.fpsFrames = 0;

    const tick = (now) => {
      if (!this.running) return;
      const rawDtMs = now - this.lastTs;
      this.lastTs = now;

      const rawDt = Math.max(0.001, rawDtMs / 1000);
      const dt = Math.min(0.05, rawDt);
      this.time += dt * this.speed;
      if (this.ignite > 0) this.ignite = Math.max(0, this.ignite - dt * 2.4);

      // Smooth EMBER vitality response by combustion regime
      const rk = this.state.regimeKind;
      if (rk === 'sustained' || rk === 'cool') {
        this.vitality += (1.0 - this.vitality) * Math.min(1, dt * 3.0);
      } else if (rk === 'quiescent') {
        this.vitality += (0.55 - this.vitality) * Math.min(1, dt * 1.4);
      } else {
        this.vitality = Math.max(0.0, this.vitality - dt / 0.9);
      }

      this.renderFrame();
      this._updateAdaptiveQuality(rawDtMs);

      this.fpsAcc += rawDt;
      this.fpsFrames++;
      if (this.fpsAcc >= 0.5) {
        this.fps = Math.min(120, this.fpsFrames / this.fpsAcc);
        this.fpsAcc = 0;
        this.fpsFrames = 0;
        if (this.onStats && now - this.lastStatsEmit >= 450) {
          this.lastStatsEmit = now;
          this.onStats(this.getStats());
        }
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  renderFrame() {
    if (this.mode === 'webgl2') this._renderWebGL2();
    else if (this.mode === 'canvas2d') this._render2D();
  }

  _renderWebGL2() {
    const gl = this.gl;
    if (!gl || !this.program) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return;

    const u = this.uniforms;
    const st = this.state;
    const vit = Math.max(0, Math.min(1, this.vitality * Math.max(0.25, st.intensity)));
    const scale = (st.scale || 0.95) * (0.48 + 0.52 * Math.max(0.15, this.vitality));
    const gs = st.geomScale || [1.0, 1.0, 1.0];

    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTex);

    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uVitality, vit);
    gl.uniform1f(u.uShapeBf, st.shapeBf ?? st.buoyancy ?? 0);
    gl.uniform1f(u.uScale, scale);
    gl.uniform1f(u.uSootDom, st.sootDom ?? st.soot ?? 0.15);
    gl.uniform1f(u.uCool, st.isCool ?? 0);
    gl.uniform1f(u.uIgnite, this.ignite);
    gl.uniform1f(u.uFuelMode, st.fuelIndex ?? 0);
    gl.uniform3f(u.uGeomScale, gs[0], gs[1], gs[2]);
    gl.uniform2f(u.uWind, st.windX ?? st.windNorm * 0.32, st.windY ?? 0);
    gl.uniform1f(u.uFlowDirX, st.flowDirX ?? 1.0);
    gl.uniform1i(u.uSteps, STEP_TIERS[this.tierIndex] ?? 22);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _render2D() {
    const ctx = this.ctx2d;
    if (!ctx || !this.sprites2d) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#050812';
    ctx.fillRect(0, 0, w, h);

    const st = this.state;
    const vit = Math.max(0, Math.min(1, this.vitality));
    if (vit <= 0.02) return;

    const cx = w * 0.5 + (st.windNorm || 0) * w * 0.09;
    const cy = h * (0.56 + 0.10 * (st.shapeBf || 0));
    const r = Math.min(w, h) * 0.22 * (st.scale || 0.95) * (0.55 + 0.45 * vit);
    const stretchY = 1.0 + (st.shapeBf || 0) * 1.15;
    const sprite = st.isCool > 0.5 ? this.sprites2d.cool : st.soot > 0.42 ? this.sprites2d.soot : this.sprites2d.blue;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const ph = this.time * (2.6 + i * 0.7) + i * 1.57;
      const dx = Math.sin(ph) * r * (0.06 + 0.08 * (st.shapeBf || 0));
      const dy = -i * r * 0.24 * (st.shapeBf || 0);
      const s = r * (1.45 - i * 0.22);
      ctx.globalAlpha = vit * (0.62 - i * 0.10);
      ctx.drawImage(sprite, cx + dx - s, cy + dy - s * stretchY, s * 2, s * 2 * stretchY);
    }
    ctx.restore();
  }

  dispose() {
    this.stop();
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
      this._onWindowResize = null;
    }
    if (this.gl) {
      const gl = this.gl;
      if (this.noiseTex) gl.deleteTexture(this.noiseTex);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
      for (const s of this.shaders) gl.deleteShader(s);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.gl = null;
    }
  }
}
