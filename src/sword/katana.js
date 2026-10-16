// Procedural Nichirin-style katana (no external asset needed), with an optional
// GLB override: drop a model at public/models/katana.glb and it is used instead.
// Local axes: +Y runs from pommel to tip, the edge faces +X, flat sides face ±Z.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const BLADE_START = 0.235;
export const BLADE_LEN = 1.5;
const SORI = 0.07; // blade curvature

// ---------------------------------------------------------------- dissolve
// Shared uniforms for the materialisation effect: a glowing front sweeps from
// pommel to tip, noisy at the boundary.
export function makeRevealUniforms() {
  return {
    uReveal: { value: 0 },
    uEdgeColor: { value: new THREE.Color(1, 0.7, 0.3) },
    uTime: { value: 0 },
  };
}

function applyReveal(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vLocal;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vLocal = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `
        uniform float uReveal; uniform vec3 uEdgeColor; uniform float uTime;
        varying vec3 vLocal;
        float rvHash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        float rvNoise(vec3 p){
          vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
          float n000 = rvHash(i), n100 = rvHash(i+vec3(1,0,0)), n010 = rvHash(i+vec3(0,1,0)), n110 = rvHash(i+vec3(1,1,0));
          float n001 = rvHash(i+vec3(0,0,1)), n101 = rvHash(i+vec3(1,0,1)), n011 = rvHash(i+vec3(0,1,1)), n111 = rvHash(i+vec3(1,1,1));
          return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y), mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
        }
        void main() {`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float rvFront = mix(-0.45, 2.1, uReveal);
        float rvN = rvNoise(vLocal * 14.0 + vec3(0.0, uTime * 0.6, 0.0)) * 0.22;
        float rvD = rvFront - (vLocal.y + rvN);
        if (rvD < 0.0 && uReveal < 0.999) discard;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uReveal < 0.999) {
          float rvEdge = smoothstep(0.16, 0.0, rvD);
          totalEmissiveRadiance += uEdgeColor * rvEdge * 5.0;
        }`);
  };
  material.customProgramCacheKey = () => 'reveal-v1';
}

// ---------------------------------------------------------------- textures
function bladeEmissiveTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  // hamon: wavy temper line close to the edge (v≈0.1 and v≈0.9)
  for (const base of [0.1, 0.9]) {
    g.beginPath();
    for (let x = 0; x <= c.width; x += 4) {
      const t = x / c.width;
      const wave = Math.sin(t * 38) * 0.018 + Math.sin(t * 91 + 1.3) * 0.01 + Math.sin(t * 17) * 0.012;
      const y = (base + (base < 0.5 ? 1 : -1) * wave) * c.height;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.lineWidth = 9;
    g.strokeStyle = '#ffffff';
    g.shadowColor = '#ffffff';
    g.shadowBlur = 14;
    g.stroke();
  }
  // soft glow along the edge
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.0)');
  grad.addColorStop(0.82, 'rgba(255,255,255,0.0)');
  grad.addColorStop(1, 'rgba(255,255,255,0.55)');
  g.shadowBlur = 0;
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}

function wrapTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#12141a';
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#2d3342';
  g.lineWidth = 7;
  for (let y = -128; y < 384; y += 32) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(64, y + 32); g.lineTo(128, y); g.stroke();
    g.beginPath(); g.moveTo(0, y + 32); g.lineTo(64, y); g.lineTo(128, y + 32); g.stroke();
  }
  g.strokeStyle = '#06070a';
  g.lineWidth = 2;
  for (let y = -128; y < 384; y += 32) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(64, y + 32); g.lineTo(128, y); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------- geometry
function bladeCurveX(t) { return -SORI * t * t; }

function buildBladeGeometry(widthScale = 1) {
  const N = 48;
  const prof = 6; // ring vertices (first duplicated for the UV seam)
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = BLADE_START + t * BLADE_LEN;
    const cx = bladeCurveX(t);
    const taper = 1 - 0.28 * t;
    // kissaki (tip): collapse the last few percent to a point
    const tip = t > 0.95 ? Math.max(0.0, 1 - (t - 0.95) / 0.05) : 1;
    const w = 0.082 * widthScale * taper * tip;       // total width
    const th = 0.021 * (1 - 0.35 * t) * tip;          // thickness
    const tipLift = t > 0.95 ? 0.02 * (1 - tip) : 0;
    const ring = [
      [cx + w * 0.5, y + tipLift * 1.4, 0],           // edge
      [cx + w * 0.12, y, th * 0.5],                    // shinogi (ridge) upper
      [cx - w * 0.5, y, th * 0.36],                    // spine upper
      [cx - w * 0.5, y, -th * 0.36],                   // spine lower
      [cx + w * 0.12, y, -th * 0.5],                   // shinogi lower
      [cx + w * 0.5, y + tipLift * 1.4, 0],           // edge again (seam)
    ];
    const vv = [0, 0.3, 0.55, 0.7, 0.88, 1.0];
    ring.forEach((p, j) => { pos.push(p[0], p[1], p[2]); uv.push(t, vv[j]); });
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < prof - 1; j++) {
      const a = i * prof + j, b = a + 1, c = a + prof, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** radial profile per style → tsuba silhouette (creative interpretation, see docs) */
const TSUBA_PROFILES = {
  flame: (a) => 0.095 * (1 + 0.28 * Math.max(0, Math.sin(a * 8)) ** 0.7) - 0.0,
  water: (a) => 0.1 * (1 + 0.1 * Math.sin(a * 12)),
  insect: (a) => 0.1 * (0.68 + 0.5 * Math.abs(Math.cos(a * 2)) ** 1.5 * (Math.sin(a) > 0 ? 1 : 0.8)),
  thunder: (a) => 0.095 * (1 + 0.2 * (Math.abs(((a * 8) / (Math.PI * 2)) % 1 - 0.5) * 2)),
};

function buildTsubaGeometry(style) {
  const shape = new THREE.Shape();
  const prof = TSUBA_PROFILES[style] || TSUBA_PROFILES.water;
  const n = 96;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = prof(a);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  const hole = new THREE.Path();
  hole.absellipse(0, 0, 0.04, 0.016, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 24 });
  g.translate(0, 0, -0.007);
  g.rotateX(-Math.PI / 2); // plate normal → blade axis (+Y); disc lies in XZ
  g.scale(1, 1, 1);
  return g;
}

// ---------------------------------------------------------------- katana
export class Katana {
  constructor() {
    this.group = new THREE.Group();     // origin = centre of the grip
    this.uniforms = makeRevealUniforms();
    this.tipLocal = new THREE.Vector3(bladeCurveX(1) + 0.0, BLADE_START + BLADE_LEN, 0);
    this.baseLocal = new THREE.Vector3(0, BLADE_START + 0.02, 0);
    this.midLocal = new THREE.Vector3(bladeCurveX(0.5), BLADE_START + BLADE_LEN * 0.5, 0);
    this.usingGlb = false;

    this.emissiveTex = bladeEmissiveTexture();
    this.bladeMat = new THREE.MeshPhysicalMaterial({
      color: 0xb9c0cc, metalness: 1, roughness: 0.17, clearcoat: 0.35, clearcoatRoughness: 0.2,
      emissive: new THREE.Color(0xffffff), emissiveMap: this.emissiveTex, emissiveIntensity: 0.0,
      side: THREE.DoubleSide, envMapIntensity: 1.1,
    });
    this.fittingMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.9, roughness: 0.35, side: THREE.DoubleSide });
    this.goldMat = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.28, side: THREE.DoubleSide });
    this.wrapMat = new THREE.MeshStandardMaterial({ map: wrapTexture(), roughness: 0.75, metalness: 0.05 });
    for (const m of [this.bladeMat, this.fittingMat, this.goldMat, this.wrapMat]) applyReveal(m, this.uniforms);

    this._build();
    this.setStyle('flame', true);
  }

  _build() {
    const blade = new THREE.Mesh(buildBladeGeometry(1), this.bladeMat);
    this.blade = blade;
    this.group.add(blade);

    const tsuka = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.033, 0.46, 20, 1), this.wrapMat);
    tsuka.scale.set(1, 1, 0.82);
    tsuka.position.y = -0.0;
    this.group.add(tsuka);
    this.tsuka = tsuka;

    const kashira = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.034, 0.03, 20), this.goldMat);
    kashira.position.y = -0.245;
    kashira.scale.set(1, 1, 0.85);
    this.group.add(kashira);

    const fuchi = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.034, 0.03, 20), this.goldMat);
    fuchi.position.y = 0.2;
    fuchi.scale.set(1, 1, 0.85);
    this.group.add(fuchi);

    this.tsubaGeoms = {};
    this.tsuba = new THREE.Mesh(new THREE.BufferGeometry(), this.fittingMat);
    this.tsuba.position.y = 0.225;
    this.group.add(this.tsuba);

    const habaki = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.05, 0.026), this.goldMat);
    habaki.position.y = BLADE_START + 0.025;
    this.group.add(habaki);
    this.habaki = habaki;
  }

  setStyle(id, immediate = false) {
    this.styleId = id;
    if (!this.tsubaGeoms[id]) this.tsubaGeoms[id] = buildTsubaGeometry(id);
    this.tsuba.geometry = this.tsubaGeoms[id];
    // The blade width differs slightly per style: Insect is the slimmest.
    const w = id === 'insect' ? 0.78 : id === 'flame' ? 1.1 : 1;
    this.blade.scale.set(w, 1, 1);
    // blade scale in X shifts the curve centre: keep tip aligned
    this.tipLocal.x = bladeCurveX(1) * w;
    this.midLocal.x = bladeCurveX(0.5) * w;
    this.baseLocal.x = 0;
    if (!immediate) this._styleChanged = true;
  }

  /** try the optional GLB. Resolves true if a model was loaded. */
  async tryLoadGlb(url) {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const type = head.headers.get('content-type') || '';
      if (!head.ok || type.includes('text/html')) return false;
      const gltf = await new GLTFLoader().loadAsync(url);
      const model = gltf.scene;
      // normalise: longest dimension = full sword length, centred on origin
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const s = 1.95 / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(s);
      box.setFromObject(model);
      const c = box.getCenter(new THREE.Vector3());
      model.position.sub(c).add(new THREE.Vector3(0, 0.85, 0));
      model.traverse((o) => { if (o.isMesh) applyReveal(o.material, this.uniforms); });
      this.group.clear();
      this.group.add(model);
      this.usingGlb = true;
      return true;
    } catch (e) {
      console.warn('katana.glb not loaded, using procedural katana', e);
      return false;
    }
  }

  /** Nichirin colour wash: steel → style colour as the sword is "gripped". */
  applyTint(styleDef, amount) {
    const steel = _steel;
    this.bladeMat.color.copy(steel).lerp(_c1.set(styleDef.blade.color), amount * 0.55);
    this.bladeMat.emissive.set(styleDef.blade.emissive);
    this.bladeMat.emissiveIntensity = styleDef.blade.emissiveIntensity * amount * (0.4 + 0.6);
    this.uniforms.uEdgeColor.value.setRGB(styleDef.mid[0], styleDef.mid[1], styleDef.mid[2]);
  }

  setReveal(v, time) {
    this.uniforms.uReveal.value = v;
    this.uniforms.uTime.value = time;
    this.group.visible = v > 0.001;
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); });
    for (const g of Object.values(this.tsubaGeoms)) g.dispose();
    for (const m of [this.bladeMat, this.fittingMat, this.goldMat, this.wrapMat]) {
      m.map?.dispose?.();
      m.dispose();
    }
    this.emissiveTex.dispose();
  }
}

const _steel = new THREE.Color(0xb9c0cc);
const _c1 = new THREE.Color();
