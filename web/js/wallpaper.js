/**
 * 壁纸模式:DOM 媒体层(#wallpaper-layer)位于透明 3D canvas 之下,音乐视觉悬浮其上。
 *
 * 图片:解码 → canvas 压缩 WebP dataURL(≤2200px/q0.84;>4.5MB 再降 1280/q0.72,
 * 仍超 → 存 IndexedDB blob 回放 objectURL)。
 * 视频:IndexedDB 库 vmp-wallpaper-v1/store media(>1000MB 拒绝),objectURL 回放;
 * >100MB 落库前弹提示,落库后请求存储持久化(防浏览器回收);大文件绝不转 dataURL。
 * 配置 vmp.wallpaper.v1:{enabled,type:'none|image|video',src|id,savedAt};
 * bgOpacity/bgZoom/bgBlur 订阅 fx.js → #wallpaper-layer CSS 变量。
 * 2D 回退模式壁纸被不透明 _bg 盖住 = 设计行为(不改 2D 引擎)。
 */
import { getFx, subscribe } from './fx.js';
import { toast } from './ui.js';

const CFG_KEY = 'vmp.wallpaper.v1';
const DB_NAME = 'vmp-wallpaper-v1';
const STORE = 'media';
const IMAGE_ID = 'image';
const VIDEO_ID = 'video';
const MAX_VIDEO_BYTES = 1000 * 1024 * 1024; // 视频上限 1000MB
const SAVE_NOTIFY_BYTES = 100 * 1024 * 1024; // 超过则提示保存耗时
const MAX_DATAURL_BYTES = 4.5 * 1024 * 1024;
const MAX_SIDE = 2200;

const layer = document.getElementById('wallpaper-layer');
const img = document.getElementById('wallpaper-img');
const video = document.getElementById('wallpaper-video');
let cfg = { enabled: false, type: 'none' };
let imgUrl = '';
let videoUrl = '';
let hintEl = null;
let onVideoAccepted = null; // S14 测试钩子:拦截保存动作(验证上限判定,不实际落库)

// ---------- IndexedDB(vmp-wallpaper-v1 / media) ----------
let db = null;
function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function idbPut(id, blob) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(id) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}
function idbClear() {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbCount() {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ---------- 媒体切换与配置 ----------
function showMedia(type) {
  img.hidden = type !== 'image';
  video.hidden = type !== 'video';
  if (type !== 'video') {
    try { video.pause(); } catch { /* 未载源时 pause 可能抛错,忽略 */ }
  }
}
function saveCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* 配额满忽略 */ }
}
function setMarker(type) { window.__APP_WALLPAPER = type; }
function updateHint() {
  if (!hintEl) return;
  const d2 = window.__APP_STARFIELD_3D === '1' ? '' : ' · 2D 模式不可见';
  hintEl.textContent = cfg.type === 'image' ? `图片壁纸(WebP 压缩)${d2}`
    : cfg.type === 'video' ? `视频壁纸(IndexedDB)${d2}`
    : `未设置${d2}`;
}

async function applyVideoBlob(blob) {
  await idbPut(VIDEO_ID, blob);
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(blob);
  video.src = videoUrl;
  video.play().catch(() => { /* 静音自动播放被策略拦截时静默 */ });
  img.removeAttribute('src');
  showMedia('video');
  cfg = { enabled: true, type: 'video', id: VIDEO_ID, savedAt: Date.now() };
  saveCfg();
  setMarker('video');
  updateHint();
}

function applyImageDataUrl(dataUrl) {
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = '';
  img.src = dataUrl;
  video.removeAttribute('src');
  showMedia('image');
  cfg = { enabled: true, type: 'image', src: dataUrl, savedAt: Date.now() };
  saveCfg();
  setMarker('image');
  updateHint();
}

async function handleImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('图片解码失败'));
      i.src = url;
    });
    const draw = (maxSide, quality) => {
      const s = Math.min(1, maxSide / Math.max(im.width, im.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(im.width * s));
      cv.height = Math.max(1, Math.round(im.height * s));
      cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/webp', quality);
    };
    let dataUrl = draw(MAX_SIDE, 0.84);
    if (dataUrl.length > MAX_DATAURL_BYTES) dataUrl = draw(1280, 0.72);
    if (dataUrl.length > MAX_DATAURL_BYTES) {
      // 两档降质后仍超:存 IndexedDB 回放(不占 localStorage 配额)
      const blob = await fetch(dataUrl).then((r) => r.blob());
      await idbPut(IMAGE_ID, blob);
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      imgUrl = URL.createObjectURL(blob);
      img.src = imgUrl;
      video.removeAttribute('src');
      showMedia('image');
      cfg = { enabled: true, type: 'image', id: IMAGE_ID, savedAt: Date.now() };
      saveCfg();
      setMarker('image');
      updateHint();
      return;
    }
    applyImageDataUrl(dataUrl);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleVideoFile(file) {
  const cap = Number(window.__APP_WALLPAPER_MAX_VIDEO) || MAX_VIDEO_BYTES; // 测试钩子可调小
  if (file.size > cap) {
    toast(`视频超过 ${Math.round(cap / 1024 / 1024)}MB,已拒绝`, true);
    return;
  }
  // 配额预检:浏览器模式 IDB 配额按磁盘计,写满会静默失败;Electron 默认无限制
  try {
    const est = await navigator.storage.estimate();
    if (est.quota && est.usage != null && est.usage + file.size > est.quota) {
      toast('存储配额不足,无法保存该视频', true);
      return;
    }
  } catch { /* estimate 不可用(部分环境)跳过预检 */ }
  if (onVideoAccepted) { onVideoAccepted(file.size); return; } // S14 测试钩子:验证上限判定,不落库
  if (file.size > SAVE_NOTIFY_BYTES) toast('正在保存大视频,可能需要较长时间…');
  await applyVideoBlob(file);
  try { await navigator.storage.persist(); } catch { /* 尽力而为 */ }
  toast('视频壁纸已保存(IndexedDB)');
}

function clearWallpaper() {
  img.removeAttribute('src');
  video.pause();
  video.removeAttribute('src');
  if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = ''; }
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = ''; }
  showMedia('none');
  idbClear().catch(() => {});
  cfg = { enabled: false, type: 'none' };
  saveCfg();
  setMarker('none');
  updateHint();
}

// ---------- 启动恢复 ----------
async function restore() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { /* 损坏回退未设置 */ }
  if (saved.type === 'image') {
    if (saved.src) { applyImageDataUrl(saved.src); return; }
    if (saved.id === IMAGE_ID) {
      try {
        const blob = await idbGet(IMAGE_ID);
        if (blob) {
          if (imgUrl) URL.revokeObjectURL(imgUrl);
          imgUrl = URL.createObjectURL(blob);
          img.src = imgUrl;
          showMedia('image');
          cfg = { ...saved };
          setMarker('image');
          updateHint();
          return;
        }
      } catch { /* 数据库不可用回退未设置 */ }
    }
  } else if (saved.type === 'video' && saved.id === VIDEO_ID) {
    try {
      const blob = await idbGet(VIDEO_ID);
      if (blob) {
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        videoUrl = URL.createObjectURL(blob);
        video.src = videoUrl;
        video.play().catch(() => {});
        showMedia('video');
        cfg = { ...saved };
        setMarker('video');
        updateHint();
        return;
      }
    } catch { /* 同上 */ }
  }
  setMarker('none');
}

// ---------- 视觉面板文件区 ----------
function renderSection(rootEl) {
  const groupsEl = rootEl.querySelector('.fx-groups');
  if (!groupsEl) return;
  const g = document.createElement('div');
  g.className = 'fx-group';
  const title = document.createElement('div');
  title.className = 'fx-group-title';
  title.textContent = '壁纸文件';
  const row = document.createElement('div');
  row.className = 'fx-slot-row';
  const mkBtn = (id, label) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.id = id;
    b.textContent = label;
    row.appendChild(b);
    return b;
  };
  const hint = document.createElement('div');
  hint.className = 'fx-slot-hint';
  hint.id = 'wp-hint';
  hintEl = hint;

  const fileInp = document.createElement('input');
  fileInp.type = 'file';
  fileInp.hidden = true;
  const pick = (accept, handler) => {
    fileInp.accept = accept;
    fileInp.onchange = () => {
      const f = fileInp.files?.[0];
      fileInp.value = '';
      if (f) handler(f).catch(() => toast('壁纸设置失败', true));
    };
    fileInp.click();
  };
  mkBtn('wp-pick-image', '选择图片').addEventListener('click', () => pick('image/*', handleImageFile));
  mkBtn('wp-pick-video', '选择视频').addEventListener('click', () => pick('video/*', handleVideoFile));
  mkBtn('wp-clear', '清除').addEventListener('click', clearWallpaper);
  g.append(title, row, fileInp, hint);
  groupsEl.appendChild(g);
}

// ---------- 装配 ----------
export function initWallpaper(rootEl) {
  if (!layer || !img || !video) return;
  video.onerror = () => { /* noop:坏视频静默失败,防控制台噪声 */ };
  applyCssVars();
  subscribe((path) => {
    if (path === 'bgOpacity' || path === 'bgZoom' || path === 'bgBlur') applyCssVars();
  });
  renderSection(rootEl);
  updateHint();
  restore();
}

function applyCssVars() {
  const fx = getFx();
  layer.style.setProperty('--wp-opacity', String(fx.bgOpacity));
  layer.style.setProperty('--wp-zoom', String(fx.bgZoom));
  layer.style.setProperty('--wp-blur', `${fx.bgBlur}px`);
}

// CDP 测试入口(页面内合成 File/Blob 走完整管线)+ 状态标记
window.__APP_WALLPAPER = 'none';
window.__APP_WALLPAPER_MAX_VIDEO = MAX_VIDEO_BYTES; // 测试钩子:调小可测超限拒绝路径
window.__APP_WALLPAPER_API = { handleImageFile, handleVideoFile, applyVideoBlob, clearWallpaper, idbCount, setSaveHook: (fn) => { onVideoAccepted = fn; } };
