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

// 窗口尺寸钳制:最大化后心跳若原样持久化,重开即全屏(只能放大不能缩小)
const clampW = () => Math.floor(window.screen.availWidth * 0.8);
const clampH = () => Math.floor(window.screen.availHeight * 0.8);

function loadWinCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
}
function saveWinCfg(c) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* 忽略 */ }
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
  // 固定窗口名防多开;popup=yes 在 Chrome 隐藏工具栏(浏览器无真置顶,接受)
  win = window.open('/desktop-lyrics.html', WIN_NAME, `popup=yes,width=${w},height=${h},left=${x},top=${y}`);
  if (!win) {
    toast('桌面歌词小窗被拦截,请允许本站弹窗', true);
    window.__APP_DESKTOP_LYRICS = '0';
    return;
  }
  window.__APP_DESKTOP_LYRICS = '1';
  push(true);
}

function closeDesktopLyrics() {
  bc?.postMessage({ type: 'bye' });
  if (win && !win.closed) {
    try { win.close(); } catch { /* 已关忽略 */ }
  }
  win = null;
  window.__APP_DESKTOP_LYRICS = '0';
}

export function initDesktopLyrics() {
  const btn = document.getElementById('desktop-lyrics-btn');
  btn?.addEventListener('click', () => {
    if (win && !win.closed) closeDesktopLyrics();
    else openDesktopLyrics();
  });
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
    }
  }, 1000);
}

window.__APP_DESKTOP_LYRICS = '0';
