/**
 * 3D 星体「音乐壁纸」— 全屏 WebGL 可视化引擎(Three.js,本地 vendored r158 UMD)。
 *
 * 场景:远星场球壳 + 中央音乐球体(低频缩放/拉伸两极、高频赤道波纹)+
 * 两个倾斜光环(随能量加速/放大)+ 节拍冲击波环 + 相机环绕视差。
 * 音频数学与 2D 版 visualizer.js 完全一致(bass/mid/treble 分桶、节拍 EMA、
 * 静音 3 秒回待机、能量平滑),共用冷/暖两套调色板与 12 档能量 LUT 量化。
 *
 * 契约与 visualizer.js 相同:constructor(canvas) / setAnalyser / setPlaying / destroy,
 * 由 main.js 在 WebGL 可用时优先启用,失败回退 2D 星野。
 *
 * 性能:总粒子 ~4900、4 个 draw call、additive 合成;帧率低于 45 时降像素比
 * 与远星数(只降不升),球体位移 1800 点 CPU 每帧重算(预算内)。
 */
import { clamp } from './utils.js';
import { getFx, subscribe } from './fx.js';
import { Cameraman } from './cameraman.js';

const TAU = Math.PI * 2;

// 冷色调板(待机/低能量,参考 Mineradio Emily):薄荷青 #00f5d4 / 青蓝 #7fd8ff / 蓝 #73a7ff
const PALETTE_IDLE = [
  [0, 245, 212],
  [127, 216, 255],
  [115, 167, 255],
];
// 暖色调板(高能量):香槟金 #f4d28a / 暖白 #f8f4ee / 琥珀 #d99a2b
const PALETTE_ENERGY = [
  [244, 210, 138],
  [248, 244, 238],
  [217, 154, 43],
];

const E_STEPS = 12;   // 能量 LUT 量化步数(与 2D 版一致)
const N_ORB = 1800;   // 音乐球体粒子数
const N_STARS = 1500; // 远星场粒子数
const N_RING = 800;   // 单环粒子数

export class Visualizer3D {
  constructor(canvas) {
    if (typeof THREE === 'undefined') throw new Error('three.js 未加载');
    this.canvas = canvas;
    this.analyser = null;
    this.freq = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,               // 透明画布,body 背景透出,additive 混合才正确
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 3000);

    // 状态(与 2D 版同构)
    this.playing = false;
    this.visualActive = false;
    this.pulse = 0;
    this.bassAvg = 0;
    this.energy = 0;
    this.silentSince = 0;
    this.t = 0;
    this.lastTs = performance.now();
    this.lastBeat = 0;
    this.shockLife = 0;
    this.fpsEma = 60;
    this.downCooldown = 0;
    this.dprDegraded = false;
    this.starDraw = N_STARS;
    this.mouse = { x: 0.5, y: 0.5 };
    this.camAngle = 0;
    this.orbR = 1;
    this._suspended = false; // 生命周期挂起态(窗口隐藏停 rAF,恢复时重置时钟)
    // DIY 控制台参数:构造时取快照,变化经订阅推送(destroy 时退订)
    this.fx = { ...getFx() };
    this._unsubFx = subscribe((path, value) => this._applyFx(path, value));
    // 电影运镜:user 轨道由本模块合成,cine 偏移由 cameraman 计算(纯数学)
    this.cameraman = new Cameraman(this.fx);

    this.spriteTex = this._makeSprite();
    this._buildScene();
    this._resize();

    this._onResize = () => this._resize();
    this._onMousemove = (e) => {
      this.mouse.x = e.clientX / window.innerWidth;
      this.mouse.y = e.clientY / window.innerHeight;
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('mousemove', this._onMousemove);

    this._raf = requestAnimationFrame((ts) => this._loop(ts));
  }

  /** 播放器建成分析管线后接入 */
  setAnalyser(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }

  /** 播放状态切换:暂停/停止 → 待机 */
  setPlaying(on) {
    this.playing = on;
    if (!on) this.visualActive = false;
  }

  /** 生命周期挂起(内存优化):窗口隐藏停 rAF;恢复时重置时钟防大步进跳变 */
  setSuspended(on) {
    if (this._suspended === on) return;
    this._suspended = on;
    if (on) {
      cancelAnimationFrame(this._raf);
    } else {
      this.lastTs = performance.now();
      this._raf = requestAnimationFrame((ts) => this._loop(ts));
    }
  }

  /** DIY 控制台参数生效(fx.js 订阅推送);逐帧循环读取的参数无需即时应用 */
  _applyFx(path, value) {
    this.fx[path] = value;
    if (path === 'orbScale') this._resize();
    else if (path === 'starSize') this.starMat.size = 1.8 * value;
    this.cameraman.setParams({ [path]: value }); // cine 参数热更新(未知键自动忽略)
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._unsubFx?.();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('mousemove', this._onMousemove);
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.spriteTex.dispose();
    this.renderer.dispose();
  }

  // ---------- 资源 ----------

  /** 程序生成径向渐变光斑纹理(径向对称,旋转无关) */
  _makeSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---------- 场景构建 ----------

  _buildScene() {
    // 远星场:均匀球壳,setDrawRange 作为降载杆
    this.starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(N_STARS * 3);
    for (let i = 0; i < N_STARS; i++) {
      const th = Math.acos(2 * Math.random() - 1);
      const ph = Math.random() * TAU;
      const r = 600 + Math.random() * 500;
      starPos[i * 3] = r * Math.sin(th) * Math.cos(ph);
      starPos[i * 3 + 1] = r * Math.sin(th) * Math.sin(ph);
      starPos[i * 3 + 2] = r * Math.cos(th);
    }
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starGeo.setDrawRange(0, this.starDraw);
    this.starMat = new THREE.PointsMaterial({
      size: 1.8, sizeAttenuation: false, map: this.spriteTex,
      transparent: true, opacity: 0.75, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0x9db8cf,
    });
    this.starMat.color.setHex(0x9db8cf);
    this._starCool = new THREE.Color(0x9db8cf);
    this._starWarm = new THREE.Color(0xf4d28a);
    this.starPts = new THREE.Points(this.starGeo, this.starMat);
    this.starPts.frustumCulled = false;
    this.scene.add(this.starPts);

    // 音乐球体:单位球,顶点位移每帧 CPU 重算(orbR 缩放),颜色按能量 LUT 换档
    this.orbGeo = new THREE.BufferGeometry();
    this.orbBase = new Float32Array(N_ORB * 3);
    this.orbPos = new Float32Array(N_ORB * 3);
    this.orbCol = new Float32Array(N_ORB * 3);
    this.orbTheta = new Float32Array(N_ORB);
    this.orbColorIdx = new Uint8Array(N_ORB);
    for (let i = 0; i < N_ORB; i++) {
      const th = Math.acos(2 * Math.random() - 1);
      const ph = Math.random() * TAU;
      const x = Math.sin(th) * Math.cos(ph);
      const y = Math.cos(th);
      const z = Math.sin(th) * Math.sin(ph);
      this.orbBase[i * 3] = x;
      this.orbBase[i * 3 + 1] = y;
      this.orbBase[i * 3 + 2] = z;
      this.orbTheta[i] = Math.atan2(z, x);
      const ci = this.orbColorIdx[i] = (Math.random() * 3) | 0;
      const c = PALETTE_IDLE[ci];
      this.orbCol[i * 3] = c[0] / 255;
      this.orbCol[i * 3 + 1] = c[1] / 255;
      this.orbCol[i * 3 + 2] = c[2] / 255;
    }
    this.orbGeo.setAttribute('position', new THREE.BufferAttribute(this.orbPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.orbGeo.setAttribute('color', new THREE.BufferAttribute(this.orbCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.orbMat = new THREE.PointsMaterial({
      size: 2.6, sizeAttenuation: false, map: this.spriteTex,
      vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.orbPts = new THREE.Points(this.orbGeo, this.orbMat);
    this.orbPts.frustumCulled = false;
    this.scene.add(this.orbPts);
    this.lastColorIdx = 0;

    // 两个倾斜光环(XZ 平面圆环,group 旋转 y、child 固定倾斜)
    this.rings = [];
    const mk = (tilt, dir, ci) => {
      const spin = new THREE.Group();
      const tiltGrp = new THREE.Group();
      tiltGrp.rotation.x = tilt;
      spin.add(tiltGrp);
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(N_RING * 3);
      const rIn = 1.45, rOut = 2.2;
      for (let i = 0; i < N_RING; i++) {
        const r = Math.sqrt(rIn * rIn + Math.random() * (rOut * rOut - rIn * rIn));
        const a = Math.random() * TAU;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = 0;
        pos[i * 3 + 2] = Math.sin(a) * r;
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const c = PALETTE_IDLE[ci];
      const mat = new THREE.PointsMaterial({
        size: 2.2, sizeAttenuation: false, map: this.spriteTex,
        transparent: true, opacity: 0.6, depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255),
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      tiltGrp.add(pts);
      this.scene.add(spin);
      this.rings.push({ spin, group: tiltGrp, mat, dir, baseSize: 2.2 });
    };
    mk(1.1, 1, 0);
    mk(-1.1, -1, 2);

    // 节拍冲击波:环面,每帧面向相机
    this.shockMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.shock = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.0, 64), this.shockMat);
    this.scene.add(this.shock);
  }

  // ---------- 音频分析(与 2D 版一致) ----------
  _readAudio(dt) {
    if (!this.analyser || !this.visualActive) {
      this.visualActive = this.playing;
      return { bass: 0, mid: 0, treble: 0, level: 0 };
    }
    this.analyser.getByteFrequencyData(this.freq);
    // 512 点 FFT,采样率通常 44100/48000 → 每桶 ~43-47Hz
    // bass 1-3 桶(~90-280Hz),mid 4-13 桶,treble 16-65 桶
    const avg = (a, b) => {
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / ((b - a + 1) * 255);
    };
    const bass = avg(1, 3);
    const mid = avg(4, 13);
    const treble = avg(16, 65);
    const level = avg(1, 128);

    // 节拍检测:bass 相对其 EMA 的突刺 → 冲击波 + 闪光
    this.bassAvg = this.bassAvg * 0.95 + bass * 0.05;
    const now = performance.now();
    if (bass > this.bassAvg * 1.35 && bass > 0.15 && now - this.lastBeat > 160) {
      this.lastBeat = now;
      this.pulse = 1;
      if (this.fx.shockEnabled) this.shockLife = 1;
      // 电影运镜:节拍强度按 bass 超出 EMA 的相对量换算(0.3-1),clamp 防 EMA 过小除爆
      this.cameraman.beat(clamp((bass - this.bassAvg) / (this.bassAvg * 0.6), 0.3, 1));
    }

    // 静音检测:播放中连续 3 秒无能量 → 视觉回退待机
    if (level < 0.004) {
      this.silentSince += dt;
      if (this.silentSince > 3) this.visualActive = false;
    } else {
      this.silentSince = 0;
    }

    const targetE = clamp(0.5 * bass + 0.5 * treble, 0, 1);
    this.energy += (targetE - this.energy) * Math.min(1, dt * 2.5);
    return { bass, mid, treble, level };
  }

  // ---------- 几何更新 ----------

  _resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.w = w;
    this.h = h;
    this.orbR = Math.min(w, h) * 0.18 * this.fx.orbScale;
    this.renderer.setPixelRatio(this.dprDegraded ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 球体位移:低频缩放 + 拉伸两极,高频赤道波纹(单位球 × orbR × radial) */
  _updateOrb(bass, treble) {
    const eIdx = clamp(Math.floor(this.energy * (E_STEPS - 1)), 0, E_STEPS - 1);
    if (eIdx !== this.lastColorIdx) {
      this.lastColorIdx = eIdx;
      const k = eIdx / (E_STEPS - 1);
      for (let i = 0; i < N_ORB; i++) {
        const a = PALETTE_IDLE[this.orbColorIdx[i]];
        const b = PALETTE_ENERGY[this.orbColorIdx[i]];
        this.orbCol[i * 3] = (a[0] + (b[0] - a[0]) * k) / 255;
        this.orbCol[i * 3 + 1] = (a[1] + (b[1] - a[1]) * k) / 255;
        this.orbCol[i * 3 + 2] = (a[2] + (b[2] - a[2]) * k) / 255;
      }
      this.orbGeo.getAttribute('color').needsUpdate = true;
    }
    const react = this.fx.reactScale;
    const poleScale = 1 + 0.45 * bass * react;
    const r = this.orbR;
    for (let i = 0; i < N_ORB; i++) {
      const ux = this.orbBase[i * 3];
      const uy = this.orbBase[i * 3 + 1];
      const uz = this.orbBase[i * 3 + 2];
      const th = this.orbTheta[i];
      const cosLat2 = 1 - uy * uy; // cos²(纬度):赤道权重
      const ripple = treble * 0.15 * Math.sin(6 * th - this.t * 5) * cosLat2;
      const radial = 1 + react * (0.38 * bass + 0.10 * bass * Math.sin(this.t * 2.5 + 5 * th)) + ripple;
      this.orbPos[i * 3] = ux * r * radial;
      this.orbPos[i * 3 + 1] = uy * r * radial * poleScale;
      this.orbPos[i * 3 + 2] = uz * r * radial;
    }
    this.orbGeo.getAttribute('position').needsUpdate = true;
    this.orbMat.size = 2.6 * this.fx.orbSize * (1 + 0.7 * this.pulse);
    this.orbMat.opacity = 0.75 + 0.25 * this.pulse;
  }

  // ---------- 主循环 ----------
  _loop(ts) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dt = clamp((ts - this.lastTs) / 1000, 0, 0.05);
    this.lastTs = ts;
    this.t += dt;

    // 帧率自适应:低于 45fps 降载(5s 冷却,只降不升)
    this.fpsEma = this.fpsEma * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    if (this.fpsEma < 45) {
      if (!this.dprDegraded) {
        this.dprDegraded = true;
        this.cameraman.setParams({ lowPower: true }); // 降载联动:kick/punch ×0.6
        this._resize();
      }
      this.downCooldown -= dt;
      if (this.downCooldown <= 0 && this.starDraw > 500) {
        this.starDraw = Math.max(500, Math.round(this.starDraw * 0.8));
        this.starGeo.setDrawRange(0, this.starDraw);
        this.downCooldown = 5;
      }
    }

    const { bass, treble } = this._readAudio(dt);
    // 脉冲弹簧衰减;待机时合成呼吸节律
    if (this.visualActive) {
      this.pulse *= Math.exp(-dt * 8);
    } else {
      this.pulse = 0.15 + 0.1 * Math.sin(this.t * 0.9);
      this.energy *= Math.exp(-dt * 1.5);
    }

    // 远星场:缓慢旋转,颜色随能量冷暖过渡
    this.starPts.rotation.y += dt * (this.visualActive ? 0.02 : 0.007) * this.fx.starSpeed;
    this.starMat.color.copy(this._starCool).lerp(this._starWarm, this.energy);

    // 光环:能量加速,高频散大
    for (const ring of this.rings) {
      ring.spin.rotation.y += dt * (0.12 + 1.1 * this.energy) * ring.dir * this.fx.ringSpeed;
      ring.mat.size = ring.baseSize * (1 + 0.9 * treble);
      ring.group.scale.setScalar(this.orbR * (1 + 0.06 * treble));
    }

    // 音乐球体 + 冲击波
    this._updateOrb(bass, treble);
    if (this.shockLife > 0 && this.fx.shockEnabled) {
      this.shockLife -= dt * 1.4;
      if (this.shockLife <= 0) {
        this.shockMat.opacity = 0;
      } else {
        const s = 1 + (1 - this.shockLife) * 3.2;
        this.shock.scale.setScalar(this.orbR * s);
        this.shockMat.opacity = this.shockLife * 0.7;
        this.shock.quaternion.copy(this.camera.quaternion);
      }
    }

    // 相机:user 基准轨道(速度随能量)+ cine 偏移(节拍 kick/慢漂移)+ FOV punch
    this.camAngle += dt * (this.visualActive ? 0.05 + 0.12 * this.energy : 0.025);
    this.cameraman.update(dt, this.visualActive);
    const cam = this.cameraman;
    const D = this.orbR * 2.6 * (1 + cam.radiusOffset);
    this.camera.position.set(
      Math.sin(this.camAngle + cam.thetaOffset) * D,
      (0.06 * Math.sin(this.t * 0.5) + (0.5 - this.mouse.y) * 0.12 + cam.phiOffset) * D,
      Math.cos(this.camAngle + cam.thetaOffset) * D
    );
    this.camera.lookAt((this.mouse.x - 0.5) * this.orbR * 0.6, (0.5 - this.mouse.y) * this.orbR * 0.4, 0);
    this.camera.rotation.z += cam.rollOffset; // lookAt 之后的横滚(绕视线轴)
    const fov = Math.max(30, this.fx.fovBase * (1 - 0.06 * this.pulse) - cam.fovPunch);
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.renderer.render(this.scene, this.camera);
  }
}
