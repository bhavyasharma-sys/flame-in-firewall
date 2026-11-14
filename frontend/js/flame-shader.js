/**
 * EMBER-inspired WebGL2 Volumetric Raymarched Flame Renderer (GLSL 300 es)
 * with graceful high-fidelity Canvas2D volumetric fallback.
 */

const VERT_SRC = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
  vUv = POS[gl_VertexID] * 0.5 + 0.5;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uBuoyancy;     // 0.0 = 0g spherical, 1.0 = 1g teardrop plume
uniform float uSoot;         // 0.0 = pure blue CH*, 1.0 = luminous yellow-orange soot
uniform float uIntensity;    // overall flame vigor
uniform float uWind;         // normalized crossflow 0..1
uniform float uCool;         // 1.0 = FLEX-2 low-temp cool flame
uniform float uIgnite;       // 0..1 ignition flash envelope
uniform float uFuelMode;     // 0 droplet, 1 gas jet, 2 PMMA rod, 3 flat sheet

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash31(i + vec3(0,0,0));
  float n100 = hash31(i + vec3(1,0,0));
  float n010 = hash31(i + vec3(0,1,0));
  float n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1));
  float n101 = hash31(i + vec3(1,0,1));
  float n011 = hash31(i + vec3(0,1,1));
  float n111 = hash31(i + vec3(1,1,1));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.52;
  for (int i = 0; i < 4; i++) {
    v += a * noise3(p);
    p = p * 2.06 + vec3(11.3, 4.7, 7.9);
    a *= 0.5;
  }
  return v;
}

vec3 blackbodyColor(float t, float soot, float cool) {
  // Cool flame: deep sapphire-violet spectral signature
  vec3 coolCol = mix(vec3(0.08, 0.22, 0.95), vec3(0.45, 0.72, 1.0), smoothstep(0.15, 0.95, t));

  // Blue CH* chemiluminescence core
  vec3 blueCol = mix(vec3(0.05, 0.35, 1.0), vec3(0.42, 0.85, 1.0), smoothstep(0.1, 0.9, t));

  // Soot incandescence ramp: deep red -> orange -> golden -> incandescent white
  vec3 sootCol = vec3(0.95, 0.16, 0.02);
  sootCol = mix(sootCol, vec3(1.0, 0.50, 0.06), smoothstep(0.18, 0.55, t));
  sootCol = mix(sootCol, vec3(1.0, 0.88, 0.45), smoothstep(0.55, 0.85, t));
  sootCol = mix(sootCol, vec3(1.0, 0.99, 0.92), smoothstep(0.85, 1.0, t));

  vec3 hot = mix(blueCol, sootCol, clamp(soot, 0.0, 1.0));
  return mix(hot, coolCol, clamp(cool, 0.0, 1.0));
}

float evalFlameDensity(vec3 p, out float heatOut, out float shellOut) {
  // Apply crossflow tilt (wind pushes right in +x proportional to height & distance)
  float lift = max(0.0, p.y + 0.35);
  float windShear = uWind * (0.42 + 0.55 * (1.0 - 0.5 * uBuoyancy));
  p.x -= windShear * lift * (0.6 + 0.55 * lift);

  // Fuel geometry shaping
  vec3 q = p;
  if (uFuelMode > 2.5) {
    // Flat sheet (SAFFIRE) — wider flame sheet
    q.x *= 0.62;
    q.z *= 1.45;
  } else if (uFuelMode > 1.5) {
    // PMMA rod (BASS-II) — elongated horizontal/vertical cylinder envelope
    q.x *= 0.82;
  } else if (uFuelMode > 0.5) {
    // Gas jet (ACME) — taller slender nozzle jet
    q.x *= 1.25;
    q.z *= 1.25;
    q.y -= 0.15;
  }

  // Morph smoothly between 0g sphere and 1g teardrop plume
  float b = clamp(uBuoyancy, 0.0, 1.0);
  float scaleY = mix(1.0, 0.50, b);
  float taper = mix(1.0, 1.0 + max(0.0, q.y + 0.25) * 0.95, b);

  vec3 sp = vec3(q.x * taper, (q.y - 0.28 * b) * scaleY, q.z * taper);

  // Turbulent advection upward + downwind
  float speed = mix(0.65, 2.75, b) + uWind * 1.4;
  vec3 adv = vec3(
    q.x * 2.5 - uWind * uTime * 2.2,
    q.y * 2.4 - uTime * speed,
    q.z * 2.5
  );
  float turb = fbm(adv) - 0.5;
  float turbAmp = mix(0.10, 0.28, b) + uWind * 0.14;
  sp.xz += turb * turbAmp * (0.45 + lift);

  float radius = mix(0.48, 0.54, clamp(uIntensity * 0.65, 0.0, 1.0));
  float dist = length(sp);

  // Microgravity spherical hollow-ish blue reaction shell vs 1g filled buoyant core
  float shellFactor = (1.0 - b) * (1.0 - 0.35 * uCool);
  float shell = exp(-pow((dist - radius * 0.68) / 0.19, 2.0));
  float core = smoothstep(radius, radius * 0.12, dist);

  float density = mix(core, mix(core * 0.45, shell * 1.25, 0.72), shellFactor);
  density *= smoothstep(-0.62, -0.25, p.y + 0.2 * (1.0 - b));

  // Cut out tiny fuel droplet/holder center in 0g droplet/rod mode
  if (uFuelMode < 0.5) {
    density *= smoothstep(0.08, 0.17, length(p));
  }

  float innerHeat = smoothstep(radius * 1.05, 0.05, dist) + 0.35 * turb;
  heatOut = clamp(innerHeat * mix(1.0, 0.55, uCool), 0.0, 1.0);
  shellOut = clamp(shell * shellFactor, 0.0, 1.0);
  return max(0.0, density) * uIntensity;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);

  // Camera slightly elevated, gently breathing
  vec3 ro = vec3(0.0, 0.08, 2.45);
  vec3 rd = normalize(vec3(uv, -1.65));

  // Subtle background scientific chamber vignette & micro-grid
  float vig = 1.0 - 0.52 * dot(uv, uv);
  vec3 bg = vec3(0.020, 0.030, 0.055) * max(0.2, vig);

  // Subtle chamber reticle grid
  vec2 g = abs(fract(uv * 6.0 - 0.5) - 0.5) / fwidth(uv * 6.0);
  float gridLine = 1.0 - min(min(g.x, g.y), 1.0);
  bg += vec3(0.04, 0.09, 0.14) * gridLine * 0.22;

  // Draw physical fuel holder silhouette (subtle metallic sphere/nozzle/rod/sheet)
  float holderGlow = 0.0;
  if (uFuelMode < 0.5) {
    // Droplet on fiber needle
    float d = length(uv - vec2(0.0, -0.02));
    if (d < 0.048) bg = mix(bg, vec3(0.32, 0.24, 0.18), smoothstep(0.048, 0.032, d));
    float fiber = smoothstep(0.005, 0.001, abs(uv.y + 0.02)) * smoothstep(0.45, 0.05, abs(uv.x));
    bg += vec3(0.18, 0.22, 0.28) * fiber * 0.55;
  } else if (uFuelMode < 1.5) {
    // Gas burner nozzle below
    if (abs(uv.x) < 0.065 && uv.y < -0.18 && uv.y > -0.58) {
      bg = vec3(0.16, 0.20, 0.27) * (0.7 + 0.3 * (1.0 - abs(uv.x) / 0.065));
    }
  } else if (uFuelMode < 2.5) {
    // PMMA rod
    if (abs(uv.x) < 0.038 && uv.y < -0.06 && uv.y > -0.52) {
      bg = vec3(0.28, 0.36, 0.44) * 0.65;
    }
  } else {
    // SAFFIRE flat sheet sample frame
    if (abs(uv.x) < 0.24 && uv.y < -0.20 && uv.y > -0.25) {
      bg = vec3(0.26, 0.28, 0.32);
    }
  }

  // 44-step volumetric raymarch through bounding box z in [-1.1, 1.1]
  vec3 accum = vec3(0.0);
  float trans = 1.0;
  float tMin = 1.30;
  float tMax = 3.55;
  const int STEPS = 44;
  float dt = (tMax - tMin) / float(STEPS);

  // Jitter ray start to eliminate banding
  float jitter = hash31(vec3(gl_FragCoord.xy, fract(uTime * 17.3))) * dt;
  float t = tMin + jitter;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    if (abs(p.x) < 1.35 && abs(p.y) < 1.35 && abs(p.z) < 1.15) {
      float heat = 0.0;
      float shell = 0.0;
      float dens = evalFlameDensity(p, heat, shell);

      if (dens > 0.002) {
        // Blue base / outer shell emission + inner soot body
        float localSoot = uSoot * smoothstep(-0.22, 0.48, p.y + 0.12 * uBuoyancy) * (1.0 - 0.85 * shell);
        vec3 col = blackbodyColor(heat, localSoot, uCool);

        // Extra cyan chemiluminescence rim in microgravity
        col += vec3(0.08, 0.55, 1.0) * shell * 0.65 * (1.0 - 0.5 * uCool);

        float alpha = 1.0 - exp(-dens * dt * 3.15);
        accum += trans * col * alpha * (2.15 + 1.1 * uIgnite);
        trans *= (1.0 - alpha * 0.72);
        if (trans < 0.02) break;
      }
    }
    t += dt;
  }

  // Ignition spark flash ring
  if (uIgnite > 0.01) {
    float spark = exp(-length(uv) * 7.5) * uIgnite * 1.4;
    accum += vec3(0.65, 0.88, 1.0) * spark;
  }

  // Soft ambient halo glow around flame center
  float haloD = length(uv - vec2(uWind * 0.12, 0.08 * uBuoyancy));
  vec3 haloCol = mix(vec3(0.08, 0.45, 0.95), vec3(0.98, 0.45, 0.12), uSoot);
  haloCol = mix(haloCol, vec3(0.18, 0.35, 0.95), uCool);
  accum += haloCol * exp(-haloD * 3.4) * 0.24 * clamp(uIntensity, 0.0, 1.2);

  vec3 color = bg * trans + accum;

  // ACES-like filmic tone mapping
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;

export class FlameRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.ctx2d = null;
    this.program = null;
    this.uniforms = {};
    this.mode = 'none';
    this.time = 0;
    this.ignite = 0;
    this.speed = 1.0;
    this.running = false;
    this.rafId = null;
    this.lastTs = 0;
    this.state = {
      buoyancy: 0.0,
      soot: 0.15,
      intensity: 0.9,
      windNorm: 0.3,
      isCool: 0.0,
      fuelIndex: 0,
    };

    this._initWebGL2();
    if (this.mode === 'none') {
      this._initCanvas2D();
    }
  }

  _initWebGL2() {
    try {
      const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!gl) return;
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
      this.gl = gl;
      this.program = prog;
      this.vao = gl.createVertexArray();
      const names = [
        'uResolution', 'uTime', 'uBuoyancy', 'uSoot',
        'uIntensity', 'uWind', 'uCool', 'uIgnite', 'uFuelMode',
      ];
      for (const n of names) {
        this.uniforms[n] = gl.getUniformLocation(prog, n);
      }
      this.mode = 'webgl2';
    } catch (err) {
      console.warn('WebGL2 unavailable, falling back to Canvas2D:', err);
    }
  }

  _compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Shader compile error:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  _initCanvas2D() {
    this.ctx2d = this.canvas.getContext('2d');
    if (this.ctx2d) this.mode = 'canvas2d';
  }

  setPhysics(vis) {
    this.state = { ...this.state, ...vis };
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Math.min(3.0, Number(speed) || 1.0));
  }

  triggerIgnite() {
    this.ignite = 1.0;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTs = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.lastTs) / 1000);
      this.lastTs = now;
      this.time += dt * this.speed;
      if (this.ignite > 0) this.ignite = Math.max(0, this.ignite - dt * 2.2);
      this.resize();
      if (this.mode === 'webgl2') this._renderWebGL2();
      else if (this.mode === 'canvas2d') this._render2D();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _renderWebGL2() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.uTime, this.time);
    gl.uniform1f(this.uniforms.uBuoyancy, this.state.buoyancy);
    gl.uniform1f(this.uniforms.uSoot, this.state.soot);
    gl.uniform1f(this.uniforms.uIntensity, this.state.intensity);
    gl.uniform1f(this.uniforms.uWind, this.state.windNorm);
    gl.uniform1f(this.uniforms.uCool, this.state.isCool);
    gl.uniform1f(this.uniforms.uIgnite, this.ignite);
    gl.uniform1f(this.uniforms.uFuelMode, this.state.fuelIndex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _render2D() {
    const ctx = this.ctx2d;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#050812';
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5 + this.state.windNorm * w * 0.08;
    const cy = h * 0.56;
    const r = Math.min(w, h) * 0.19 * Math.max(0.4, this.state.intensity);
    const stretchY = 1 + this.state.buoyancy * 1.15;
    const wobble = Math.sin(this.time * 5.2) * 5;

    ctx.save();
    ctx.translate(cx + wobble, cy);
    ctx.scale(1, stretchY);
    const grad = ctx.createRadialGradient(0, -r * 0.15, r * 0.08, 0, 0, r * 1.4);
    if (this.state.isCool > 0.5) {
      grad.addColorStop(0, 'rgba(147, 197, 253, 0.85)');
      grad.addColorStop(0.55, 'rgba(59, 130, 246, 0.45)');
      grad.addColorStop(1, 'rgba(30, 64, 175, 0)');
    } else if (this.state.soot > 0.45) {
      grad.addColorStop(0, 'rgba(255, 250, 220, 0.95)');
      grad.addColorStop(0.4, 'rgba(251, 146, 60, 0.82)');
      grad.addColorStop(0.75, 'rgba(239, 68, 68, 0.35)');
      grad.addColorStop(1, 'rgba(239, 68, 68, 0)');
    } else {
      grad.addColorStop(0, 'rgba(186, 230, 253, 0.92)');
      grad.addColorStop(0.55, 'rgba(14, 165, 233, 0.58)');
      grad.addColorStop(1, 'rgba(6, 182, 212, 0)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
