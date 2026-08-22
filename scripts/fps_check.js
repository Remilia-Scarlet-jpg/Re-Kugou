/** fps 抽查:无头软渲染下测 rAF 帧率(真实 GPU 会更高)。前置:两服务已运行。 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEBUG_PORT = 9232;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-fps-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  let ws;
  try {
    for (let i = 0; i < 50; i++) { try { await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/version`); break; } catch { await sleep(200); } }
    const target = await httpReq('PUT', `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`).catch(() =>
      httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`));
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const pending = new Map(); let id = 0;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
      return r.result?.value;
    };
    await send('Page.navigate', { url: 'http://localhost:3001' });
    await sleep(2500);

    // 页面内数 2 秒 rAF 次数(该应用只有一个 rAF 循环)
    const fps = await ev(`(async()=>{
      let n=0;
      const t0=performance.now();
      await new Promise((res)=>{
        const tick=()=>{ n++; if(performance.now()-t0<2000) requestAnimationFrame(tick); else res(); };
        requestAnimationFrame(tick);
      });
      return Math.round(n/2);
    })()`);
    console.log('idle fps (headless soft-render):', fps);

    // 播放中再测一次
    const pick = await ev(`(async()=>{const els=[...document.querySelectorAll('.card')];
      for(let i=0;i<12;i++){const h=els[i].dataset.hash; if(!h) continue;
        try{const r=await fetch('/api/url?hash='+h); const d=await r.json();
        if(d.ok&&d.urls.length) return i;}catch{}}return -1;})()`);
    if (pick >= 0) {
      await ev(`document.querySelectorAll('.card')[${pick}].click()`);
      await sleep(2000);
      const fps2 = await ev(`(async()=>{
        let n=0;
        const t0=performance.now();
        await new Promise((res)=>{
          const tick=()=>{ n++; if(performance.now()-t0<2000) requestAnimationFrame(tick); else res(); };
          requestAnimationFrame(tick);
        });
        return Math.round(n/2);
      })()`);
      console.log('playing fps (headless soft-render):', fps2);
    }
  } catch (e) {
    console.log('ERR:', e.message);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    await sleep(200);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
})();
