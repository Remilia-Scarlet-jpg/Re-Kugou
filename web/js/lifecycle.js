/**
 * 生命周期状态机(内存优化):主窗 active ⇄ hidden,隐藏即挂起各重型子系统。
 *
 * 信号源(双信号取或:hidden 只要任一源隐藏;visible 需两者均可见):
 *  - visibility:document.visibilitychange(浏览器标签切换 / Windows 锁屏)
 *  - electron:主进程 minimize/restore IPC(vmpShell.onWindowHidden,仅安装版)
 *
 * 订阅者:wallpaper.js(视频壁纸解码休眠)、main.js(3D/2D rAF 挂起 + Web Audio 挂起)。
 * 桌面歌词不接入本状态机:其心跳/推送必须跨最小化存活(最小化时看歌词正是该功能的使用场景)。
 *
 * 测试约定:window.__APP_LIFECYCLE('active'|'hidden')+ __APP_LIFECYCLE_API.hide()/show()
 * (CDP 无法伪造 visibilitychange 可信事件,测试经 API 走同一状态转移路径)。
 */
const signals = { visibility: true, electron: true };
let hidden = false;
const hooks = { hide: [], show: [] };

function recompute() {
  const next = !(signals.visibility && signals.electron);
  if (next === hidden) return;
  hidden = next;
  window.__APP_LIFECYCLE = hidden ? 'hidden' : 'active';
  hooks[hidden ? 'hide' : 'show'].forEach((fn) => fn());
}

function setSignal(name, visible) {
  if (signals[name] === visible) return;
  signals[name] = visible;
  recompute();
}

/** 必须在各子系统订阅注册之后调用:页面以 hidden 态加载时立即触发一次挂起 */
export function initLifecycle() {
  document.addEventListener('visibilitychange', () => setSignal('visibility', !document.hidden));
  if (window.vmpShell?.onWindowHidden) {
    window.vmpShell.onWindowHidden((h) => setSignal('electron', !h));
  }
  setSignal('visibility', !document.hidden);
}

export function onHidden(fn) { hooks.hide.push(fn); }
export function onVisible(fn) { hooks.show.push(fn); }
export function isHidden() { return hidden; }

window.__APP_LIFECYCLE = 'active';
window.__APP_LIFECYCLE_API = {
  hide: () => setSignal('visibility', false),
  show: () => setSignal('visibility', true),
  isHidden: () => hidden,
};
