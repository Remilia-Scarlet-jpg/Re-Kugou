/**
 * preload:向页面注入 window.__APP_CONFIG__(config.js 既有注入点)
 * 与 window.vmpShell(无边框窗口的最小化/关闭/最大化 + 生命周期通知 + 内存指标)。
 * contextIsolation + sandbox 全开,页面拿不到 ipcRenderer 本体。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__APP_CONFIG__', {
  electron: true,
  API_BASE: 'http://localhost:3000',
  URL_API: 'http://localhost:3001/api/url',
  PLAYLIST_API: 'http://localhost:3001/api/playlist',
});

contextBridge.exposeInMainWorld('vmpShell', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  // 生命周期:主窗 minimize/restore → 渲染进程挂起/恢复重型子系统(内存优化)
  onWindowHidden: (cb) => { ipcRenderer.on('app:hidden', (_e, hidden) => cb(Boolean(hidden))); },
  // 内存指标:app.getAppMetrics() 工作集快照(排查/测试用)
  getMetrics: () => ipcRenderer.invoke('app:metrics'),
});
