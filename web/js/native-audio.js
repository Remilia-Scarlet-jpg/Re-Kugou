/**
 * Android 后台播放桥(仅在安装版生效)。
 *
 * 做两件事:
 *  1. 播放状态/歌曲变化 → 交给原生前台服务,刷新通知栏与锁屏(没有前台服务,息屏后进程会被回收)
 *  2. 通知栏 / 锁屏 / 耳机按钮的动作 → 回到播放器执行
 *
 * 浏览器与桌面版没有这个插件,整个模块空转(window.Capacitor 为空即返回)。
 * 真机验证入口:window.__APP_NATIVE_AUDIO 标记 '1' / 最近一次上报的元信息。
 */
import { player } from './player.js';

function getPlugin() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  return (cap.Plugins && cap.Plugins.BackgroundAudio) || null;
}

/** 通知栏要显示的元信息 */
function meta() {
  const s = player.getCurrent?.() || {};
  return {
    title: s.name || 'RE:KG',
    artist: s.artist || '',
    playing: player.state === 'playing',
  };
}

export function initNativeAudio() {
  const plugin = getPlugin();
  if (!plugin) return;

  window.__APP_NATIVE_AUDIO = '1';
  let started = false;
  let lastSig = '';

  const push = (force = false) => {
    const m = meta();
    const sig = `${m.title}|${m.artist}|${m.playing}`;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    window.__APP_NATIVE_AUDIO_STATE = m;
    const call = started ? plugin.update(m) : plugin.start(m);
    started = true;
    Promise.resolve(call).catch(() => { /* 系统拒绝时静默:下次切歌再试 */ });
  };

  // 通知栏 / 锁屏 / 耳机按钮
  plugin.addListener('action', ({ action }) => {
    if (action === 'play') {
      if (player.state !== 'playing') player.toggle();
    } else if (action === 'pause') {
      if (player.state === 'playing') player.toggle();
    } else if (action === 'toggle') {
      player.toggle();
    } else if (action === 'next') {
      player.next();
    } else if (action === 'prev') {
      player.prev();
    }
  });

  player.on('songchange', () => push(true));
  player.on('statechange', () => push());
  push(true);

  // 页面销毁时收掉前台服务,避免通知栏留一条点不开的条目
  window.addEventListener('pagehide', () => {
    if (started) plugin.stop().catch(() => {});
  });
}
