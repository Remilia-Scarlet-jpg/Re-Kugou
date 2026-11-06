/**
 * 零依赖图标生成:手写 PNG 编码器(zlib.deflateSync + zlib.crc32,Node ≥20.15)
 * + PNG-in-ICO 容器 → build/icon.ico(16/32/48/64/256)+ build/icon.png(512)。
 * 图案:酷狗音乐风 — 蓝渐变圆角方 + 左上高光 + 白色 RE 字标(几何 SDF 手绘字形,无字体依赖)。
 *
 * 用法:
 *   node scripts/gen_icon.js            → Windows 图标(build/icon.ico + icon.png)
 *   node scripts/gen_icon.js --android  → Android 图标(android/app/src/main/res/ 下各 mipmap 密度目录)
 *
 * Android 的两种形态:
 *   ic_launcher(.round).png  自适应图标在 API<26 上的回退位图(整块蓝底 + 字标;round 用圆形遮罩)
 *   ic_launcher_foreground.png  自适应图标前景(透明底 + 居中字标),背景由 drawable/ic_launcher_bg.xml 提供
 *   ⚠️ 自适应图标画布 108dp,安全区只有中间 72dp —— 前景字标必须缩到 ~0.68,否则会被系统裁掉
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---------- CRC32(Node ≥20.15 内置;旧版回退查表) ----------
let crc32;
if (typeof zlib.crc32 === 'function') {
  crc32 = (buf) => zlib.crc32(buf) >>> 0;
} else {
  const T = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = T[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
}

// ---------- 最小 PNG 编码器(RGBA,filter 0) ----------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter 0
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- ICO 容器(PNG 条目,Vista+ 官方支持) ----------
function encodeICO(entries) {
  const n = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  const blobs = [];
  let offset = 6 + 16 * n;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, b + 4); // planes
    dir.writeUInt16LE(32, b + 6); // bpp
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    blobs.push(e.png);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---------- 绘图工具 ----------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// 颜色(0-255):酷狗品牌蓝(≈#0091FF)做左上浅 → 右下深对角渐变
const C_BLUE_TL = [63, 171, 255];
const C_BLUE_BR = [0, 112, 235];
const C_WHITE = [255, 255, 255];
const C_TINT = [198, 222, 255];

// 圆角矩形 SDF(单位坐标 0..1,返回带符号距离,负值在内部)
function sdRoundBox(px, py, r) {
  const qx = Math.abs(px - 0.5) - (0.5 - r);
  const qy = Math.abs(py - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// 线段 SDF(胶囊 = 圆头笔划,用于字标横竖划与 R 的斜腿)
function sdSeg(px, py, ax, ay, bx, by, r) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t)) - r;
}

// 圆环 SDF(R 字标的圆弧)
function sdRing(px, py, cx, cy, R, t) {
  return Math.abs(Math.hypot(px - cx, py - cy) - R) - t;
}

// "RE" 字标 SDF(单位坐标 0..1,自动居中):等宽圆头笔划(宽 0.064),
// R = 竖杆 + 圆弧 + 斜腿,E = 竖杆 + 上中下三横
function sdRE(px, py) {
  px -= 0.5 - (0.263 + 0.787) / 2; // 字形整体平移,组中心落在 0.5
  let d = sdSeg(px, py, 0.295, 0.24, 0.295, 0.76, 0.032); // R 竖杆
  d = Math.min(d, sdRing(px, py, 0.395, 0.395, 0.125, 0.033)); // R 圆弧
  d = Math.min(d, sdSeg(px, py, 0.405, 0.515, 0.525, 0.755, 0.033)); // R 斜腿
  d = Math.min(d, sdSeg(px, py, 0.63, 0.24, 0.63, 0.76, 0.032)); // E 竖杆
  d = Math.min(d, sdSeg(px, py, 0.63, 0.24, 0.755, 0.24, 0.032)); // E 上横
  d = Math.min(d, sdSeg(px, py, 0.63, 0.5, 0.735, 0.5, 0.032)); // E 中横
  d = Math.min(d, sdSeg(px, py, 0.63, 0.76, 0.755, 0.76, 0.032)); // E 下横
  return d;
}

/** 完整图标:蓝渐变底板(round=true 用圆形遮罩)+ 白色 RE 字标 */
function sampleIcon(px, py, round) {
  const dShape = round ? Math.hypot(px - 0.5, py - 0.5) - 0.5 : sdRoundBox(px, py, 0.215);
  const aShape = clamp01(0.5 - dShape * 512);
  if (aShape <= 0) return [0, 0, 0, 0];
  let col = mix(C_BLUE_TL, C_BLUE_BR, clamp01((px + py) / 2));
  // 左上高光(呼应玻璃配方的进光方向)
  const g = 1 - Math.hypot(px - 0.16, py - 0.12) / 0.6;
  if (g > 0) col = mix(col, C_WHITE, g * 0.1);
  // 白色 RE 字标(底部带一丝浅蓝,增加立体感)
  const aRE = clamp01(0.5 - sdRE(px, py) * 512);
  if (aRE > 0) {
    const t = clamp01((py - 0.2) / 0.62);
    col = mix(col, mix(C_WHITE, C_TINT, t * 0.35), aRE);
  }
  return [col[0], col[1], col[2], Math.round(aShape * 255)];
}

/** 自适应图标前景:透明底 + 居中字标(缩小到安全区内) */
// 108dp 画布的安全区是中间 72dp(0.667);字标本体宽约 0.52、高约 0.58,
// 取 0.98 让字标占画布 ≈0.51×0.57 —— 既够大又不越安全区(实测预览对比过 0.68/0.98)
const FG_SCALE = 0.98;
function sampleForeground(px, py) {
  const gx = 0.5 + (px - 0.5) / FG_SCALE;
  const gy = 0.5 + (py - 0.5) / FG_SCALE;
  const aRE = clamp01(0.5 - sdRE(gx, gy) * 512);
  if (aRE <= 0) return [0, 0, 0, 0];
  const t = clamp01((gy - 0.2) / 0.62);
  const col = mix(C_WHITE, C_TINT, t * 0.35);
  return [col[0], col[1], col[2], Math.round(aRE * 255)];
}

const sample = (px, py) => sampleIcon(px, py, false);

// 主图(2×2 超采样抗锯齿)
function render(size, fn = sample) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const s = fn((x + ox) / size, (y + oy) / size);
        r += s[0]; g += s[1]; b += s[2]; a += s[3];
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / 4);
      rgba[i + 1] = Math.round(g / 4);
      rgba[i + 2] = Math.round(b / 4);
      rgba[i + 3] = Math.round(a / 4);
    }
  }
  return rgba;
}

// 面积平均降采样(512 → 目标尺寸,支持非整除)
function downscale(src, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const k = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const x0 = x * k, x1 = (x + 1) * k, y0 = y * k, y1 = (y + 1) * k;
      let r = 0, g = 0, b = 0, a = 0;
      const ix0 = Math.floor(x0), iy0 = Math.floor(y0), ix1 = Math.min(srcSize, Math.ceil(x1)), iy1 = Math.min(srcSize, Math.ceil(y1));
      let wsum = 0;
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          const w = wx * wy;
          const i = (yy * srcSize + xx) * 4;
          r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w; a += src[i + 3] * w;
          wsum += w;
        }
      }
      const i = (y * dstSize + x) * 4;
      if (wsum > 0) {
        dst[i] = Math.round(r / wsum);
        dst[i + 1] = Math.round(g / wsum);
        dst[i + 2] = Math.round(b / wsum);
        dst[i + 3] = Math.round(a / wsum);
      }
    }
  }
  return dst;
}

// ---------- 主流程 ----------
const SRC = 512;

function writeWindowsIcons() {
  const OUT_DIR = path.join(__dirname, '..', 'build');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const main = render(SRC);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePNG(SRC, SRC, main));
  const entries = [256, 64, 48, 32, 16].map((s) => ({
    size: s,
    png: encodePNG(s, s, downscale(main, SRC, s)),
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeICO(entries));
  console.log(`icon.ico(${entries.map((e) => e.size).join('/')})+ icon.png(512) → ${OUT_DIR}`);
}

function writeAndroidIcons() {
  const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
  if (!fs.existsSync(RES)) {
    console.log('未找到 android/ 工程,跳过(先跑 npx cap add android)');
    return;
  }
  const full = render(SRC, sample);
  const round = render(SRC, (x, y) => sampleIcon(x, y, true));
  const fg = render(SRC, sampleForeground);
  const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
  const written = [];
  for (const [name, k] of DENSITIES) {
    const dir = path.join(RES, `mipmap-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const iconSize = Math.round(48 * k);
    const fgSize = Math.round(108 * k); // 自适应图标画布固定 108dp
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), encodePNG(iconSize, iconSize, downscale(full, SRC, iconSize)));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), encodePNG(iconSize, iconSize, downscale(round, SRC, iconSize)));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), encodePNG(fgSize, fgSize, downscale(fg, SRC, fgSize)));
    written.push(`mipmap-${name} ${iconSize}/${fgSize}`);
  }
  console.log(`Android 图标已写入 ${RES}\n  ${written.join('\n  ')}`);
}

if (process.argv.includes('--android')) {
  writeAndroidIcons();
} else {
  writeWindowsIcons();
}
