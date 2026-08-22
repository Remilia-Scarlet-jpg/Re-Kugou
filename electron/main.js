/**
 * RE:KG Electron 壳主进程。
 *
 * 启动序列:单实例锁 → 端口预检(3000/3001)→ utilityProcess 拉起两个内嵌服务
 * (api/app.js 以 env platform=lite 运行 + 根 server.js)→ HTTP 就绪轮询 →
 * 无边框主窗 loadURL http://localhost:3001(保持 cookie/BroadcastChannel/window.open 同源)。
 * 退出时显式 kill 两个子进程(Windows 父进程退出不会杀子进程,否则端口残留)。
 *
 * 桌词小窗:setWindowOpenHandler 拦截 window.open('/desktop-lyrics.html'),
 * 覆写为无边框透明置顶 BrowserWindow;页面内 moveBy 拖动/7s 自关逻辑零改动。
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, utilityProcess } = require('electron');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

// 安全:打包版剥离调试端口开关(--remote-debugging-port 等会让任何本机进程
// 无鉴权接管 CDP)。逃生门 REKG_ALLOW_DEBUG=1 仅供交付测试机(CLAUDE.md 测试约定)。
// 必须在 app ready 前调用,Chromium 解析命令行开关的时机在此之前。
if (app.isPackaged && !process.env.REKG_ALLOW_DEBUG) {
  for (const s of ['remote-debugging-port', 'inspect', 'inspect-brk', 'remote-debugging-address']) {
    app.commandLine.removeSwitch(s);
  }
}

// 更名迁移(星际音乐 → RE:KG,2026-08-14):productName 改 REKG 后,userData 默认目录
// 从 %APPDATA%\星际音乐 变为 %APPDATA%\REKG;启动早期把旧目录原地改名,
// 登录态/队列/壁纸/视觉参数等本地数据全部保留(目标已存在或改名失败则跳过)。
try {
  const oldDir = path.join(app.getPath('appData'), '星际音乐');
  const newDir = path.join(app.getPath('appData'), 'REKG');
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
} catch (e) {
  console.log('[vmp:main] userData migrate skipped: ' + (e?.message || e));
}

const API_PORT = 3000;
const WEB_PORT = 3001;
const APP_ID = 'com.vmp.starmusic';

// api 闭包经 extraResources 入包(asar 外、resources/staging/api)。from 必须是
// build/staging 整层:filter.js 硬编码拒绝 relative === "node_modules" 的根级条目,
// node_modules 只有作为子层(api/node_modules)才能通过过滤;dev 模式用项目根 api/。
// server.js 在 asar 内,utilityProcess 可直跑
const API_ENTRY = app.isPackaged
  ? path.join(process.resourcesPath, 'staging', 'api', 'app.js')
  : path.join(__dirname, '..', 'api', 'app.js');
const WEB_ENTRY = path.join(__dirname, '..', 'server.js');

let apiProc = null;
let serverProc = null;
let mainWindow = null;
let quitting = false;

app.setAppUserModelId(APP_ID); // 任务栏分组/通知归属
Menu.setApplicationMenu(null); // 去掉默认菜单 = 去掉 Ctrl+R / Ctrl+Shift+I 等加速键

// ---------- 单实例锁(顺带防止双开导致 3000/3001 端口自冲突) ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => fatal(`启动失败:${err && err.message}`));
}

// ---------- 工具 ----------
function portBusy(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

function probeHttp(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (r) => {
      r.resume(); // 任何 HTTP 响应都算就绪(根路径 404/302 不影响)
      res(true);
    });
    req.on('error', (e) => res({ ok: false, err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); res({ ok: false, err: 'timeout' }); });
    req.on('response', () => {});
  });
}

async function waitFor(port, ms, childDead) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < ms) {
    if (childDead()) return { ok: false, err: 'child exited' }; // child 已退出(如 EADDRINUSE)→ 快速失败
    const r = await probeHttp(port);
    if (r === true) return { ok: true };
    lastErr = (r && r.err) || 'no-answer';
    await new Promise((rr) => setTimeout(rr, 250));
  }
  return { ok: false, err: 'timeout, last=' + lastErr };
}

function fatal(msg) {
  console.error('[vmp:main] FATAL: ' + msg);
  dialog.showErrorBox('RE:KG', msg);
  app.quit();
}

function forkService(entry, env, tag) {
  // 备选降级:child_process.fork(entry, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env } })
  const p = utilityProcess.fork(entry, [], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
    serviceName: tag,
  });
  p.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${tag}:err] ${d}`));
  p.on('spawn', () => console.log(`[vmp:main] ${tag} spawn ok`));
  p.on('error', (e) => console.log(`[vmp:main] ${tag} fork error: ${e?.message || e}`));
  return p;
}

// ---------- 启动 ----------
async function bootstrap() {
  // 端口预检(单实例锁已挡自身双开,这里挡 start.bat 等服务占用)
  for (const p of [API_PORT, WEB_PORT]) {
    if (await portBusy(p)) {
      return fatal(`端口 ${p} 已被其他程序占用,请关闭占用程序后重试。\n\n本应用需要本地端口 3000 与 3001。`);
    }
  }

  // 拉起内嵌服务(硬性规则:酷狗 API 必须 lite 概念版模式;HOST 双保险只绑回环)
  apiProc = forkService(API_ENTRY, { platform: 'lite', PORT: String(API_PORT), HOST: '127.0.0.1' }, 'kugou-api');
  serverProc = forkService(WEB_ENTRY, { PORT: String(WEB_PORT) }, 'vmp-server');
  watchChild(apiProc, '酷狗 API 服务(:3000)');
  watchChild(serverProc, '本地服务(:3001)');

  // 注意:utilityProcess.exitCode 运行中为 undefined(实测,非文档所述 null),退出后为数字
  const okApi = await waitFor(API_PORT, 15000, () => !apiProc || typeof apiProc.exitCode === 'number');
  const okWeb = await waitFor(WEB_PORT, 15000, () => !serverProc || typeof serverProc.exitCode === 'number');
  if (!okApi.ok || !okWeb.ok) {
    return fatal(`内置音乐服务启动失败,应用即将关闭。\n(api: ${okApi.err} / web: ${okWeb.err})`);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,            // 无边框,页面内自绘控件(electron-shell.js)
    title: 'RE:KG',          // 页面加载前的瞬态标题(index.html <title> 同名)
    backgroundColor: '#08090b', // 与 --bg token 一致,防白闪
    show: false,             // ready-to-show 再显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  installWindowOpenHandler(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  mainWindow.loadURL(`http://localhost:${WEB_PORT}`);
}

// ---------- 桌词小窗(拦截 window.open,覆写为无边框透明置顶) ----------
function installWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler((details) => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1):3001\//.test(details.url)) {
      return { action: 'deny' }; // 只放行本应用页面
    }
    const f = details.features || '';
    const num = (k, d) => {
      const m = f.match(new RegExp('(?:^|,)\\s*' + k + '=(-?\\d+)'));
      return m ? Number(m[1]) : d;
    };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: num('width', 560),
        height: num('height', 300),
        x: num('left', undefined), // 主窗已按 vmp.desktopLyrics.v1 持久化位置传 left/top
        y: num('top', undefined),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        alwaysOnTop: true, // 浏览器版做不到的系统级置顶
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false, // 100ms 渲染定时器 + 心跳不受节流
        },
      },
    };
  });
}

// ---------- 窗口控件 IPC ----------
ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('win:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) { w.isMaximized() ? w.unmaximize() : w.maximize(); }
});

// ---------- 生命周期 ----------
// 注意:注册必须在 fork 之后(bootstrap 内调用),模块顶层时 proc 还是 null
function watchChild(p, name) {
  p.on('exit', (code) => {
    if (!quitting) fatal(`${name} 意外退出(code ${code}),应用即将关闭。`);
  });
}

app.on('before-quit', () => {
  quitting = true;
  try { apiProc?.kill(); } catch {}
  try { serverProc?.kill(); } catch {}
});
app.on('window-all-closed', () => app.quit());
