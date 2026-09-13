/**
 * 桌面歌词(主窗桥):window.open 独立小窗 + BroadcastChannel vmp-desktop-lyrics-v1。
 *
 * 协议:小窗 hello → 主窗回 state 全量快照;心跳 2s(带窗口位置,主窗写
 * vmp.desktopLyrics.v1);timeupdate 节流 150ms 推送;songchange/statechange 强制;
 * 小窗 setFx 请求 → 主窗 setFx(fx 单一写入口)→ 回推生效;主窗 pagehide 发 bye。
 * 小窗本地时间外推高亮;7s 无消息小窗自关。
 * 歌词数据直接读 ui.js 的 lyricsView 实例(ui.js 无条件 loadFor,lines 恒为当前曲,
 * 不触碰 ui.js 抽屉闸门——桌词与抽屉完全解耦)。
 */
import { player } from './player.js';
import { lyricsView, toast } from './ui.js';
import { getFx, setFx, subscribe } from './fx.js';

const CHANNEL = 'vmp-desktop-lyrics-v1';
const WIN_NAME = 'vmp-desktop-lyrics';
const CFG_KEY = 'vmp.desktopLyrics.v1';
const PUSH_MIN_MS = 150;

let win = null;
let bc = null;
let lastPushAt = 0;
// 锁定态(状态唯一来源 = 主窗,持久化在 vmp.desktopLyrics.v1.locked):
// Electron 下锁定 = 主进程对小窗 setIgnoreMouseEvents(true) → 整窗鼠标穿透;
// 浏览器 popup 无穿透能力,锁定退化为「禁止拖动 + 控件不可点」,故文案要区分。
let locked = false;

// 窗口尺寸钳制:最大化后心跳若原样持久化,重开即全屏(只能放大不能缩小)
const clampW = () => Math.floor(window.screen.availWidth * 0.8);
const clampH = () => Math.floor(window.screen.availHeight * 0.8);

function loadWinCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
}
function saveWinCfg(c) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* 忽略 */ }
}
const loadLock = () => !!loadWinCfg()?.locked;
function saveLock(v) {
  saveWinCfg({ ...(loadWinCfg() || {}), locked: !!v });
}

/** 主窗播放条上的锁按钮:仅当小窗开着时可见(锁上后小窗自己点不到,这是唯一解锁入口) */
function updateLockBtn() {
  const btn = document.getElementById('dl-lock-btn');
  if (!btn) return;
  btn.hidden = !(win && !win.closed);
  btn.textContent = locked ? '🔒' : '🔓';
  btn.title = locked ? '解锁桌面歌词(也可在小窗顶部控制条上点 🔒)' : '锁定桌面歌词(锁定后歌词区域鼠标穿透)';
  btn.classList.toggle('dl-lock-on', locked);
}

function setLocked(next, opts = {}) {
  locked = !!next;
  saveLock(locked);
  window.__APP_DL_LOCKED = locked ? '1' : '0';
  // 穿透不是这里下发的:小窗自己按「鼠标是否停在控件条上」动态开关(见 view 的 dlIgnore),
  // 主窗只负责状态与广播——否则锁上后小窗点不到东西,只能回主窗解锁
  bc?.postMessage({ type: 'lock', locked });
  updateLockBtn();
  if (opts.silent) return;
  if (!locked) return toast('桌面歌词已解锁');
  toast(
    window.__APP_CONFIG__?.electron
      ? '桌面歌词已锁定:歌词区域鼠标穿透,把鼠标移回小窗顶部控制条即可点击解锁'
      : '桌面歌词已锁定(锁定期间禁止拖动;鼠标穿透需安装版)'
  );
}

function ensureChannel() {
  if (!bc) {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'hello') push(true);
      else if (m.type === 'heartbeat') {
        if (m.x != null) saveWinCfg({ x: m.x, y: m.y, w: Math.min(m.w, clampW()), h: Math.min(m.h, clampH()) });
        push(true); // 心跳回推:小窗保活 + 修正外推漂移
      } else if (m.type === 'setFx') {
        setFx(m.path, m.value);
        push(true);
      } else if (m.type === 'toggle-lock') {
        setLocked(!locked); // 小窗点了 🔒:状态与 IPC 都留在主窗处理
      }
    };
  }
  return bc;
}

function buildSnapshot() {
  const song = player.queue[player.index] || {};
  return {
    hash: song.hash || '',
    title: song.name || '未在播放',
    artist: song.artists || '',
    lyric: (lyricsView.lines || []).map((l) => ({ time: l.time, text: l.text })),
    lyricLoaded: !!(song.hash && (lyricsView.lines || []).length),
    playing: player.state === 'playing',
    playback: {
      time: player.getPosition(),
      duration: player.getDuration(),
      rate: player.audio?.playbackRate || 1,
      receivedAt: Date.now(), // 墙钟:跨窗口可比(performance.now 每窗 timeOrigin 不同)
    },
    fontSize: getFx().dlFontSize,
    opacity: getFx().dlOpacity,
    locked, // 小窗据此同步锁定外观(穿透由主进程负责,这里只是状态同步)
  };
}

function push(force) {
  if (!win || win.closed || !bc) return;
  const t = performance.now();
  if (!force && t - lastPushAt < PUSH_MIN_MS) return;
  lastPushAt = t;
  bc.postMessage({ type: 'state', snapshot: buildSnapshot() });
}

function openDesktopLyrics() {
  if (win && !win.closed) { win.focus(); return; }
  const cfg = loadWinCfg();
  const w = Math.min(cfg?.w || 560, clampW()); // 兜底历史脏数据
  const h = Math.min(cfg?.h || 300, clampH());
  const x = cfg?.x ?? Math.max(0, window.screenX + window.outerWidth - w - 40);
  const y = cfg?.y ?? Math.max(0, window.screenY + 60);
  ensureChannel();
  // 固定窗口名防多开;popup=yes 在 Chrome 隐藏工具栏(浏览器无真置顶,接受);
  // resizable=no 防拖动小窗时鼠标落进窗口边缘被系统当作拉伸(「拖拽时边框自动变大」坑)
  win = window.open('/desktop-lyrics.html', WIN_NAME, `popup=yes,resizable=no,width=${w},height=${h},left=${x},top=${y}`);
  if (!win) {
    toast('桌面歌词小窗被拦截,请允许本站弹窗', true);
    window.__APP_DESKTOP_LYRICS = '0';
    return;
  }
  window.__APP_DESKTOP_LYRICS = '1';
  locked = loadLock();
  push(true);
  updateLockBtn();
  // 新开的 BrowserWindow 默认不穿透:持久化的锁定态要在子窗创建后重新下发(IPC + 广播各一次)
  setTimeout(() => {
    if (win && !win.closed) setLocked(locked, { silent: true });
  }, 400);
}

function closeDesktopLyrics() {
  bc?.postMessage({ type: 'bye' });
  if (win && !win.closed) {
    try { win.close(); } catch { /* 已关忽略 */ }
  }
  win = null;
  window.__APP_DESKTOP_LYRICS = '0';
  updateLockBtn();
}

export function initDesktopLyrics() {
  const btn = document.getElementById('desktop-lyrics-btn');
  btn?.addEventListener('click', () => {
    if (win && !win.closed) closeDesktopLyrics();
    else openDesktopLyrics();
  });
  // 锁定按钮:仅在小窗开着时可见;点击 → 切换穿透
  const lockBtn = document.getElementById('dl-lock-btn');
  lockBtn?.addEventListener('click', () => setLocked(!locked));
  locked = loadLock();
  window.__APP_DL_LOCKED = locked ? '1' : '0';
  updateLockBtn();
  // 常驻监听(win 为空时 push 自短路,零开销)
  player.on('timeupdate', () => push(false));
  player.on('songchange', () => push(true));
  player.on('statechange', () => push(true));
  // fx 面板改桌词字号/透明度 → 推小窗(小窗 setFx 请求 → setFx → 本订阅回声,双向收敛)
  subscribe((path) => {
    if (path === 'dlFontSize' || path === 'dlOpacity') push(true);
  });
  // 主窗卸载/刷新:通知小窗关闭(小窗 7s 无消息自关兜底)
  window.addEventListener('pagehide', () => {
    bc?.postMessage({ type: 'bye' });
  });
  // 小窗被用户直接关闭(✕)时同步主窗标记
  setInterval(() => {
    if (win?.closed) {
      win = null;
      window.__APP_DESKTOP_LYRICS = '0';
      updateLockBtn();
    }
  }, 1000);
}

window.__APP_DESKTOP_LYRICS = '0';
