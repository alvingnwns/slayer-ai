// Renderer, camera, post-processing and the camera/dark background.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const CAM_Z = 6;
const FOV = 40;

const BG_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;
const BG_FRAG = /* glsl */ `
  uniform sampler2D uVideo;
  uniform float uHasVideo;
  uniform vec2 uScale;     // cover-fit scale (uv space)
  uniform float uDim;      // 0..1 darkening toward the sword
  uniform float uTime;
  uniform vec3 uTint;
  varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 col;
    if (uHasVideo > 0.5) {
      vec2 uv = (vUv - 0.5) * uScale + 0.5;
      uv.x = 1.0 - uv.x;                       // selfie mirror
      col = texture2D(uVideo, uv).rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 0.8);            // slightly desaturate
      col *= mix(0.78, 0.38, uDim);            // keep VFX readable
      col += uTint * 0.03 * uDim;
    } else {
      float g = smoothstep(1.1, 0.0, length((vUv - vec2(0.5, 0.42)) * vec2(1.3, 1.0)));
      col = mix(vec3(0.008, 0.009, 0.014), vec3(0.045, 0.05, 0.075), g);
      col += uTint * 0.05 * uDim * g;
    }
    float v = smoothstep(0.95, 0.25, length(vUv - 0.5));
    col *= mix(0.55, 1.0, v);
    col += (hash(vUv * 900.0 + uTime) - 0.5) * 0.012;   // film grain
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

// Local heat-haze: warps what is already rendered around the blade segment.
const HeatShader = {
  uniforms: {
    tDiffuse: { value: null },
    uA: { value: new THREE.Vector2() },
    uB: { value: new THREE.Vector2() },
    uRadius: { value: 0.12 },
    uStrength: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uA; uniform vec2 uB;
    uniform float uRadius; uniform float uStrength; uniform float uTime; uniform float uAspect;
    varying vec2 vUv;
    float n(vec2 p){ return sin(p.x) * cos(p.y); }
    void main() {
      vec2 uv = vUv;
      if (uStrength > 0.0005) {
        vec2 p = vec2(uv.x * uAspect, uv.y);
        vec2 a = vec2(uA.x * uAspect, uA.y);
        vec2 b = vec2(uB.x * uAspect, uB.y);
        vec2 ab = b - a;
        float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
        float d = length(p - (a + ab * t));
        float fall = smoothstep(uRadius, 0.0, d);
        vec2 q = p * 38.0;
        vec2 w = vec2(n(q + vec2(0.0, -uTime * 7.0)) + 0.5 * n(q * 2.1 + uTime * 3.0),
                      n(q.yx + vec2(uTime * 5.0, 0.0)));
        uv += w * uStrength * fall * 0.012 * vec2(1.0, 1.4);
      }
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `,
};

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.maxPixelRatio = 1.75;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
    this.camera.position.set(0, 0, CAM_Z);
    this.basePos = new THREE.Vector3(0, 0, CAM_Z);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    // --- background (camera feed or dark gradient)
    this.videoTexture = null;
    this.bgUniforms = {
      uVideo: { value: null },
      uHasVideo: { value: 0 },
      uScale: { value: new THREE.Vector2(1, 1) },
      uDim: { value: 0 },
      uTime: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
    };
    this.bg = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.bgUniforms, vertexShader: BG_VERT, fragmentShader: BG_FRAG,
        depthTest: false, depthWrite: false,
      }),
    );
    this.bg.frustumCulled = false;
    this.bg.renderOrder = -1000;
    this.scene.add(this.bg);

    // --- flash overlay (thunder impact)
    this.flashMat = new THREE.ShaderMaterial({
      uniforms: { uAmount: { value: 0 }, uColor: { value: new THREE.Color(1, 0.95, 0.7) } },
      vertexShader: BG_VERT.replace('0.9999', '0.0'),
      fragmentShader: `uniform float uAmount; uniform vec3 uColor; varying vec2 vUv;
        void main(){ float v = 1.0 - 0.55 * length(vUv - 0.5); gl_FragColor = vec4(uColor * uAmount * v, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.flashMat);
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 1000;
    this.flashMat.visible = false;
    this.scene.add(this.flash);
    this._flash = 0;

    // --- post
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.heatPass = new ShaderPass(HeatShader);
    this.composer.addPass(this.heatPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.88);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.bloomEnabled = true;

    this.width = 1;
    this.height = 1;
    this.halfH = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAM_Z;
    this.halfW = this.halfH;
    this.aspect = 1;
    this.videoAspect = 16 / 9;
    this._shake = { amp: 0, t: 0, dur: 0 };
    this.time = 0;
    this._tmpV = new THREE.Vector3();

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  get viewHeightWorld() { return this.halfH * 2; }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.halfW = this.halfH * this.aspect;
    this.heatPass.uniforms.uAspect.value = this.aspect;
    this._updateCover();
  }

  setQuality(q) {
    this.maxPixelRatio = q === 'low' ? 1.0 : 1.75;
    this.bloomEnabled = q !== 'low';
    this.bloom.enabled = this.bloomEnabled;
    this.resize();
  }

  setBloom(on) { this.bloom.enabled = on && this.bloomEnabled; }

  _updateCover() {
    // object-fit: cover for the background quad
    const va = this.videoAspect;
    const sa = this.aspect;
    if (sa > va) this.bgUniforms.uScale.value.set(1, va / sa);
    else this.bgUniforms.uScale.value.set(sa / va, 1);
  }

  setVideo(video, aspect) {
    if (!video) {
      this.bgUniforms.uHasVideo.value = 0;
      return;
    }
    if (!this.videoTexture || this.videoTexture.image !== video) {
      this.videoTexture?.dispose();
      this.videoTexture = new THREE.VideoTexture(video);
      this.videoTexture.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.generateMipmaps = false;
      this.bgUniforms.uVideo.value = this.videoTexture;
    }
    this.videoAspect = aspect || 16 / 9;
    this._updateCover();
    this.bgUniforms.uHasVideo.value = 1;
  }

  /** normalised video coords (un-mirrored) → NDC of the screen, honouring cover fit + mirror */
  videoToNdc(nx, ny, out = { x: 0, y: 0 }) {
    const u = 1 - nx;
    const s = this.bgUniforms.uScale.value;
    out.x = (u - 0.5) * 2 / s.x;
    out.y = -(ny - 0.5) * 2 / s.y;
    return out;
  }

  ndcToWorld(x, y, z = 0, out = new THREE.Vector3()) {
    const k = (CAM_Z - z) / CAM_Z;
    return out.set(x * this.halfW * k, y * this.halfH * k, z);
  }

  worldToUv(v, out = { x: 0, y: 0 }) {
    this._tmpV.copy(v).project(this.camera);
    out.x = this._tmpV.x * 0.5 + 0.5;
    out.y = this._tmpV.y * 0.5 + 0.5;
    return out;
  }

  shake(amp, dur = 0.25) {
    this._shake.amp = Math.max(this._shake.amp * (this._shake.t < this._shake.dur ? 1 : 0), amp);
    this._shake.t = 0;
    this._shake.dur = dur;
  }

  addFlash(amount) { this._flash = Math.max(this._flash, amount); }

  setHeat(a, b, strength, radius = 0.12) {
    const u = this.heatPass.uniforms;
    u.uA.value.set(a.x, a.y);
    u.uB.value.set(b.x, b.y);
    u.uStrength.value = strength;
    u.uRadius.value = radius;
  }

  render(dt, { dim = 0, tint = null, bloomStrength = 0.85, shakeEnabled = true } = {}) {
    this.time += dt;
    this.bgUniforms.uTime.value = this.time % 100;
    this.bgUniforms.uDim.value += (dim - this.bgUniforms.uDim.value) * Math.min(1, dt * 4);
    if (tint) this.bgUniforms.uTint.value.setRGB(tint[0], tint[1], tint[2]);
    this.heatPass.uniforms.uTime.value = this.time;
    this.bloom.strength = bloomStrength;

    // camera shake (comfortable: short, small, decaying, optional)
    const s = this._shake;
    if (shakeEnabled && s.t < s.dur) {
      s.t += dt;
      const k = Math.max(0, 1 - s.t / s.dur);
      const a = s.amp * k * k * 0.06;
      this.camera.position.set(
        this.basePos.x + (Math.random() - 0.5) * 2 * a,
        this.basePos.y + (Math.random() - 0.5) * 2 * a,
        this.basePos.z,
      );
    } else {
      this.camera.position.copy(this.basePos);
    }

    this._flash = Math.max(0, this._flash - dt * 4.5);
    this.flashMat.uniforms.uAmount.value = this._flash * (shakeEnabled ? 0.9 : 0.25);
    this.flashMat.visible = this._flash > 0.003;

    this.renderer.info.reset();
    this.composer.render(dt);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.videoTexture?.dispose();
    this.composer.dispose?.();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    });
    this.scene.environment?.dispose?.();
    this.renderer.dispose();
  }
}
