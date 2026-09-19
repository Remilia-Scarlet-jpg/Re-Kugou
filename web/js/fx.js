/**
 * 视觉状态中枢(DIY 控制台):扁平 fx 对象 + 逐字段归一化 + 订阅 + 防抖持久化。
 *
 * 键名遵守 vmp.<name>.v1 约定;visualizer3d / cameraman / wallpaper / desktop-lyrics
 * 各自 subscribe 生效(依赖单向:本模块不 import 任何业务模块)。
 * 状态对象原地 mutate → window.__APP_FX 引用恒有效,CDP 测试可稳定断言。
 */
const FX_KEY = 'vmp.fx.v1';
const SAVE_DELAY = 300;

/** 全部可调参数默认值(每字段含义见 FX_SPECS 注释) */
export const FX_DEFAULTS = {
  // 场景(visualizer3d)
  sceneEnabled: true, // 背景粒子场景总开关(false = 隐藏画布 + 挂起 rAF,粒子完全不渲染)
  orbScale: 1.0,      // 球体整体大小(乘 orbR)
  reactScale: 1.0,    // 律动强度(bass 位移系数)
  orbSize: 1.0,       // 球体粒子大小
  starSize: 1.0,      // 星尘大小
  starSpeed: 1.0,     // 星场转速
  ringSpeed: 1.0,     // 光环转速
  shockEnabled: true, // 节拍冲击波环
  // 电影运镜(cameraman)
  cineEnabled: true,
  cineShake: 0.6,     // kick/punch 总幅度
  cineIdle: 0.5,      // 慢正弦漂移幅度
  cineKick: 0.6,      // 节拍 kick 幅度
  cinePunch: 0.55,    // FOV punch 幅度
  fovBase: 58,        // 基础 FOV(度)
  // 壁纸(wallpaper)
  bgOpacity: 0.85,
  bgZoom: 1.0,
  bgBlur: 0,          // px
  bgVolume: 0,        // 壁纸音量 0..1(部分壁纸自带声音;默认 0 = 静音,不打扰)
  bgDuck: false,      // 音乐播放时静音壁纸(默认关:拉了音量就该出声;开着会让「没声音」看起来像 bug)
  // 桌面歌词小窗
  dlFontSize: 40,
  dlOpacity: 0.92,
};

/** 归一化规格:[min, max, step];step 只对数字字段取整;bool 字段用 [0,1,1] 占位 */
export const FX_SPECS = {
  sceneEnabled: [0, 1, 1],
  orbScale: [0.5, 2.0, 0.05],
  reactScale: [0, 2.0, 0.05],
  orbSize: [0.5, 2.0, 0.05],
  starSize: [0.5, 2.0, 0.05],
  starSpeed: [0, 2.0, 0.05],
  ringSpeed: [0, 2.0, 0.05],
  shockEnabled: [0, 1, 1],
  cineEnabled: [0, 1, 1],
  cineShake: [0, 1.8, 0.05],
  cineIdle: [0, 1.5, 0.05],
  cineKick: [0, 1.5, 0.05],
  cinePunch: [0, 1.2, 0.05],
  fovBase: [45, 75, 1],
  bgOpacity: [0, 1, 0.05],
  bgZoom: [0.8, 2.0, 0.05],
  bgBlur: [0, 20, 1],
  bgVolume: [0, 1, 0.05],
  bgDuck: [0, 1, 1],
  dlFontSize: [24, 64, 2],
  dlOpacity: [0.28, 1, 0.02],
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const roundStep = (v, step) => (step > 0 ? Math.round(v / step) * step : v);

/** 单字段归一化(缺失/非法 → 默认值) */
function normalizeField(key, rawValue) {
  const def = FX_DEFAULTS[key];
  if (typeof def === 'boolean') {
    return rawValue == null ? def : !!rawValue;
  }
  const [min, max, step] = FX_SPECS[key];
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return def;
  return roundStep(clamp(n, min, max), step);
}

function normalizeFx(raw) {
  const out = { ...FX_DEFAULTS };
  for (const key of Object.keys(FX_SPECS)) out[key] = normalizeField(key, raw?.[key]);
  return out;
}

// ---------- 状态与订阅 ----------
let state = (() => {
  try {
    return normalizeFx(JSON.parse(localStorage.getItem(FX_KEY) || '{}'));
  } catch {
    return { ...FX_DEFAULTS };
  }
})();

const listeners = new Set();
let saveTimer = null;

function flush() {
  try {
    localStorage.setItem(FX_KEY, JSON.stringify(state));
  } catch {
    /* 存储满等异常忽略 */
  }
}

// 卸载前同步落盘:防抖窗口内刷新/关页不丢最新参数
window.addEventListener('pagehide', flush);

/** 当前 fx 状态(原地 mutate 的稳定引用,勿复制后写回) */
export function getFx() {
  return state;
}

/** 设置单参数:归一化 → 原地更新 → 通知订阅者 → 防抖写盘 */
export function setFx(path, value) {
  if (!(path in FX_SPECS)) return;
  const next = normalizeField(path, value);
  if (state[path] === next) return;
  state[path] = next;
  listeners.forEach((fn) => {
    try {
      fn(path, next, state);
    } catch {
      /* 订阅者异常不影响其他订阅者 */
    }
  });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

/** 订阅参数变化:fn(path, value, state);返回退订函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 应用预设快照(逐字段走 setFx,应用时归一化,天然兼容未来新增参数) */
export function applyFxSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  for (const key of Object.keys(FX_SPECS)) {
    if (key in snapshot) setFx(key, snapshot[key]);
  }
}

/** 全量恢复默认 */
export function resetFx() {
  for (const key of Object.keys(FX_SPECS)) setFx(key, FX_DEFAULTS[key]);
}

/** 当前全量快照(供预设槽保存) */
export function getFxSnapshot() {
  return { ...state };
}

// CDP 测试标记:原地引用,断言恒有效
window.__APP_FX = state;
