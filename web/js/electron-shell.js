/**
 * Electron 壳控件:仅安装版注入(window.__APP_CONFIG__.electron)。
 * 浏览器模式:整个模块空操作,不产生任何 DOM。
 * 内容:顶部 32px 透明拖拽条(-webkit-app-region:drag)+ 右上角玻璃胶囊「─ ✕」;
 * 双击拖拽条最大化/还原;标记 window.__APP_ELECTRON_SHELL='1'(测试约定)。
 */
if (window.__APP_CONFIG__?.electron && window.vmpShell) {
  document.body.dataset.electron = '1'; // 解锁 style.css 的 body[data-electron] 规则(login-btn 下移等)

  const bar = document.createElement('div');
  bar.id = 'win-bar';
  bar.title = '拖动窗口 · 双击最大化/还原';

  const pill = document.createElement('div');
  pill.id = 'win-controls';

  const min = document.createElement('button');
  min.id = 'win-min';
  min.className = 'win-btn';
  min.title = '最小化';
  min.textContent = '─';

  const close = document.createElement('button');
  close.id = 'win-close';
  close.className = 'win-btn';
  close.title = '关闭';
  close.textContent = '✕';

  pill.append(min, close);
  bar.appendChild(pill);
  document.body.appendChild(bar);

  min.addEventListener('click', () => window.vmpShell.minimize());
  close.addEventListener('click', () => window.vmpShell.close());
  bar.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.win-btn')) window.vmpShell.toggleMaximize();
  });

  window.__APP_ELECTRON_SHELL = '1';
}
