/**
 * 桌面歌词小窗:接收主窗节流快照 + 本地时间外推高亮(不等逐帧)。
 *
 * 协议(vmp-desktop-lyrics-v1):hello 请求全量 / state 主窗快照 / bye 关闭 /
 * heartbeat 2s(带窗口位置,主窗持久化)/ setFx 回写主窗 fx(字号/透明度单一写入口)。
 * 7s 无消息自关(主窗关闭或后台节流兜底);顶部手柄 window.moveBy 拖动
 * (对同源 opener 窗口有效)。
 * 测试标记:__APP_DESKTOP_LYRICS / __APP_LYRIC_RX_COUNT / __APP_DL_STATE。
 */
import { findLineIndex } from './lyrics.js';

const CHANNEL = 'vmp-desktop-lyrics-v1';
const HEARTBEAT_MS = 2000;
const SELF_CLOSE_MS = 7000;

const el = {
  root: document.getElementById('dl-root'),
  drag: document.getElementById('dl-drag'),
  title: document.getElementById('dl-title'),
  current: document.getElementById('dl-current'),
  next: document.getElementById('dl-next'),
  meta: document.getElementById('dl-meta'),
  fontDown: document.getElementById('dl-font-down'),
  fontUp: document.getElementById('dl-font-up'),
  opacity: document.getElementById('dl-opacity'),
  ctrls: document.getElementById('dl-ctrls'),
  lock: document.getElementById('dl-lock'),
  close: document.getElementById('dl-close'),
};

const bc = new BroadcastChannel(CHANNEL);
let lastMsgAt = Date.now();
let snapshot = null;
let lastLineIdx = -1;
let lastHash = '';
let lastText = '';
let dragging = false; // 用户拖动透明度滑杆时,快照流不得回写顶回
let locked = false;   // 锁定态(状态来自主窗快照/广播;ES 模块严格模式,必须先声明

window.__APP_DESKTOP_LYRICS = '1';
window.__APP_LYRIC_RX_COUNT = 0;
window.__APP_DL_LOCKED = '0'; // 测试标记:锁定 = 主窗已让小窗鼠标穿透(安装版)

// Electron 模式(preload 注入):页面透明化(无边框透明置顶窗)
if (window.__APP_CONFIG__?.electron) {
  document.documentElement.dataset.electron = '1';
  window.__APP_DL_ELECTRON = '1';
}

/** 锁定态:仅切样式与光标/拖拽开关;真正的「鼠标穿透」由主进程 setIgnoreMouseEvents 完成,
 *  状态唯一来源是主窗。锁定时**控件条仍要能点**(否则小窗自己解不了锁),规则:
 *    interactive = 鼠标正停在控制条上 ‖ 最近 2s 内动过鼠标
 *  其余时刻整窗穿透(鼠标不动就彻底穿透);浏览器模式没有穿透,这条规则只驱动淡入淡出。 */
const LOCK_HIT_MS = 2000; // 鼠标动过之后的临时可点窗口
let hitHot = false;       // 鼠标是否正停在控制条上
let lockHitUntil = 0;     // 临时可点的截止时间戳
let lockHitTimer = null;

const lockInteractive = () => hitHot || Date.now() < lockHitUntil;

/** 把「是否让鼠标穿透」下发给主进程:锁定时只在可点窗口内不穿透 */
function syncIgnore() {
  const interactive = !locked || lockInteractive();
  window.vmpShell?.dlIgnore?.(!interactive); // 浏览器模式无此 API,自动 no-op
  document.documentElement.dataset.hit = interactive ? '1' : '0';
}

/** 鼠标动过 → 开一个 2s 的可点窗口(每次移动都续期) */
function noteMove() {
  lockHitUntil = Date.now() + LOCK_HIT_MS;
  clearTimeout(lockHitTimer);
  lockHitTimer = setTimeout(() => {
    lockHitUntil = 0;
    syncIgnore();
  }, LOCK_HIT_MS + 60);
  syncIgnore();
}

function applyLock(next) {
  locked = !!next;
  window.__APP_DL_LOCKED = locked ? '1' : '0';
  document.documentElement.dataset.locked = locked ? '1' : '0';
  if (!locked) {
    hitHot = false;
    lockHitUntil = 0;
    clearTimeout(lockHitTimer);
  }
  if (el.lock) {
    el.lock.textContent = locked ? '🔒' : '🔓';
    el.lock.title = locked
      ? '已锁定(鼠标不动时整窗穿透;动一下鼠标即可点击本条解锁)'
      : '锁定(锁定后鼠标不动时整窗穿透,动一下鼠标就能点回来)';
  }
  syncIgnore();
}

// 锁定态的命中判定(两种模式都注册:浏览器模式只用于驱动控制条淡入淡出)
const HIT_PAD = 8; // 控制条外扩 8px 也算「停在控制条上」
document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  const r = el.ctrls?.getBoundingClientRect();
  hitHot = !!r
    && e.clientX >= r.left - HIT_PAD && e.clientX <= r.right + HIT_PAD
    && e.clientY >= r.top - HIT_PAD && e.clientY <= r.bottom + HIT_PAD;
  noteMove();
});
document.addEventListener('mouseleave', () => {
  if (!locked) return;
  hitHot = false;
  lockHitUntil = 0;
  clearTimeout(lockHitTimer);
  syncIgnore();
});
window.__APP_DL_HIT = () => lockInteractive(); // 测试标记

// ---------- 快照应用 ----------
function applySnapshot(s) {
  snapshot = s;
  if (typeof s.locked === 'boolean') applyLock(s.locked);
  window.__APP_LYRIC_RX_COUNT++;
  window.__APP_DL_STATE = {
    hash: s.hash, title: s.title, artist: s.artist,
    lyricLoaded: s.lyricLoaded, playing: s.playing, lineCount: s.lyric.length,
  };
  el.meta.textContent = s.title === '未在播放' ? 'RE:KG' : `${s.title} · ${s.artist}`;
  el.title.textContent = s.title === '未在播放' ? '桌面歌词' : s.title;
  // 拖动中不覆盖:快照流 150ms 一次,否则顶回滑杆/字号(连点后回声带同值,收敛一致)
  if (!dragging) {
    document.documentElement.style.setProperty('--dl-font-size', `${s.fontSize}px`);
    document.documentElement.style.setProperty('--dl-opacity', String(s.opacity));
    el.opacity.value = String(s.opacity);
  }
}

// ---------- 外推高亮渲染(100ms 节拍,外推平滑) ----------
function render() {
  if (!snapshot) return;
  const pb = snapshot.playback;
  const cap = Number.isFinite(pb.duration) && pb.duration > 0 ? pb.duration + 0.12 : Infinity;
  const t = Math.min(
    pb.time + (snapshot.playing ? (Date.now() - pb.receivedAt) / 1000 * pb.rate : 0),
    cap
  );
  const idx = findLineIndex(snapshot.lyric, t);
  const hash = snapshot.hash;
  if (idx === lastLineIdx && hash === lastHash) return;
  lastLineIdx = idx;
  lastHash = hash;
  const line = idx >= 0 ? snapshot.lyric[idx] : null;
  const nextLine = idx >= 0 && idx + 1 < snapshot.lyric.length ? snapshot.lyric[idx + 1] : null;
  const curText = line ? line.text : (snapshot.lyricLoaded ? '' : '暂无歌词');
  if (curText !== lastText) {
    lastText = curText;
    el.current.classList.remove('reenter');
    void el.current.offsetWidth; // 强制 reflow 重启动画
    el.current.classList.add('reenter');
  }
  el.current.textContent = curText;
  el.current.classList.toggle('nodata', !line && !snapshot.lyricLoaded);
  el.next.textContent = nextLine ? nextLine.text : '';
}
setInterval(render, 100);

// ---------- 通道 ----------
bc.onmessage = (e) => {
  const m = e.data || {};
  lastMsgAt = Date.now();
  if (m.type === 'state') applySnapshot(m.snapshot);
  else if (m.type === 'lock') applyLock(m.locked);
  else if (m.type === 'bye') window.close();
};

bc.postMessage({ type: 'hello' }); // 就绪:请求全量快照
setInterval(() => {
  bc.postMessage({
    type: 'heartbeat',
    x: window.screenX, y: window.screenY,
    w: window.outerWidth, h: window.outerHeight,
  });
}, HEARTBEAT_MS);

// 7s 无消息自关
setInterval(() => {
  if (Date.now() - lastMsgAt > SELF_CLOSE_MS) window.close();
}, 1000);

// ---------- 拖动(顶部手柄;控件点击不触发) ----------
// Electron:顶部条走 -webkit-app-region:drag 原生窗口拖拽(app-region 与系统边缘
// resize 命中互斥,拖动永不误触放大,Claude 记录坑:moveBy 拖拽时鼠标落进窗口
// 边缘 6px 命中带会被 Windows 当作拉伸 →「拖拽时边框自动变大」);
// 浏览器 popup 无 app-region,保留 moveBy 拖动(配合 open 的 resizable=no)。
let dragStart = null;
if (!window.__APP_CONFIG__?.electron) {
  el.drag.addEventListener('pointerdown', (e) => {
    if (locked) return; // 锁定后禁止拖动(安装版整窗穿透,浏览器模式靠这里挡)
    if (e.target.closest('button, input')) return;
    dragStart = { x: e.screenX, y: e.screenY };
    el.drag.setPointerCapture(e.pointerId);
  });
  el.drag.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    window.moveBy(e.screenX - dragStart.x, e.screenY - dragStart.y);
    dragStart = { x: e.screenX, y: e.screenY };
  });
  el.drag.addEventListener('pointerup', () => { dragStart = null; });
}

// ---------- 控件(本地立即生效 + 回写绝对目标值;主窗回推回声收敛) ----------
const curFont = () => {
  const v = parseFloat(document.documentElement.style.getPropertyValue('--dl-font-size'));
  return Number.isFinite(v) ? v : (snapshot?.fontSize || 40);
};
const fontStep = (d) => {
  const target = Math.min(64, Math.max(24, curFont() + d)); // 以本地实时值递增,连点不失效
  document.documentElement.style.setProperty('--dl-font-size', `${target}px`);
  bc.postMessage({ type: 'setFx', path: 'dlFontSize', value: target });
};
el.fontDown.addEventListener('click', () => fontStep(-2));
el.fontUp.addEventListener('click', () => fontStep(2));
el.opacity.addEventListener('pointerdown', () => { dragging = true; });
el.opacity.addEventListener('pointerup', () => { dragging = false; });
el.opacity.addEventListener('input', () => {
  const v = Number(el.opacity.value);
  document.documentElement.style.setProperty('--dl-opacity', String(v));
  bc.postMessage({ type: 'setFx', path: 'dlOpacity', value: v });
});
el.close.addEventListener('click', () => window.close());
// 锁定请求走主窗(状态与 IPC 都在主窗):小窗只发意图
el.lock?.addEventListener('click', () => bc.postMessage({ type: 'toggle-lock' }));
