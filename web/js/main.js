/**
 * 装配入口:可视化引擎 + 播放器 + UI + 队列持久化 + 快捷键。
 */
import { player } from './player.js';
import { initUI } from './ui.js';
import { migrateLegacyLogin } from './api.js';
import { Visualizer } from './visualizer.js';
import { Visualizer3D } from './visualizer3d.js';
import { saveQueue, loadQueue } from './store.js';
import { initFxPanel } from './fx-panel.js';
import { getFx, subscribe } from './fx.js';
import { initWallpaper } from './wallpaper.js';
import { initDesktopLyrics } from './desktop-lyrics.js';
import { initLifecycle, onHidden, onVisible } from './lifecycle.js';

// ---------- 音乐壁纸可视化:3D(WebGL)优先,失败回退 2D 星野 ----------
const canvas = document.getElementById('starfield');
// 一次性画布探测 WebGL:绝不能在真实 #starfield 上探测(上下文锁定会废掉 2D 回退)
const probe = document.createElement('canvas');
const glOk = !!(window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl')));
let viz = null;
if (glOk && typeof THREE !== 'undefined') {
  try {
    viz = new Visualizer3D(canvas);
    window.__APP_STARFIELD_3D = '1';
    window.__APP_VIZ3D = viz;   // CDP 测试标记(电影运镜断言)
  } catch { viz = null; }
}
if (!viz) {
  viz = new Visualizer(canvas);
  window.__APP_STARFIELD_3D = '0';
  window.__APP_VIZ2D = viz;    // CDP 测试标记
}
player.on('analyserready', (a) => viz.setAnalyser(a));
player.on('statechange', (s) => viz.setPlaying(s === 'playing'));

// ---------- 生命周期挂起(内存优化)+ 粒子场景总开关 ----------
// 窗口隐藏(最小化/标签切换/锁屏)→ 停可视化 rAF + 挂起 Web Audio(播放中不挂,音乐继续响);
// 壁纸视频解码休眠由 wallpaper.js 自行订阅;桌面歌词不接入(心跳必须跨最小化存活)。
// fx.sceneEnabled=false(视觉面板「粒子效果」关)→ 画布隐藏 + rAF 挂起,与隐藏态取或,互不覆盖。
let winHidden = false;
function applySceneFx() {
  const off = getFx().sceneEnabled === false;
  // 用 visibility 而非 display:none:画布尺寸仍可测,渲染器 resize 逻辑不受影响
  canvas.style.visibility = off ? 'hidden' : '';
  viz.setSuspended(winHidden || off);
}
onHidden(() => {
  winHidden = true;
  applySceneFx();
  player.suspendGraph();
});
onVisible(() => {
  winHidden = false;
  applySceneFx();
  player.resumeGraph();
});
subscribe((path) => {
  if (path === 'sceneEnabled') applySceneFx();
});
applySceneFx();

// ---------- 预取下一首的播放地址(URL 带时间戳会过期,提前备好减少切歌等待) ----------
player.on('songchange', ({ index }) => {
  const next = player.queue[index + 1];
  if (next) player.prefetch(next);
});

// ---------- 队列持久化 ----------
player.on('queuechange', () => saveQueue(player.queue, player.index));

// ---------- 快捷键(输入框内不生效) ----------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      player.toggle();
      break;
    case 'ArrowRight':
      if (e.ctrlKey) player.seek(player.getPosition() + 5);
      else player.next();
      break;
    case 'ArrowLeft':
      if (e.ctrlKey) player.seek(player.getPosition() - 5);
      else player.prev();
      break;
    case 'ArrowUp':
      e.preventDefault();
      player.setVolume(player.volume + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      player.setVolume(player.volume - 0.05);
      break;
  }
});

// ---------- 启动 ----------
// 生命周期状态机必须在各子系统订阅注册之后初始化(页面以 hidden 态加载时立即触发挂起)
initLifecycle();
// 旧登录态迁移(安全改造):老版 token 在非 HttpOnly cookie → localStorage,旧 cookie 服务端幂等清除;
// 必须在 initUI 之前,refreshLoginState 依赖 hasLogin() 的判定结果
migrateLegacyLogin();
initUI();
initFxPanel(document.getElementById('visual-pane')); // 视觉 DIY 控制台(右抽屉「视觉」标签页)
initWallpaper(document.getElementById('visual-pane')); // 壁纸模式(媒体层 + 面板文件区)
initDesktopLyrics(); // 桌面歌词(独立小窗桥,自绑定 playerbar 按钮)

// ---------- 队列恢复 ----------
// 必须在 initUI 之后:restoreQueue 发出的 songchange 事件需要 UI 监听已就位
const saved = loadQueue();
if (saved?.items?.length) player.restoreQueue(saved.items, saved.index);
