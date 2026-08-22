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
  close: document.getElementById('dl-close'),
};

const bc = new BroadcastChannel(CHANNEL);
let lastMsgAt = Date.now();
let snapshot = null;
let lastLineIdx = -1;
let lastHash = '';
let lastText = '';
let dragging = false; // 用户拖动透明度滑杆时,快照流不得回写顶回

window.__APP_DESKTOP_LYRICS = '1';
window.__APP_LYRIC_RX_COUNT = 0;

// Electron 模式(preload 注入):页面透明化(无边框透明置顶窗)
if (window.__APP_CONFIG__?.electron) {
  document.documentElement.dataset.electron = '1';
  window.__APP_DL_ELECTRON = '1';
}

// ---------- 快照应用 ----------
function applySnapshot(s) {
  snapshot = s;
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
let dragStart = null;
el.drag.addEventListener('pointerdown', (e) => {
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
