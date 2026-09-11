/**
 * 粒子星空「星海脉冲」— 全屏背景可视化引擎。
 *
 * 概念:缓慢旋转的倾斜星系盘;低频节拍 → 全盘径向脉冲(弹簧衰减),
 * 高频 → 金色星光微粒迸发,能量升高时调色板从冷(蓝/青/紫)渐暖(金/粉/琥珀)。
 * 未播放/暂停时自动进入待机:合成呼吸节律的静谧星空。
 *
 * 配色经 dataviz 校验器在深色表面 #05060f 上校准(对比度 ≥3:1);
 * 蓝↔紫对 CVD 用户区分度低,已用亮度/光晕尺寸做次级编码补偿。
 *
 * 性能:DPR≤2、粒子数随面积与帧率自适应、离屏缓存背景/星云、additive 合成、
 * 颜色用预生成 LUT 避免每帧拼字符串、单 rAF + dt 钳制。
 */
import { clamp } from './utils.js';

const TAU = Math.PI * 2;

// 冷色调板(待机/低能量):蓝 #3987e5 / 青 #199e70 / 紫 #9085e9
const PALETTE_IDLE = [
  [57, 135, 229],
  [25, 158, 112],
  [144, 133, 233],
];
// 暖色调板(高能量):金 #ffb84d / 粉 #d55181 / 琥珀 #c98500
const PALETTE_ENERGY = [
  [255, 184, 77],
  [213, 81, 129],
  [201, 133, 0],
];

const E_STEPS = 12;          // 能量 LUT 量化步数
const MAX_SPARKLES = 150;    // 星光微粒池上限
const SPARKLE_COLORS = ['255,255,235', '255,214,120', '255,160,90', '255,235,180'];

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.freq = null;

    this.particles = [];
    this.sparkles = [];
    this.playing = false;      // 是否处于播放态
    this.visualActive = false; // 实际驱动视觉的音频活性(含静音自动回退)
    this.pulse = 0;
    this.bassAvg = 0;
    this.energy = 0;           // 平滑能量 0..1,驱动调色板冷暖
    this.silentSince = 0;
    this.t = 0;
    this.lastTs = performance.now();
    this.lastBeat = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.N = 700;
    this.fpsEma = 60;
    this.downCooldown = 0;
    this.mouse = { x: 0.5, y: 0.5 };
    this._suspended = false; // 生命周期挂起态(窗口隐藏停 rAF,恢复时重置时钟)

    this._buildBg();
    this._resize();
    this._respawn();

    window.addEventListener('resize', () => this._resize());
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX / window.innerWidth;
      this.mouse.y = e.clientY / window.innerHeight;
    });

    this._raf = requestAnimationFrame((ts) => this._loop(ts));
  }

  /** 播放器建成分析管线后接入 */
  setAnalyser(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }

  /** 播放状态切换:暂停/停止 → 待机星空 */
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

  destroy() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
  }

  // ---------- 几何 ----------
  _resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.w = w;
    this.h = h;
    this.cx = w / 2;
    this.cy = h / 2;
    this.R = Math.min(w, h) * 0.42;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this._buildBg();
    this._buildNebulas();
    const target = clamp(Math.round((w * h) / 9000), 350, 900);
    if (Math.abs(target - this.N) > 60) {
      this.N = target;
      this._respawn();
    }
  }

  /** 离屏缓存:深空底色 + 暗角(避免每帧画渐变) */
  _buildBg() {
    const c = document.createElement('canvas');
    c.width = Math.round(this.w * this.dpr);
    c.height = Math.round(this.h * this.dpr);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(
      c.width / 2, c.height / 2, 0,
      c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.72
    );
    grad.addColorStop(0, '#0b0e1f');
    grad.addColorStop(1, '#05060f');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    this._bg = c;
  }

  /** 离屏缓存:三团星云(冷/暖两套,按能量交叉淡化) */
  _buildNebulas() {
    this._nebulas = { cool: [], warm: [] };
    const base = Math.min(this.w, this.h);
    const blobs = [
      { x: 0.22, y: 0.32, r: 0.55 },
      { x: 0.78, y: 0.62, r: 0.48 },
      { x: 0.5, y: 0.18, r: 0.38 },
    ];
    for (const kind of ['cool', 'warm']) {
      for (const b of blobs) {
        const c = document.createElement('canvas');
        const s = Math.max(64, Math.round(base * b.r));
        c.width = s;
        c.height = s;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        if (kind === 'cool') {
          grad.addColorStop(0, 'rgba(76, 90, 210, 0.30)');
          grad.addColorStop(0.55, 'rgba(60, 70, 160, 0.12)');
          grad.addColorStop(1, 'rgba(20, 25, 60, 0)');
        } else {
          grad.addColorStop(0, 'rgba(255, 150, 90, 0.26)');
          grad.addColorStop(0.55, 'rgba(210, 90, 150, 0.10)');
          grad.addColorStop(1, 'rgba(60, 20, 50, 0)');
        }
        g.fillStyle = grad;
        g.fillRect(0, 0, s, s);
        this._nebulas[kind].push({ c, x: b.x * this.w, y: b.y * this.h, s });
      }
    }
  }

  _respawn() {
    this.particles = [];
    for (let i = 0; i < this.N; i++) {
      this.particles.push(this._makeParticle());
    }
  }

  _makeParticle() {
    const colorIdx = (Math.random() * 3) | 0;
    const p = {
      angle: Math.random() * TAU,
      r: 40 + Math.pow(Math.random(), 0.7) * this.R,
      z: 0.25 + Math.random() * 0.75,
      speed: 0.02 + Math.random() * 0.05,
      size: 0.6 + Math.random() * 2.4,
      tw: Math.random() * TAU,
      colorIdx,
      // 蓝↔紫 CVD 次级编码:紫色粒子更大光晕、更深层(z 偏小)
      glow: colorIdx === 2 ? 1.6 : 1,
      lut: [],
    };
    for (let e = 0; e < E_STEPS; e++) {
      const k = e / (E_STEPS - 1);
      const a = PALETTE_IDLE[colorIdx];
      const b = PALETTE_ENERGY[colorIdx];
      p.lut.push(
        `${(a[0] + (b[0] - a[0]) * k) | 0},${(a[1] + (b[1] - a[1]) * k) | 0},${(a[2] + (b[2] - a[2]) * k) | 0}`
      );
    }
    return p;
  }

  // ---------- 音频分析 ----------
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

    // 节拍检测:bass 相对其 EMA 的突刺
    this.bassAvg = this.bassAvg * 0.95 + bass * 0.05;
    const now = performance.now();
    if (bass > this.bassAvg * 1.35 && bass > 0.15 && now - this.lastBeat > 160) {
      this.lastBeat = now;
      this.pulse = 1;
      this._burstSparkles(8 + ((Math.random() * 8) | 0));
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

  // ---------- 星光微粒 ----------
  _burstSparkles(n) {
    for (let i = 0; i < n; i++) {
      const p = this.particles[(Math.random() * this.particles.length) | 0];
      if (!p) continue;
      const ang = p.angle;
      const rr = p.r * (1 + 0.3 * this.pulse);
      const x = this.cx + Math.cos(ang) * rr + (this.mouse.x - 0.5) * 24 * p.z;
      const y = this.cy + Math.sin(ang) * rr * 0.62 + (this.mouse.y - 0.5) * 24 * p.z;
      this.sparkles.push({
        x, y,
        vx: (Math.random() - 0.5) * 26,
        vy: -14 - Math.random() * 26,
        life: 0.3 + Math.random() * 0.4,
        maxLife: 0.7,
        size: 0.8 + Math.random() * 1.6,
        color: SPARKLE_COLORS[(Math.random() * SPARKLE_COLORS.length) | 0],
      });
      if (this.sparkles.length >= MAX_SPARKLES) break;
    }
  }

  _spawnTrebleSparkles(treble) {
    // 高频触发概率,每帧最多 3 颗,从明亮粒子位置迸出
    if (Math.random() > Math.min(0.5, treble * 1.5)) return;
    for (let i = 0; i < 3; i++) {
      if (this.sparkles.length >= MAX_SPARKLES) return;
      const p = this.particles[(Math.random() * this.particles.length) | 0];
      if (!p) continue;
      this.sparkles.push({
        x: this.cx + Math.cos(p.angle) * p.r * (1 + 0.3 * this.pulse),
        y: this.cy + Math.sin(p.angle) * p.r * 0.62,
        vx: (Math.random() - 0.5) * 14,
        vy: (Math.random() - 0.5) * 14,
        life: 0.25 + Math.random() * 0.3,
        maxLife: 0.55,
        size: 0.7 + Math.random() * 1.2,
        color: SPARKLE_COLORS[(Math.random() * SPARKLE_COLORS.length) | 0],
      });
    }
  }

  // ---------- 主循环 ----------
  _loop(ts) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dt = clamp((ts - this.lastTs) / 1000, 0, 0.05);
    this.lastTs = ts;
    this.t += dt;

    // 帧率自适应:低于 45fps 降粒子数(5s 冷却,只降不升)
    this.fpsEma = this.fpsEma * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    this.downCooldown -= dt;
    if (this.fpsEma < 45 && this.downCooldown <= 0 && this.N > 300) {
      this.N = Math.max(300, Math.round(this.N * 0.8));
      this.downCooldown = 5;
      this._respawn();
    }

    const { treble } = this._readAudio(dt);
    // 脉冲弹簧衰减;待机时合成呼吸节律
    if (this.visualActive) {
      this.pulse *= Math.exp(-dt * 8);
      this._spawnTrebleSparkles(treble);
    } else {
      this.pulse = 0.15 + 0.1 * Math.sin(this.t * 0.9);
      this.energy *= Math.exp(-dt * 1.5);
    }

    this._render(dt);
  }

  _render(dt) {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 背景(离屏缓存)
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this._bg, 0, 0, w, h);

    // 星云:冷/暖按能量交叉淡化
    ctx.globalCompositeOperation = 'lighter';
    for (const kind of ['cool', 'warm']) {
      const a = kind === 'cool' ? 1 - this.energy : this.energy;
      ctx.globalAlpha = (0.35 + 0.65 * this.energy) * a;
      for (const nb of this._nebulas[kind]) {
        ctx.drawImage(nb.c, nb.x - nb.s / 2, nb.y - nb.s / 2, nb.s, nb.s);
      }
    }

    // 粒子
    const eIdx = clamp((this.energy * (E_STEPS - 1)) | 0, 0, E_STEPS - 1);
    const idleSlow = this.visualActive ? 1 : 0.3;
    const px = (this.mouse.x - 0.5) * 24;
    const py = (this.mouse.y - 0.5) * 24;

    for (const p of this.particles) {
      p.angle += (p.speed / p.z) * dt * idleSlow * (1 + 0.6 * this.pulse) * 10;
      const drawR = p.r * (1 + 0.3 * this.pulse + 0.04 * Math.sin(this.t * 0.7 + p.tw));
      const x = this.cx + Math.cos(p.angle) * drawR + px * p.z;
      const y = this.cy + Math.sin(p.angle) * drawR * 0.62 + py * p.z;
      const alpha =
        (0.35 + 0.65 * p.z) *
        (0.55 + 0.45 * Math.sin(this.t * 1.3 + p.tw)) *
        (this.visualActive ? 1 : 0.8);

      ctx.fillStyle = `rgb(${p.lut[eIdx]})`;
      const s = p.size * p.z * (this.visualActive ? 1 + 0.15 * this.pulse : 1);
      if (s * dpr < 2) {
        // 小粒子快速路径
        ctx.globalAlpha = alpha;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      } else {
        // 光晕 + 亮核
        const halo = s * 2.5 * p.glow;
        ctx.globalAlpha = alpha * 0.22;
        ctx.beginPath();
        ctx.arc(x, y, halo, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(x, y, s, 0, TAU);
        ctx.fill();
      }
    }

    // 星光微粒(additive)
    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      const sp = this.sparkles[i];
      sp.life -= dt;
      if (sp.life <= 0) {
        this.sparkles.splice(i, 1);
        continue;
      }
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      const a = clamp(sp.life / sp.maxLife, 0, 1);
      ctx.fillStyle = `rgba(${sp.color},${(a * 0.9).toFixed(3)})`;
      ctx.globalAlpha = 1;
      ctx.fillRect(sp.x - sp.size / 2, sp.y - sp.size / 2, sp.size, sp.size);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
