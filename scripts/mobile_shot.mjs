/**
 * 手机视口截图工具(Android 移植专用,零依赖:Node 22+ 内置 WebSocket)。
 *
 * 用法:node scripts/mobile_shot.mjs [宽] [高] [输出文件]
 *   默认 390x844(iPhone 12/13 竖屏)/ DPR 3,输出到 %TEMP%\mobile_shot.png
 *
 * 前提:
 *   1. root server.js 在 3001 跑着(web/ 按请求现读,改完 CSS 刷新即生效)
 *   2. Chrome 以调试端口启动,例如:
 *      Start-Process chrome.exe -ArgumentList '--headless=new','--remote-debugging-port=9333',
 *        '--user-data-dir=%TEMP%\rekg-shot','--no-first-run','about:blank'
 *
 * 说明:attach 现有 target 用 /json/list(新版 Chrome 的 /json/new 要用 PUT,不可靠);
 *      截图落地在 TEMP(沙箱下工作区可能不可写),打印出绝对路径供读取。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.CDP_PORT || 9333);
const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const DPR = Number(process.env.DPR || 3);
const URL_ = process.env.URL || 'http://127.0.0.1:3001/';
const OUT = process.argv[4] || join(tmpdir(), 'mobile_shot.png');
const MOBILE = process.env.DESKTOP !== '1'; // DESKTOP=1 时按桌面 UA/视口截

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端:id → resolve 映射 + 事件等待 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners) fn(m);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners.delete(fn); reject(new Error(`timeout waiting ${method}`)); }, timeout);
      const fn = (m) => { if (m.method === method) { clearTimeout(t); this.listeners.delete(fn); resolve(m.params); } };
      this.listeners.add(fn);
    });
  }
}

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('找不到 page target(Chrome 是否以 --headless=new 启动?)');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('CDP WebSocket 连接失败')); });
const cdp = new CDP(ws);

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: DPR, mobile: MOBILE,
  screenWidth: W, screenHeight: H,
});
if (MOBILE) {
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  });
} else {
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
}
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: MOBILE, maxTouchPoints: MOBILE ? 5 : 1 });

const loaded = cdp.once('Page.loadEventFired');
await cdp.send('Page.navigate', { url: URL_ });
try { await loaded; } catch { /* 有些情况下事件先到,忽略 */ }
await sleep(Number(process.env.WAIT || 3500)); // 等推荐/榜单数据与字体渲染

// 顺带把关键布局尺寸打出来,便于判断有没有横向溢出
const probe = await cdp.send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const q = (s) => document.querySelector(s);
    const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
      scrollW: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      playerbar: box('.playerbar'), np: box('.np'), volume: box('.volume'),
      controls: box('.controls'), drawerTab: box('.drawer-tab'),
      hideBtn: box('#ui-hide-btn'), chips: [...document.querySelectorAll('.np .chip')].map((e) => e.id),
    };
  })()`,
});

const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify({ out: OUT, size: `${W}x${H}@${DPR}x`, layout: probe.result.value }, null, 2));
ws.close();
