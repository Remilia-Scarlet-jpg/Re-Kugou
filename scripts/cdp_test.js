/**
 * 全流程功能测试:通过 Chrome DevTools Protocol 驱动无头浏览器,零依赖(Node ≥22 自带 WebSocket)。
 *
 * 前置:app_win.exe(:3000)与 server.js(:3001)已运行。
 * 用法:node scripts/cdp_test.js [搜索关键词] [目标专辑名] [专辑行号]
 *
 * 覆盖:推荐页渲染 → 点歌播放(URL 解析 + Web Audio 管线)→ 空格暂停/恢复 →
 *      专辑搜索→专辑歌曲→歌词高亮+seek → 榜单两级 → 歌单两级可播(仅前 10 首)→
 *      我的歌单粘贴链接添加/持久化/移除 → 刷新后队列恢复 → 登录入口(抽屉用户大标题)S10 →
 *      音乐壁纸布局 S11 → 视觉 DIY 控制台 S12a/b → 电影运镜 S12d →
 *      壁纸模式 S12e → 桌面歌词小窗 S12c/f →
 *      视频壁纸大文件 S14(1000MB 上限判定/配额预检)→
 *      登录态持久化 S15(持久 cookie 重写)→ 歌单输入兜底 S16(按名称搜索添加)→
 *      歌曲搜索 S17(类型切换 + type=lyric 通道 + 点卡片即播)→
 *      分享歌单封面补全 S18(/images 通道 + 歌词抽屉封面)→
 *      新式概念版分享链接 S19(activity.kugou.com 壳 → H5 签名接口全量曲目)→
 *      音量数字 S20 / 本地音频播放 S21(合成 WAV + 刷新回放)/ ID3 解析 S21b /
 *      本地歌单 S22(建单·点播·移除 GC)→ 桌词三修复 S23(墙钟同步·字号连点·滑杆守卫·尺寸钳制)→
 *      安全断言 S24(CORS 白名单·禁用路由 404·SSRF 拦截·安全头·Cookie 属性·CSP meta)→
 *      旧登录态迁移 S25(legacy cookie → localStorage + /auth/logout)→
 *      播放模式 S26(btn-mode 三态·vmp.playmode.v1 持久化·ended 切歌行为)→
 *      本地歌单增强 S27(在线歌加入歌单·弹层选择·自定义封面)→
 *      生命周期内存优化 S28(hidden 壁纸视频解码休眠·rAF 挂起·Web Audio 挂起·恢复)→
 *      全程无未捕获异常。每步失败互不阻断。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:3001';
const DEBUG_PORT = 9229;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// VMP_CDP_USE_EXISTING=1:不自启 Chrome,attach 已运行的调试目标(Electron 安装版/开发版
// 以 --remote-debugging-port=9229 启动时使用;/json/new 在 Electron 下不可靠,直接 attach 现有 target)
const USE_EXISTING = process.env.VMP_CDP_USE_EXISTING === '1';

// 专辑流参数(酷狗版权导致不同专辑可播性差异大,可通过 argv 覆盖)
const [, , KW = '山风山风等等我', ALBUM = '山风山风等等我', ALBUM_ROW = '0'] = process.argv;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- CDP 客户端 ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const e = msg.params.exceptionDetails;
        this.exceptions.push(e.exception?.description || e.text || 'unknown exception');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.consoleErrors.push(`${msg.params.entry.text} [${msg.params.entry.url || ''}]`);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

function httpReq(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json from ' + url)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 直连 HTTP 请求:返回原始 {status,headers,body}(headers 键为小写)。
// S24 安全段用:断言 CORS/安全头/Set-Cookie 属性,httpReq 只回 JSON 拿不到头
function httpRaw(method, url, headers = {}, payload = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function waitDebugPort() {
  for (let i = 0; i < 50; i++) {
    try {
      await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return;
    } catch { await sleep(200); }
  }
  throw new Error('Chrome debug port never came up');
}

async function newTarget() {
  if (USE_EXISTING) {
    // 首启竞态:CDP 端口先于主窗 target 出现(安装版实测),带 5s 重试
    for (let i = 0; i < 10; i++) {
      const list = await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const arr = Array.isArray(list) ? list : [];
      const t = arr.find((x) => x.type === 'page' && /localhost:3001/.test(x.url || ''))
        || arr.find((x) => x.type === 'page');
      if (t) return t;
      await sleep(500);
    }
    throw new Error('未找到 Electron 主窗 target(需先以 --remote-debugging-port 启动应用)');
  }
  try {
    return await httpReq('PUT', `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`);
  } catch {
    return await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`);
  }
}

// ---------- 主流程 ----------
(async () => {
  const userDataDir = USE_EXISTING ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-cdp-'));
  const chrome = USE_EXISTING ? null : spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--disable-popup-blocking',
    '--window-size=1600,900',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    await waitDebugPort();
    const target = await newTarget();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('页面异常: ' + ((d.exception?.description || d.text || 'unknown').slice(0, 200)) + ' @ ' + expr.slice(0, 80));
      }
      return r.result?.value;
    };
    const poll = async (expr, timeout = 20000, interval = 500) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await ev(expr)) return true; } catch { return false; }
        await sleep(interval);
      }
      return false;
    };
    // 环境噪声判定(S9 审计豁免):酷狗 CDN CORS(无 ACAO,自动顺延下一候选是设计行为)、
    // trackercdn 超时 504、酷狗搜索/列表上游 502/504(内容断言由各 S 段把关,此处只免日志)
    const isEnvNoise = (e) =>
      (e.includes('kugou.com') && (e.includes('CORS policy') || e.includes('net::ERR_FAILED')))
      || (e.includes('/api/url') && e.includes('504'))
      || ((e.includes('502') || e.includes('504')) && e.includes('localhost:3000'));
    // 在页面内通过 /api/url 逐个探测 data-hash,返回第一个可播元素的下标;探不到返回 -1
    const playableIdxExpr = (sel, limit) => `(async()=>{
      const els=[...document.querySelectorAll('${sel}')].slice(0,${limit});
      for(let i=0;i<els.length;i++){
        const h=els[i].dataset.hash; if(!h) continue;
        try{ const r=await fetch('/api/url?hash='+encodeURIComponent(h)); const d=await r.json();
          if(d.ok && d.urls && d.urls.length) return i; }catch{}
      }
      return -1;
    })()`;

    // 音乐壁纸布局:导航/搜索在右侧抽屉内,先开抽屉再操作(已开则直接返回)
    const openDrawer = async () => {
      await ev("(()=>{const d=document.getElementById('right-drawer'); if(d.classList.contains('open')) return true; document.querySelector('.drawer-tab').click(); return document.getElementById('right-drawer').classList.contains('open');})()");
      await sleep(400); // 等 0.28s 滑入过渡完成
    };

    // 找已打开的页面目标(桌面歌词小窗等),返回 target 或 null;
    // 带重试:Electron 下新 BrowserWindow 的 target 上 /json/list 有竞态(重开小窗时偶发)
    const attachTarget = async (urlPart, timeout = 10000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const list = await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/list`);
        const arr = Array.isArray(list) ? list : [];
        const t = arr.find((x) => x.type === 'page' && (x.url || '').includes(urlPart));
        if (t) return t;
        await sleep(500);
      }
      return null;
    };

    const step = async (name, fn) => {
      try { await fn(); } catch (err) { check(name + '(驱动异常)', false, err.message); }
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    // S1 推荐页渲染
    await step('S1', async () => {
      const cards = await ev("document.querySelectorAll('.card').length");
      const unknown = await ev("[...document.querySelectorAll('.card-sub')].filter(e=>e.textContent==='未知歌手').length");
      const name1 = await ev("document.querySelector('.card-name')?.textContent || ''");
      check('S1 推荐页:卡片 ≥20', cards >= 20, `${cards} 张`);
      check('S1 推荐页:歌手名已归一化(无「未知歌手」)', unknown === 0, `未知 ${unknown} 张,首张「${name1}」`);
      // 热搜功能已移除:抽屉内不得再有 #hot-chips 容器或热搜词条
      const hot = await ev("document.querySelectorAll('#hot-chips, .hot-chips, .hot-label').length");
      check('S1 热搜已移除:抽屉无热搜容器/词条', hot === 0, `${hot} 个残留`);
    });

    // S2 点歌播放:URL 解析 → audio 播放 → Web Audio 管线构建
    await step('S2', async () => {
      const pick = await ev(playableIdxExpr('.card', 12));
      await ev(`document.querySelectorAll('.card')[${pick >= 0 ? pick : 0}].click()`);
      const started = await poll(
        "(()=>{const a=document.getElementById('audio');return a.src.startsWith('http') && !a.paused;})()", 25000);
      const src = await ev("document.getElementById('audio').src");
      // 播放条同步要等 loadedmetadata + playing 事件(trackercdn 节点慢时二者晚到,
      // src 已设但时长仍是 --:--、按钮仍是 ▶)→ 用 poll 替代瞬时读,防上游抖动误报
      const sync = await poll(
        "(()=>{const a=document.getElementById('audio');return !a.paused && document.getElementById('np-name').textContent!=='未在播放' && document.getElementById('time-dur').textContent!=='--:--' && document.getElementById('btn-play').textContent==='⏸';})()", 15000);
      const np = await ev("document.getElementById('np-name').textContent");
      const dur = await ev("document.getElementById('time-dur').textContent");
      const btn = await ev("document.getElementById('btn-play').textContent");
      const analyser = await ev("(async()=>{const {player}=await import('/js/player.js');return !!player.getAnalyser();})()");
      const t1 = await ev("document.getElementById('audio').currentTime");
      await sleep(1600);
      const t2 = await ev("document.getElementById('audio').currentTime");
      check('S2 播放:点击卡片后开始出声', started, `src=${(src || '').slice(0, 60)}`);
      check('S2 播放:播放条同步(np-name/时长/按钮)', sync === true, `「${np}」 ${dur} ${btn}`);
      check('S2 播放:Web Audio 分析管线已构建', analyser === true);
      check('S2 播放:进度前进', t2 > t1, `${t1.toFixed(2)}s → ${t2.toFixed(2)}s`);
    });

    // S3 空格暂停/恢复(快捷键)
    await step('S3', async () => {
      const pressSpace = async () => {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await sleep(400);
      };
      await pressSpace();
      check('S3 快捷键:空格暂停', await ev("document.getElementById('audio').paused") === true);
      await pressSpace();
      check('S3 快捷键:空格恢复', await ev("!document.getElementById('audio').paused") === true);
    });

    // S4 专辑流:搜索关键词 → 目标专辑 → 指定行 → 歌词抽屉高亮 + seek
    await step('S4', async () => {
      await openDrawer();
      await ev("document.querySelector('.nav-item[data-view=album]').click()");
      await ev(`document.getElementById('search-input').value = ${JSON.stringify(KW)}`);
      await ev("document.getElementById('search-btn').click()");
      const albumOk = await poll("document.querySelectorAll('.card').length > 0");
      const firstAlbum = await ev("document.querySelector('.card-name')?.textContent || ''");
      check('S4 专辑:搜索出专辑卡片', albumOk, `首张「${firstAlbum}」`);

      await ev(`[...document.querySelectorAll('.card')].find(c=>c.querySelector('.card-name').textContent===${JSON.stringify(ALBUM)})?.click()`);
      const rows = await poll("document.querySelectorAll('.song-row').length > 0");
      const rowNames = await ev("[...document.querySelectorAll('.row-name')].slice(0,4).map(e=>e.textContent).join('/')");
      const rowCount = await ev("document.querySelectorAll('.song-row').length");
      check(`S4 专辑:${ALBUM} 歌曲列表`, rows && rowCount >= 1, `前四首:${rowNames}`);

      const row = Number(ALBUM_ROW);
      await ev(`document.querySelectorAll('.song-row')[${row}].click()`);
      const rowPlaying = await poll(
        `(()=>{const a=document.getElementById('audio');const np=document.getElementById('np-name').textContent;const r=[...document.querySelectorAll('.song-row')][${row}];return a.src && !a.paused && r && r.querySelector('.row-name').textContent===np;})()`, 25000);
      check(`S4 专辑:第 ${row + 1} 首开始播放且播放条同步`, rowPlaying);
      check('S4 专辑:当前行均衡条动画', await poll("!!document.querySelector('.song-row.playing .eq')"));

      // 歌词
      await ev("document.getElementById('lyric-toggle').click()");
      const lyricOk = await poll("document.querySelectorAll('.lyric-line').length > 0", 15000);
      const lineCount = await ev("document.querySelectorAll('.lyric-line').length");
      check('S4 歌词:抽屉出歌词行', lyricOk, `${lineCount} 行`);

      if (lyricOk) {
        const target = await ev("(()=>{const l=[...document.querySelectorAll('.lyric-line')];return l.length>1 ? Number(l[1].dataset.t)+0.3 : 0;})()");
        await ev(`(async()=>{const {player}=await import('/js/player.js');player.seek(${target});return true;})()`);
        const activeOk = await poll(
          `(()=>{const act=document.querySelector('.lyric-line.active');return act && Number(act.dataset.t) <= ${target};})()`, 8000);
        check('S4 歌词:seek 后高亮跟随', activeOk, `seek→${target}s`);
      }
      await ev("document.getElementById('lyric-close').click()");
    });

    // S5 榜单两级
    await step('S5', async () => {
      await openDrawer();
      await ev("document.querySelector('.nav-item[data-view=rank]').click()");
      const rankOk = await poll("document.querySelectorAll('.card').length > 0");
      const rankName = await ev("document.querySelector('.card-name')?.textContent || ''");
      check('S5 榜单:榜单列表渲染', rankOk, `首榜「${rankName}」`);
      await ev("document.querySelector('.card').click()");
      const rankRows = await poll("document.querySelectorAll('.song-row').length > 0");
      const rankRowCount = await ev("document.querySelectorAll('.song-row').length");
      check('S5 榜单:榜单歌曲列表 ≥10', rankRows && rankRowCount >= 10, `${rankRowCount} 首`);
      // 榜单热门曲版权锁定多,探测第一个可播行再点击
      const pick = await ev(playableIdxExpr('.song-row', 30));
      check('S5 榜单:存在可播行', pick >= 0, pick >= 0 ? `第 ${pick + 1} 行` : '全部无源');
      if (pick >= 0) {
        await ev(`document.querySelectorAll('.song-row')[${pick}].click()`);
        check('S5 榜单:榜单歌曲可播放', await poll("!document.getElementById('audio').paused", 25000));
      }
    });

    // S6 歌单:搜索 → 卡片 → 曲目列表(接口仅前 10 首)→ 可播行播放 → 返回列表
    await step('S6', async () => {
      await openDrawer();
      await ev("document.querySelector('.st-btn[data-type=playlist]').click()");
      await ev("document.getElementById('search-input').value = '轻音乐'");
      await ev("document.getElementById('search-btn').click()");
      const pOk = await poll("document.querySelectorAll('.card').length > 0");
      const pCount = await ev("document.querySelectorAll('.card').length");
      check('S6 歌单:搜索出歌单卡片', pOk, `${pCount} 个`);
      if (!pOk) return;
      // 逐个尝试卡片(私有歌单会出错误提示),直到打开曲目列表
      let rowCount = 0;
      for (let i = 0; i < Math.min(pCount, 6) && rowCount === 0; i++) {
        if (await ev("document.querySelectorAll('.card').length") <= i) break; // 卡片列表未恢复则不再点
        await ev(`document.querySelectorAll('.card')[${i}].click()`);
        // 等待曲目列表或错误空态(注意排除加载态:loadingBox 也带 state-box 类但含 spinner)
        await poll(
          "document.querySelectorAll('.song-row').length > 0 || [...document.querySelectorAll('.state-box')].some(b=>!b.querySelector('.spinner'))",
          8000);
        rowCount = await ev("document.querySelectorAll('.song-row').length");
        if (rowCount === 0) {
          await ev("document.querySelector('.back-btn')?.click()"); // 错误提示 → 返回卡片列表
          const cardsBack = await poll("document.querySelectorAll('.card').length > 0", 8000);
          if (!cardsBack) break;
        }
      }
      check('S6 歌单:点击卡片出曲目列表', rowCount > 0, `${rowCount} 行`);
      check('S6 歌单:接口仅提供前 10 首(≤10)', rowCount > 0 && rowCount <= 10);
      if (rowCount > 0) {
        const pick = await ev(playableIdxExpr('.song-row', 10));
        check('S6 歌单:存在可播行', pick >= 0, pick >= 0 ? `第 ${pick + 1} 行` : '全部无源');
        if (pick >= 0) {
          await ev(`document.querySelectorAll('.song-row')[${pick}].click()`);
          check('S6 歌单:歌单歌曲可播放', await poll("!document.getElementById('audio').paused", 25000));
        }
        await ev("document.querySelector('.back-btn').click()");
        check('S6 歌单:返回歌单列表', await poll("document.querySelectorAll('.card').length > 0"));
      }
    });

    // S7 刷新后队列恢复(不自动播放)
    await step('S7', async () => {
      await cdp.send('Page.reload');
      await sleep(2500);
      const np = await ev("document.getElementById('np-name').textContent");
      const btn = await ev("document.getElementById('btn-play').textContent");
      // 恢复路径可能有短暂 ⏸ 瞬态,轮询最终不自动播放的稳态
      const restored = await poll("document.getElementById('np-name').textContent !== '未在播放' && document.getElementById('btn-play').textContent === '▶'", 10000);
      check('S7 持久化:刷新后队列恢复', restored, `当前「${np}」按钮 ${btn}`);
    });

    // S8 我的歌单:粘贴歌单链接添加 → 出卡片 → 点开出曲目列表 → 可播 → 返回/移除
    await step('S8', async () => {
      await openDrawer();
      await ev("document.querySelector('.nav-item[data-view=my]').click()");
      const hasInput = await poll("!!document.getElementById('my-input')", 8000);
      check('S8 我的歌单:添加输入框存在', hasInput);
      if (!hasInput) return;
      await ev("localStorage.removeItem('vmp.myplaylists.v1')"); // 清空旧数据保证可重复
      await ev("document.getElementById('my-input').value = 'https://m.kugou.com/plist/list/4172964'");
      await ev("document.getElementById('my-add-btn').click()");
      const cardOk = await poll("document.querySelectorAll('#main .card').length > 0", 15000);
      const cardName = await ev("document.querySelector('#main .card .card-name')?.textContent || ''");
      check('S8 我的歌单:粘贴链接添加成功', cardOk, `「${cardName}」`);
      if (!cardOk) return;
      // store.js 防抖写盘(约 300ms),读前轮询等落盘
      const savedOk = await poll("JSON.parse(localStorage.getItem('vmp.myplaylists.v1') || '[]').length === 1", 4000);
      const saved = await ev("JSON.parse(localStorage.getItem('vmp.myplaylists.v1') || '[]').length");
      check('S8 我的歌单:已持久化到本地', savedOk, `${saved} 条`);
      await ev("document.querySelector('#main .card').click()");
      const rows = await poll("document.querySelectorAll('.song-row').length > 0", 10000);
      const rowCount = await ev("document.querySelectorAll('.song-row').length");
      check('S8 我的歌单:歌单曲目列表', rows, `${rowCount} 行`);
      if (rows) {
        const pick = await ev(playableIdxExpr('.song-row', 10));
        check('S8 我的歌单:存在可播行', pick >= 0, pick >= 0 ? `第 ${pick + 1} 行` : '全部无源');
        if (pick >= 0) {
          await ev(`document.querySelectorAll('.song-row')[${pick}].click()`);
          check('S8 我的歌单:歌单歌曲可播放', await poll("!document.getElementById('audio').paused", 25000));
        }
        await ev("document.querySelector('.back-btn').click()");
        check('S8 我的歌单:返回我的歌单', await poll("document.querySelectorAll('#main .card').length > 0"));
        await ev("document.querySelector('.card-remove').click()");
        check('S8 我的歌单:移除歌单', await poll("document.querySelectorAll('#main .card').length === 0", 5000));
      }
    });

    // S8b 我的歌单:真实 t1 短链(酷狗 App 分享)→ 分享页完整曲目列表(>10 首)→ 重命名 → 移除
    await step('S8b', async () => {
      await openDrawer();
      await ev("localStorage.removeItem('vmp.myplaylists.v1')"); // 清空旧数据再进视图,与 S8 残留解耦
      await ev("document.querySelector('.nav-item[data-view=my]').click()");
      await poll("!!document.getElementById('my-input')", 8000);
      await ev("document.getElementById('my-input').value = 'https://t1.kugou.com/3siURc0G4V2'");
      await ev("document.getElementById('my-add-btn').click()");
      const cardOk = await poll("document.querySelectorAll('#main .card').length > 0", 25000);
      const cardName = await ev("document.querySelector('#main .card .card-name')?.textContent || ''");
      check('S8b 短链:分享链接添加成功', cardOk, `「${cardName}」`);
      if (!cardOk) return;
      const saved = await ev("JSON.parse(localStorage.getItem('vmp.myplaylists.v1') || '[]')");
      check(
        'S8b 短链:以链接为持久化键',
        saved.length === 1 && /^https?:/.test(saved[0]?.specialid || ''),
        saved[0]?.specialid ? saved[0].specialid.slice(0, 40) + '…' : '无'
      );
      const sub = await ev("document.querySelector('#main .card .card-sub')?.textContent || ''");
      check('S8b 短链:卡片标注分享链接+首数', sub.includes('分享链接') && sub.includes('100'), sub);
      await ev("document.querySelector('#main .card').click()");
      const rows = await poll("document.querySelectorAll('.song-row').length > 10", 15000);
      const rowCount = await ev("document.querySelectorAll('.song-row').length");
      check('S8b 短链:完整曲目列表(>10 首)', rows, `${rowCount} 首`);
      if (rows) {
        const pick = await ev(playableIdxExpr('.song-row', Math.min(rowCount, 40)));
        check('S8b 短链:存在可播行', pick >= 0, pick >= 0 ? `第 ${pick + 1} 行` : '全部无源');
        if (pick >= 0) {
          await ev(`document.querySelectorAll('.song-row')[${pick}].click()`);
          check('S8b 短链:歌曲可播放', await poll("!document.getElementById('audio').paused", 25000));
        }
        await ev("document.querySelector('.back-btn').click()");
        await poll("document.querySelectorAll('#main .card').length > 0");
        // 重命名:✏️ → 输入 → Enter → 卡片名更新且持久化
        await ev("document.querySelector('.card-rename').click()");
        const hasInput = await poll("!!document.querySelector('.card-rename-input')", 5000);
        await ev("document.querySelector('.card-rename-input').value = '重命名测试'");
        await ev("const el = document.querySelector('.card-rename-input'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
        const renamed = await poll("document.querySelector('#main .card .card-name')?.textContent === '重命名测试'", 5000);
        check('S8b 短链:卡片可重命名', hasInput && renamed);
        await ev("document.querySelector('.card-remove').click()");
        check('S8b 短链:移除分享歌单', await poll("document.querySelectorAll('#main .card').length === 0", 5000));
      }
    });

    // S18 分享歌单封面补全:导入的歌 img 为空 → 播放后凭 album_id 走 /images 补全 → 播放条 + 歌词抽屉显示
    await step('S18', async () => {
      await openDrawer();
      await ev("localStorage.removeItem('vmp.myplaylists.v1')");
      await ev("document.querySelector('.nav-item[data-view=my]').click()");
      await poll("!!document.getElementById('my-input')", 8000);
      await ev("document.getElementById('my-input').value = 'https://t1.kugou.com/3siURc0G4V2'");
      await ev("document.getElementById('my-add-btn').click()");
      const cardOk = await poll("document.querySelectorAll('#main .card').length > 0", 25000);
      check('S18 封面:分享歌单导入成功', cardOk);
      if (!cardOk) return;
      await ev("document.querySelector('#main .card').click()");
      const rows = await poll("document.querySelectorAll('.song-row').length > 10", 15000);
      check('S18 封面:曲目列表加载(>10 行)', rows);
      if (!rows) return;
      const pick = await ev(playableIdxExpr('.song-row', 40));
      check('S18 封面:存在可播行', pick >= 0, pick >= 0 ? `第 ${pick + 1} 行` : '全部无源');
      if (pick < 0) return;
      // 分享页解析的歌 img 为空(占位音符),播放后 onSongChange 触发补全
      await ev(`document.querySelectorAll('.song-row')[${pick}].click()`);
      const coverFilled = await poll(
        "(()=>{const c=document.getElementById('np-cover');return c.src.startsWith('http');})()",
        20000
      );
      check('S18 封面:播放条封面补全', coverFilled, await ev("document.getElementById('np-cover').src.slice(0, 90)"));
      await ev("document.getElementById('lyric-toggle').click()");
      const lyricCover = await poll("document.getElementById('lyric-cover').src.startsWith('http')", 8000);
      check('S18 封面:歌词抽屉封面显示', lyricCover);
      const title = await ev("document.getElementById('lyric-title').textContent || ''");
      check('S18 封面:歌词标题为歌曲名', title.length > 2 && title !== '歌词', title.slice(0, 40));
      await ev("document.getElementById('lyric-close').click()");
      await ev("document.querySelector('.back-btn').click()");
      await poll("document.querySelectorAll('#main .card').length > 0");
      await ev("document.querySelector('.card-remove').click()");
      check('S18 封面:移除分享歌单', await poll("document.querySelectorAll('#main .card').length === 0", 5000));
    });

    // S19 新式概念版分享链接(activity.kugou.com SPA 壳):t1 短链 → global_specialid → H5 签名接口全量 145 首,自带封面
    await step('S19', async () => {
      await openDrawer();
      await ev("localStorage.removeItem('vmp.myplaylists.v1')");
      await ev("document.querySelector('.nav-item[data-view=my]').click()");
      await poll("!!document.getElementById('my-input')", 8000);
      await ev("document.getElementById('my-input').value = 'https://t1.kugou.com/4q6A9d6G4V2'");
      await ev("document.getElementById('my-add-btn').click()");
      const cardOk = await poll("document.querySelectorAll('#main .card').length > 0", 30000);
      check('S19 概念版短链:分享链接添加成功', cardOk);
      if (!cardOk) return;
      const cardName = await ev("document.querySelector('#main .card .card-name')?.textContent || ''");
      check('S19 概念版短链:全量歌曲数(145 首)', cardName === '分享歌单(145首)', cardName);
      const sub = await ev("document.querySelector('#main .card .card-sub')?.textContent || ''");
      check('S19 概念版短链:卡片标注完整列表', sub.includes('145') && sub.includes('分享链接'), sub);
      await ev("document.querySelector('#main .card').click()");
      const rows = await poll("document.querySelectorAll('.song-row').length > 100", 20000);
      const rowCount = await ev("document.querySelectorAll('.song-row').length");
      check('S19 概念版短链:完整曲目列表(>100 首)', rows, `${rowCount} 首`);
      if (!rows) return;
      // 新通道每首自带封面({size} 占位经 fixImgUrl 替换),行内缩略图应为 http 真封面
      const rowCover = await ev("document.querySelector('.song-row .row-cover')?.src || ''");
      check('S19 概念版短链:曲目自带封面(无需补全)', rowCover.startsWith('http'), rowCover.slice(0, 80));
      const pick = await ev(playableIdxExpr('.song-row', 40));
      check('S19 概念版短链:存在可播行', pick >= 0, pick >= 0 ? `第 ${pick + 1} 行` : '全部无源');
      if (pick < 0) return;
      await ev(`document.querySelectorAll('.song-row')[${pick}].click()`);
      const npCover = await poll("document.getElementById('np-cover').src.startsWith('http')", 20000);
      check('S19 概念版短链:播放条封面显示', npCover);
      await ev("document.querySelector('.back-btn').click()");
      await poll("document.querySelectorAll('#main .card').length > 0");
      await ev("document.querySelector('.card-remove').click()");
      check('S19 概念版短链:移除分享歌单', await poll("document.querySelectorAll('#main .card').length === 0", 5000));
    });

    // ---------- S20-S23 音量数字 + 本地音乐 + 桌词三修复(2026-08-16) ----------
    // 合成 WAV 夹具:8kHz/8bit 单声道静音(30s=240KB,确定性字节流,原生可解码);
    // Page.reload 会清空 window 变量,各段开始处按需重建
    const mkWavFixtures = () => ev(`(()=>{
      window.__mkWav = (sec, fill) => {
        const rate = 8000, n = rate * sec;
        const b = new ArrayBuffer(44 + n), dv = new DataView(b), u8 = new Uint8Array(b);
        const ws = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
        ws(0, 'RIFF'); dv.setUint32(4, 36 + n, true); ws(8, 'WAVE');
        ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
        ws(36, 'data'); dv.setUint32(40, n, true);
        for (let i = 0; i < n; i++) u8[44 + i] = fill;
        return b;
      };
      window.__wavA = new File([window.__mkWav(30, 0x80)], '测试静音A.wav', { type: 'audio/wav' });
      window.__wavB = new File([window.__mkWav(10, 0x80)], '测试静音B.wav', { type: 'audio/wav' });
      return true;
    })()`);

    // S20 音量条数字显示:滑杆 → 数字/player/audio/轨道填充全联动 + 静音 + 键盘快捷键
    await step('S20', async () => {
      // 快照 S19 留下的网络队列:S23 收尾恢复,保证其后 S11 队列断言有行可验
      // (存 localStorage 而非 window:S21 有 Page.reload,window 变量会被清空)
      await ev("(async()=>{const {player}=await import('/js/player.js'); localStorage.setItem('__queue0', JSON.stringify({ items: player.getQueue().map((s) => ({ ...s })), index: player.index })); return true;})()");
      await ev("(()=>{if(document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true;})()");
      check('S20 音量:初始数字 80%', await poll("document.getElementById('volume-num').textContent === '80%'", 5000),
        await ev("document.getElementById('volume-num').textContent"));
      await ev("(()=>{const s=document.getElementById('volume'); s.value='35'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      const vol35 = await poll("document.getElementById('volume-num').textContent === '35%' && document.getElementById('volume').style.getPropertyValue('--fill') === '35%'", 5000);
      check('S20 音量:滑杆 35 联动数字+轨道填充', vol35);
      const vols = await ev("(async()=>{const {player}=await import('/js/player.js'); return {p: player.volume, a: player.audio.volume};})()");
      check('S20 音量:player/audio 均为 0.35', !!vols && Math.abs(vols.p - 0.35) < 1e-6 && Math.abs(vols.a - 0.35) < 1e-6, JSON.stringify(vols));
      await ev("document.getElementById('btn-mute').click()");
      const muted = await poll("document.getElementById('volume-num').textContent === '0%' && document.getElementById('btn-mute').textContent === '🔇'", 5000);
      check('S20 音量:静音 → 0% + 🔇', muted);
      await ev("document.getElementById('btn-mute').click()");
      check('S20 音量:解除静音恢复 35%', await poll("document.getElementById('volume-num').textContent === '35%'", 5000));
      // 快捷键 ArrowUp/Down 走 setVolume → volumechange → 数字联动(零改动)
      const pressArrow = async (k, vk) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk });
      for (let i = 0; i < 3; i++) { await pressArrow('ArrowUp', 38); await sleep(200); }
      check('S20 音量:ArrowUp×3 → 50%', await poll("document.getElementById('volume-num').textContent === '50%'", 5000),
        await ev("document.getElementById('volume-num').textContent"));
      for (let i = 0; i < 2; i++) { await pressArrow('ArrowDown', 40); await sleep(200); }
      check('S20 音量:ArrowDown×2 → 40%', await poll("document.getElementById('volume-num').textContent === '40%'", 5000));
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.setVolume(0.8); return true;})()");
      check('S20 音量:恢复 80%', await poll("document.getElementById('volume-num').textContent === '80%'", 5000));
    });

    // S21 本地音频播放:合成 WAV 导入 → blob: 播放 → 时长补全 → 进度 → 刷新后 IDB 回放
    await step('S21', async () => {
      await mkWavFixtures();
      await ev("window.__APP_LOCAL_API.reset()");
      const imp = await ev("(async()=>{const {importFiles}=await import('/js/local-music.js'); const r=await importFiles([window.__wavA]); window.__s21=r.songs[0]; const s=r.songs[0]; return {id: s?.localId, name: s?.name, format: s?.format, hash: s?.hash, skipped: r.skipped.length};})()");
      check('S21 本地:导入元数据(localId/名称/格式/空 hash)', !!imp && typeof imp.id === 'string' && imp.name === '测试静音A' && imp.format === 'wav' && imp.hash === '' && imp.skipped === 0, JSON.stringify(imp));
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.setQueue([window.__s21], 0); return true;})()");
      const playing = await poll("document.getElementById('audio').src.startsWith('blob:') && !document.getElementById('audio').paused && document.getElementById('np-name').textContent === '测试静音A'", 15000);
      check('S21 本地:blob: 播放 + 播放条名称', playing);
      const dur = await poll("document.getElementById('time-dur').textContent === '00:30'", 15000);
      check('S21 本地:loadedmetadata 补时长 00:30', dur, await ev("document.getElementById('time-dur').textContent"));
      const t1 = await ev("(async()=>{const {player}=await import('/js/player.js'); return player.getPosition();})()");
      await sleep(1600);
      const t2 = await ev("(async()=>{const {player}=await import('/js/player.js'); return player.getPosition();})()");
      check('S21 本地:进度前进', typeof t1 === 'number' && typeof t2 === 'number' && t2 > t1, `${t1} → ${t2}`);
      // 刷新后队列恢复(不自动播放)→ 点播放 → IDB 懒取 blob 回放成立
      await cdp.send('Page.reload');
      await sleep(2500);
      const restored = await poll("document.getElementById('np-name').textContent === '测试静音A' && document.getElementById('btn-play').textContent === '▶'", 10000);
      check('S21 本地:刷新后队列恢复', restored, await ev("document.getElementById('np-name').textContent + ' / ' + document.getElementById('btn-play').textContent"));
      await ev("document.getElementById('btn-play').click()");
      const replay = await poll("document.getElementById('audio').src.startsWith('blob:') && !document.getElementById('audio').paused", 15000);
      check('S21 本地:恢复后 IDB 回放', replay);
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.clear(); return true;})()");
      await sleep(600);
      await ev("window.__APP_LOCAL_API.reset()");
    });

    // S21b ID3 解析:合成 ID3v2.3(中文+APIC)/ v1 尾部兜底 / 非 mp3 文件名回退 / IDB 封面往返
    await step('S21b', async () => {
      await ev(`(()=>{
        window.__utf16bom = (s) => { const b = [0xff, 0xfe]; for (const ch of s) { const c = ch.charCodeAt(0); b.push(c & 0xff, c >> 8); } return b; };
        window.__frame = (id, data) => new Uint8Array([...[...id].map((c) => c.charCodeAt(0)),
          (data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff, 0, 0, ...data]);
        window.__mkID3v23 = () => {
          const tit2 = window.__frame('TIT2', [1, ...window.__utf16bom('合成测试歌')]);
          const tpe1 = window.__frame('TPE1', [1, ...window.__utf16bom('合成歌手')]);
          const apic = window.__frame('APIC', [0, ...[...'image/jpeg'].map((c) => c.charCodeAt(0)), 0, 3, 0, 0xff, 0xd8]);
          const body = new Uint8Array([...tit2, ...tpe1, ...apic]);
          const head = [0x49, 0x44, 0x33, 3, 0, 0, (body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f];
          return new Uint8Array([...head, ...body]);
        };
        window.__mkID3v1 = () => { const b = new Uint8Array(128); const ws = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); }; ws(0, 'TAG'); ws(3, 'V1Title'); ws(33, 'V1Artist'); return b; };
        return true;
      })()`);
      const v2 = await ev("(async()=>{const {readAudioMeta}=await import('/js/id3.js'); const f=new File([window.__mkID3v23()], 'x.mp3', {type:'audio/mpeg'}); const m=await readAudioMeta(f); return {name:m.name, artists:m.artists, cover:m.coverBlob?.size ?? null, format:m.format};})()");
      check('S21b ID3v2.3:中文标签+APIC 封面', !!v2 && v2.name === '合成测试歌' && v2.artists === '合成歌手' && v2.cover === 2 && v2.format === 'mp3', JSON.stringify(v2));
      const v1 = await ev("(async()=>{const {readAudioMeta}=await import('/js/id3.js'); const f=new File([window.__mkID3v1()], 'old.mp3', {type:'audio/mpeg'}); const m=await readAudioMeta(f); return {name:m.name, artists:m.artists};})()");
      check('S21b ID3v1:尾部兜底', !!v1 && v1.name === 'V1Title' && v1.artists === 'V1Artist', JSON.stringify(v1));
      const fb = await ev("(async()=>{const {readAudioMeta}=await import('/js/id3.js'); const f=new File([new Uint8Array([0,0,0,0])], '01 - 无标签.m4a', {type:'audio/mp4'}); const m=await readAudioMeta(f); return {name:m.name, artists:m.artists, cover:m.coverBlob, format:m.format};})()");
      check('S21b 非mp3:文件名回退(去序号前缀)', !!fb && fb.name === '无标签' && fb.artists === '未知歌手' && fb.cover === null && fb.format === 'm4a', JSON.stringify(fb));
      // IDB 封面往返:导入 → getCoverUrl → 字节一致 → reset 归零(合成 mp3 只解析不播放,防解码噪音)
      await ev("window.__APP_LOCAL_API.reset()");
      const cv = await ev("(async()=>{const {importFiles}=await import('/js/local-music.js'); const r=await importFiles([new File([window.__mkID3v23()], 'x.mp3', {type:'audio/mpeg'})]); if(!r.songs.length) return null; const url=await window.__APP_LOCAL_API.getCoverUrl(r.songs[0].localId); if(!url) return null; const bl=await fetch(url); const b=await bl.blob(); return {size:b.size, skipped:r.skipped.length};})()");
      check('S21b 封面:IDB 往返 blob 一致', !!cv && cv.size === 2 && cv.skipped === 0, JSON.stringify(cv));
      await ev("window.__APP_LOCAL_API.reset()");
      const cnt = await ev("window.__APP_LOCAL_API.idbCount()");
      check('S21b 封面:reset 后 IDB 归零', cnt === 0, `${cnt}`);
    });

    // S22 本地歌单:建单(即播+写卡)→ 我的歌单卡 → 曲目页点播 → 移除卡 GC 全清
    await step('S22', async () => {
      // 清场:剔除残留 local: 卡(历史脏数据),保留网络歌单
      await ev("(()=>{try{const k='vmp.myplaylists.v1'; const a=JSON.parse(localStorage.getItem(k)||'[]'); localStorage.setItem(k, JSON.stringify(a.filter((p)=>!(String(p.specialid||'').startsWith('local:')))));}catch{} return true;})()");
      await ev("window.__APP_LOCAL_API.reset()");
      await mkWavFixtures();
      const made = await ev("(async()=>{const {createLocalPlaylistFromFiles}=await import('/js/ui.js'); await createLocalPlaylistFromFiles([window.__wavA, window.__wavB]); return true;})()");
      check('S22 本地歌单:创建管线执行', made === true);
      const pl1 = await poll("JSON.parse(localStorage.getItem('vmp.myplaylists.v1')||'[]').some((p)=>String(p.specialid||'').startsWith('local:') && p.local === true && p.count === 2)", 10000);
      check('S22 本地歌单:写入 local: 卡(count=2)', pl1);
      const plName = await ev("JSON.parse(localStorage.getItem('vmp.myplaylists.v1')||'[]').find((p)=>String(p.specialid||'').startsWith('local:'))?.specialname || ''");
      check('S22 本地歌单:默认名「测试静音A 等2首」', plName === '测试静音A 等2首', plName);
      check('S22 本地歌单:创建即播 A', await poll("document.getElementById('np-name').textContent === '测试静音A' && !document.getElementById('audio').paused", 15000));
      // 我的歌单页:卡渲染(名称/副标题/占位封面)
      await openDrawer();
      await ev("document.querySelector('.nav-item[data-view=my]').click()");
      const cardOk = await poll("document.querySelector('#main .card .card-name')?.textContent === '测试静音A 等2首'", 5000);
      check('S22 本地歌单:卡渲染', cardOk, await ev("document.querySelector('#main .card .card-name')?.textContent || ''"));
      const sub = await ev("document.querySelector('#main .card .card-sub')?.textContent || ''");
      check('S22 本地歌单:副标题「本地 · 2 首」', sub.includes('本地') && sub.includes('2 首'), sub);
      const cov = await ev("document.querySelector('#main .card img')?.src || ''");
      check('S22 本地歌单:占位封面(无内嵌图)', cov.startsWith('data:'), cov.slice(0, 40));
      // 点卡 → 曲目页 2 行(data-hash 为 lm- 本地 ID)→ 点第 2 行播 B → 行高亮(songKey)
      await ev("document.querySelector('#main .card').click()");
      const rowsOk = await poll("document.querySelectorAll('.song-row').length === 2", 5000);
      check('S22 本地歌单:曲目页 2 行', rowsOk);
      const hashes = await ev("[...document.querySelectorAll('.song-row')].map((r)=>r.dataset.hash)");
      check('S22 本地歌单:行 data-hash 为本地 ID', Array.isArray(hashes) && hashes.length === 2 && hashes.every((h) => typeof h === 'string' && h.startsWith('lm-')), JSON.stringify(hashes));
      await ev("document.querySelectorAll('.song-row')[1].click()");
      check('S22 本地歌单:点第 2 行播 B', await poll("document.getElementById('np-name').textContent === '测试静音B' && !document.getElementById('audio').paused", 15000));
      const hl = await poll(`document.querySelector('.song-row.playing')?.dataset.hash === '${hashes && hashes[1] || ''}'`, 5000);
      check('S22 本地歌单:播放行高亮(songKey)', hl);
      await ev("document.querySelector('.back-btn').click()");
      await poll("document.querySelectorAll('#main .card').length > 0", 5000);
      // 清队列后移除卡 → GC 孤儿(受保护集为空 → 两首歌+封面全删)
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.clear(); return true;})()");
      await sleep(600);
      await ev("document.querySelector('.card-remove').click()");
      const gcOk = await poll("(async()=>{const c=await window.__APP_LOCAL_API.idbCount(); return c===0 && window.__APP_LOCAL.songs.length===0;})()", 10000);
      check('S22 本地歌单:移除卡后 GC 全清(IDB 0 + 索引空)', gcOk);
      const savedOk = await poll("!(JSON.parse(localStorage.getItem('vmp.myplaylists.v1')||'[]').some((p)=>String(p.specialid||'').startsWith('local:')))", 5000);
      check('S22 本地歌单:local: 卡已从持久化移除', savedOk);
      await ev("window.__APP_LOCAL_API.reset()");
    });

    // S23 桌词三修复:墙钟同步(中途打开不卡句/外推走动)/ 字号连点 / 面板推送 / 滑杆拖动守卫 / 尺寸钳制
    await step('S23', async () => {
      await ev("window.__fx0 = JSON.parse(JSON.stringify(window.__APP_FX))");
      await ev("window.__APP_LOCAL_API.reset()");
      await mkWavFixtures();
      // 本地 WAV + 注入确定歌词(0.5/3/6s 三句);先 setQueue 后注入(setQueue 的 songchange 会 loadFor(null) 清空 lines)
      const prep = await ev(`(async()=>{
        const {importFiles}=await import('/js/local-music.js');
        const r=await importFiles([window.__wavA]); window.__s23=r.songs[0];
        const {player}=await import('/js/player.js');
        player.setQueue([window.__s23], 0);
        const {lyricsView}=await import('/js/ui.js');
        lyricsView.lines=[{time:0.5,text:'第一句'},{time:3,text:'第二句'},{time:6,text:'第三句'}];
        const {setFx}=await import('/js/fx.js');
        setFx('dlFontSize', 40); setFx('dlOpacity', 0.92);
        return true;
      })()`);
      check('S23 桌词:本地歌+歌词注入', prep === true);
      await poll("document.getElementById('audio').src.startsWith('blob:') && !document.getElementById('audio').paused", 15000);
      // 时长就绪后 seek 到 3s(第二句区间 [3,6),开窗延迟 1-2s 也不会越过 6s 边界)→ 开小窗
      check('S23 桌词:时长就绪(30s)', await poll("(async()=>{const {player}=await import('/js/player.js'); return player.getDuration() === 30;})()", 10000));
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.seek(3); return true;})()");
      await sleep(400);
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      const opened = await poll("window.__APP_DESKTOP_LYRICS === '1'", 3000);
      check('S23 桌词:主窗标记打开', opened);
      if (!opened) return;
      const t2 = await attachTarget('desktop-lyrics.html');
      check('S23 桌词:小窗目标存在', !!t2);
      if (!t2) return;
      const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = () => rej(new Error('ws2 connect failed')); });
      const cdp2 = new CDP(ws2);
      await cdp2.send('Runtime.enable');
      await cdp2.send('Log.enable');
      const ev2 = async (expr) => {
        const r = await cdp2.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error('小窗异常: ' + ((d.exception?.description || d.text || 'unknown').slice(0, 200)) + ' @ ' + expr.slice(0, 80));
        }
        return r.result?.value;
      };
      const poll2 = async (expr, timeout = 20000, interval = 500) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          try { if (await ev2(expr)) return true; } catch { return false; }
          await sleep(interval);
        }
        return false;
      };
      const waitGone = async () => {
        for (let i = 0; i < 10; i++) {
          await sleep(400);
          const list = await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/list`);
          const arr = Array.isArray(list) ? list : [];
          if (!arr.some((t) => (t.url || '').includes('desktop-lyrics.html'))) return true;
        }
        return false;
      };
      check('S23 桌词:小窗就绪(快照含 3 行)', await poll2("window.__APP_DESKTOP_LYRICS === '1' && window.__APP_DL_STATE?.lineCount === 3", 8000));
      check('S23 桌词:artist 字段修复(artists)', await poll2("window.__APP_DL_STATE?.artist === '未知歌手'", 5000),
        await ev2("JSON.stringify(window.__APP_DL_STATE)"));
      // 墙钟同步:3.5s 开窗 → 立即第二句(旧 bug 卡第一句/暂无歌词)
      check('S23 桌词:中途打开落在第二句', await poll2("document.getElementById('dl-current').textContent === '第二句'", 8000),
        await ev2("document.getElementById('dl-current').textContent"));
      // 外推走动:t=6s 跨行 → 第三句(旧 bug 歌词不动)
      check('S23 桌词:跨行外推 → 第三句', await poll2("document.getElementById('dl-current').textContent === '第三句'", 8000),
        await ev2("document.getElementById('dl-current').textContent"));
      // 字号连点:font-down×3 本地立即生效(旧 bug 过期快照基准连点失效)
      await ev2("(()=>{const b=document.getElementById('dl-font-down'); b.click(); b.click(); b.click(); return true;})()");
      check('S23 桌词:连点 font-down×3 → 34px', await poll2("getComputedStyle(document.getElementById('dl-current')).fontSize === '34px'", 5000),
        await ev2("getComputedStyle(document.getElementById('dl-current')).fontSize"));
      check('S23 桌词:回写主窗 fx 收敛 34', await poll("window.__APP_FX.dlFontSize === 34", 5000), `${await ev('window.__APP_FX.dlFontSize')}`);
      // 面板改值 → subscribe 推小窗 48px
      await ev("(async()=>{const {setFx}=await import('/js/fx.js'); setFx('dlFontSize', 48); return true;})()");
      check('S23 桌词:面板 48 推小窗生效', await poll2("getComputedStyle(document.getElementById('dl-current')).fontSize === '48px'", 5000),
        await ev2("getComputedStyle(document.getElementById('dl-current')).fontSize"));
      // 透明度滑杆:本地即时 + 回写收敛 + 拖动守卫(快照流不顶回拖动中的滑杆)
      await ev2("(()=>{const s=document.getElementById('dl-opacity'); s.value='0.5'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      // 读内联 CSS 变量:computed opacity 会被 reenter 动画插值(改 --dl-opacity 触发 Chrome 重启动画)
      check('S23 桌词:透明度本地即时生效', await ev2("document.documentElement.style.getPropertyValue('--dl-opacity') === '0.5'"),
        await ev2("document.documentElement.style.getPropertyValue('--dl-opacity')"));
      check('S23 桌词:透明度回写主窗 fx', await poll("window.__APP_FX.dlOpacity === 0.5", 5000));
      await sleep(1500);
      check('S23 桌词:透明度未被快照顶回', await ev2("getComputedStyle(document.getElementById('dl-current')).opacity === '0.5' && document.getElementById('dl-opacity').value === '0.5'"),
        await ev2("document.getElementById('dl-opacity').value"));
      await ev2("(()=>{const s=document.getElementById('dl-opacity'); s.dispatchEvent(new Event('pointerdown')); s.value='0.9'; return true;})()");
      await sleep(1500);
      check('S23 桌词:拖动中快照不顶回滑杆', await ev2("document.getElementById('dl-opacity').value === '0.9'"),
        await ev2("document.getElementById('dl-opacity').value"));
      await ev2("(()=>{const s=document.getElementById('dl-opacity'); s.dispatchEvent(new Event('pointerup')); s.value='0.5'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      await sleep(600);
      // 中途打开回归:关窗 → seek(1.5) → 播至 3.6s+ → 重开 → 第二句(旧 bug 卡第一句)
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      await poll("window.__APP_DESKTOP_LYRICS === '0'", 3000);
      await waitGone();
      ws2.close();
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.seek(1.5); return true;})()");
      check('S23 桌词:重开前播放推进', await poll("(async()=>{const {player}=await import('/js/player.js'); return player.getPosition() >= 3.6;})()", 8000));
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      const opened3 = await poll("window.__APP_DESKTOP_LYRICS === '1'", 3000);
      check('S23 桌词:播放中途重开', opened3);
      if (opened3) {
        const t3 = await attachTarget('desktop-lyrics.html');
        if (t3) {
          const ws3 = new WebSocket(t3.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws3.onopen = res; ws3.onerror = () => rej(new Error('ws3 connect failed')); });
          const cdp3 = new CDP(ws3);
          await cdp3.send('Runtime.enable');
          await cdp3.send('Log.enable');
          const ev3 = async (expr) => {
            const r = await cdp3.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error('小窗异常: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown').slice(0, 200)) + ' @ ' + expr.slice(0, 80));
            return r.result?.value;
          };
          const poll3 = async (expr, timeout = 20000, interval = 500) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeout) {
              try { if (await ev3(expr)) return true; } catch { return false; }
              await sleep(interval);
            }
            return false;
          };
          check('S23 桌词:重开即当前句(墙钟)', await poll3("document.getElementById('dl-current').textContent === '第二句'", 8000),
            await ev3("document.getElementById('dl-current').textContent"));
          // 尺寸钳制:拦截 window.open 的 features 参数(无头下 popup 实际尺寸恒 800x600,
          // 不可直接断言 outerWidth)→ 注入 99999 脏尺寸重开 → 请求尺寸被钳制 ≤ avail×0.8;
          // 心跳落盘(小窗上报真实 outerWidth → 主窗 saveWinCfg 再钳制)同为钳制值
          await ev("document.getElementById('desktop-lyrics-btn').click()");
          await poll("window.__APP_DESKTOP_LYRICS === '0'", 3000);
          await waitGone();
          ws3.close();
          await ev("(()=>{window.__openFeatures=null; const o=window.open; window.open=function(u,n,f){window.__openFeatures=f; return o.call(window,u,n,f);}; return true;})()");
          await ev("localStorage.setItem('vmp.desktopLyrics.v1', JSON.stringify({...JSON.parse(localStorage.getItem('vmp.desktopLyrics.v1')||'{}'), w:99999, h:99999}))");
          await ev("document.getElementById('desktop-lyrics-btn').click()");
          const opened4 = await poll("window.__APP_DESKTOP_LYRICS === '1'", 3000);
          check('S23 桌词:脏尺寸重开', opened4);
          const req = await ev("(()=>{const f=window.__openFeatures||''; const mw=/width=(\\d+)/.exec(f); const mh=/height=(\\d+)/.exec(f); const w=mw?Number(mw[1]):0; const h=mh?Number(mh[1]):0; return {f, w, h, ok: w>0 && h>0 && w<=Math.floor(window.screen.availWidth*0.8)+1 && h<=Math.floor(window.screen.availHeight*0.8)+1};})()");
          check('S23 桌词:重开请求尺寸被钳制(≤avail×0.8)', req.ok, `${req.f} → ${req.w}x${req.h} (avail ${await ev('window.screen.availWidth')}x${await ev('window.screen.availHeight')})`);
          if (opened4) {
            const t4 = await attachTarget('desktop-lyrics.html');
            if (t4) {
              const ws4 = new WebSocket(t4.webSocketDebuggerUrl);
              await new Promise((res, rej) => { ws4.onopen = res; ws4.onerror = () => rej(new Error('ws4 connect failed')); });
              const cdp4 = new CDP(ws4);
              await cdp4.send('Runtime.enable');
              await cdp4.send('Log.enable');
              check('S23 桌词:心跳保存钳制尺寸', await poll("(JSON.parse(localStorage.getItem('vmp.desktopLyrics.v1')||'{}').w||0) <= Math.floor(screen.availWidth*0.8) && (JSON.parse(localStorage.getItem('vmp.desktopLyrics.v1')||'{}').h||0) <= Math.floor(screen.availHeight*0.8)", 8000));
              ws4.close();
            }
          }
        }
      }
      // 收尾:关窗 → 恢复 fx → 清队列/本地库 → 恢复 S19 网络队列(供其后 S11 队列断言)
      await ev("window.__APP_DESKTOP_LYRICS === '1' && document.getElementById('desktop-lyrics-btn').click(), true");
      await poll("window.__APP_DESKTOP_LYRICS === '0'", 3000);
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.clear(); return true;})()");
      await sleep(600);
      await ev("window.__APP_LOCAL_API.reset()");
      await ev("(async()=>{const {player}=await import('/js/player.js'); const q0=JSON.parse(localStorage.getItem('__queue0')||'null'); if (q0 && q0.items.length) player.setQueue(q0.items, q0.index); localStorage.removeItem('__queue0'); return true;})()");
      await ev("(async()=>{const {setFx}=await import('/js/fx.js'); const s=window.__fx0; setFx('dlFontSize', s.dlFontSize); setFx('dlOpacity', s.dlOpacity); return true;})()");
    });

    // S10 登录界面:入口 = 抽屉用户大标题(主页 login-btn 已移除)→ 弹窗打开 → 二维码渲染 → 轮询发出 → 关闭
    await step('S10', async () => {
      check('S10 登录:主页登录按钮已移除', await ev("!document.getElementById('login-btn')") === true);
      await ev("document.getElementById('drawer-user').click()");
      const modalOpen = await poll("document.getElementById('login-modal').classList.contains('open')", 5000);
      check('S10 登录:弹窗打开', modalOpen);
      if (!modalOpen) return;
      const imgOk = await poll("document.getElementById('qr-img').src.startsWith('data:image/png')", 10000);
      check('S10 登录:二维码图片渲染(API 返回 PNG)', imgOk);
      const statusOk = await poll("document.getElementById('qr-status').textContent.includes('扫码')", 10000);
      check('S10 登录:轮询状态提示', statusOk, await ev("document.getElementById('qr-status').textContent"));
      await sleep(2600); // 轮询周期 2s,等首个 /login/qr/check 发出
      const polls = await ev(
        "performance.getEntriesByType('resource').filter((e) => e.name.includes('/login/qr/check')).length"
      );
      check('S10 登录:扫码状态轮询已发出', polls >= 1, `${polls} 次`);
      await ev("document.getElementById('login-close').click()");
      check('S10 登录:关闭弹窗', await poll("!document.getElementById('login-modal').classList.contains('open')", 3000));
      // 抽屉用户大标题:未登录文案
      check('S10 用户大标题:未登录文案', await ev("document.getElementById('drawer-user-title').textContent") === '未登录');
    });

    // S11 音乐壁纸布局:抽屉开关四条路径 + 队列标签页切歌高亮 + 3D 渲染模式
    await step('S11', async () => {
      await openDrawer();
      check('S11 抽屉:边缘按钮可打开', await ev("document.getElementById('right-drawer').classList.contains('open')") === true);

      // 队列标签页:显示队列行 + 当前曲高亮
      await ev("document.querySelector('.drawer-tab-btn[data-tab=queue]').click()");
      const qShown = await poll("!document.getElementById('queue-pane').hidden && document.querySelectorAll('#queue-view .song-row').length > 0", 5000);
      check('S11 队列:标签页显示队列行', qShown, `${await ev("document.querySelectorAll('#queue-view .song-row').length")} 行`);
      check('S11 队列:当前曲高亮 .playing', await ev("!!document.querySelector('#queue-view .song-row.playing')") === true);

      // 点击队列中可播行切歌 → 播放条同步 + 高亮跟随
      const pick = await ev(playableIdxExpr('#queue-view .song-row', 50));
      if (pick >= 0) {
        const targetName = await ev(`document.querySelectorAll('#queue-view .song-row')[${pick}].querySelector('.row-name').textContent`);
        await ev(`document.querySelectorAll('#queue-view .song-row')[${pick}].click()`);
        check(
          'S11 队列:点击行切歌(播放条同步)',
          await poll(`document.getElementById('np-name').textContent === ${JSON.stringify(targetName)} && !document.getElementById('audio').paused`, 25000),
          `第 ${pick + 1} 行「${targetName}」`
        );
        check(
          'S11 队列:高亮跟随新行',
          await poll(`document.querySelectorAll('#queue-view .song-row')[${pick}].classList.contains('playing')`, 5000)
        );
      } else {
        check('S11 队列:点击行切歌', false, '队列中无可播行');
      }

      // 沉浸模式:进入榜单歌曲页隐藏抽屉装饰(搜索/标签页/导航),返回后恢复
      await ev("document.querySelector('.nav-item[data-view=rank]').click()");
      await poll("document.querySelectorAll('#main .card').length > 0", 8000);
      await ev("document.querySelector('#main .card').click()");
      await poll("document.querySelectorAll('#main .song-row').length > 0", 15000);
      check('S11 沉浸:歌曲列表页进入沉浸模式', await ev("document.getElementById('right-drawer').classList.contains('immersive')") === true);
      check('S11 沉浸:搜索区已隐藏', await ev("getComputedStyle(document.querySelector('.drawer-search')).display === 'none'") === true);
      await ev("document.querySelector('#main .back-btn').click()");
      await poll("document.querySelectorAll('#main .card').length > 0", 8000);
      check('S11 沉浸:返回后恢复面板', await ev("!document.getElementById('right-drawer').classList.contains('immersive')") === true);

      // 关闭 ✕ → logo 重开 → Esc 关闭
      await ev("document.getElementById('drawer-close').click()");
      check('S11 抽屉:✕ 关闭', await poll("!document.getElementById('right-drawer').classList.contains('open')", 3000));
      await ev("document.getElementById('float-logo').click()");
      check('S11 抽屉:logo 打开', await poll("document.getElementById('right-drawer').classList.contains('open')", 3000));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      check('S11 抽屉:Esc 关闭', await poll("!document.getElementById('right-drawer').classList.contains('open')", 3000));

      // 点击播放条歌曲名 → 打开面板并切到队列标签页(歌单界面)
      await ev("document.getElementById('np-name').click()");
      check('S11 歌单界面:点击播放条歌曲名打开面板', await poll("document.getElementById('right-drawer').classList.contains('open')", 3000));
      check('S11 歌单界面:自动切到队列标签页', await ev("!document.getElementById('queue-pane').hidden") === true);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      check('S11 歌单界面:Esc 可关闭', await poll("!document.getElementById('right-drawer').classList.contains('open')", 3000));

      // 3D 渲染模式标记(无 GPU 机器允许回退 2D,只断言标记存在)
      const flag = await ev("window.__APP_STARFIELD_3D");
      check('S11 3D:渲染模式标记存在', flag === '1' || flag === '0', `mode=${flag}`);
      if (flag === '1') {
        check('S11 3D:THREE 已加载', await ev("typeof window.THREE === 'object'") === true);
      }
    });

    // S12a 视觉 DIY 控制台:参数滑块 → fx 状态 → localStorage 持久化 → 恢复默认
    await step('S12a', async () => {
      await openDrawer();
      await ev("document.querySelector('.drawer-tab-btn[data-tab=visual]').click()");
      const paneShown = await poll("!document.getElementById('visual-pane').hidden", 3000);
      check('S12a 视觉面板:标签页打开', paneShown);
      if (!paneShown) return;
      const paramCount = await ev("document.querySelectorAll('#visual-pane .fx-param').length");
      check('S12a 视觉面板:参数控件 ≥13', paramCount >= 13, `${paramCount} 个`);
      const slotCount = await ev("document.querySelectorAll('#visual-pane .fx-slot').length");
      check('S12a 视觉面板:预设槽 4 个', slotCount === 4, `${slotCount} 个`);
      // 拖滑块(设 value + 派发 input)→ fx 状态即时生效
      await ev("(()=>{const s=document.getElementById('fx-orbScale'); s.value='1.5'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      check('S12a 参数:orbScale 即时生效', await poll("window.__APP_FX.orbScale === 1.5", 3000));
      // 防抖 300ms 后落盘
      check('S12a 参数:持久化 vmp.fx.v1', await poll("JSON.parse(localStorage.getItem('vmp.fx.v1')||'{}').orbScale === 1.5", 3000));
      // 恢复默认
      await ev("document.getElementById('fx-reset').click()");
      check('S12a 参数:恢复默认', await poll("window.__APP_FX.orbScale === 1", 3000));
    });

    // S12b 预设槽:保存当前 → 改值 → 应用快照 → 刷新后仍在
    await step('S12b', async () => {
      await openDrawer();
      await ev("document.querySelector('.drawer-tab-btn[data-tab=visual]').click()");
      await poll("!document.getElementById('visual-pane').hidden", 3000);
      // 设 orbScale=1.5 保存到槽 0
      await ev("(()=>{const s=document.getElementById('fx-orbScale'); s.value='1.5'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      await poll("window.__APP_FX.orbScale === 1.5", 3000);
      await ev("document.getElementById('fx-slot-name-0').value = '测试预设'");
      await ev("document.getElementById('fx-slot-save-0').click()");
      const saved = await ev("(()=>{const d=JSON.parse(localStorage.getItem('vmp.fxpresets.v1'));return d && d.slots[0];})()");
      check('S12b 预设槽:保存快照', !!saved && saved.name === '测试预设' && saved.snapshot?.orbScale === 1.5, saved?.name || '空');
      // 改到 1.2 → 应用槽 0 → 回到 1.5
      await ev("(()=>{const s=document.getElementById('fx-orbScale'); s.value='1.2'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      await poll("Math.abs(window.__APP_FX.orbScale - 1.2) < 1e-9", 3000);
      await ev("document.getElementById('fx-slot-apply-0').click()");
      check('S12b 预设槽:应用快照生效', await poll("window.__APP_FX.orbScale === 1.5", 3000));
      // 刷新后持久化保持
      await cdp.send('Page.reload');
      await sleep(2500);
      const persisted = await ev("window.__APP_FX.orbScale");
      check('S12b 预设槽:刷新后参数保持', persisted === 1.5, `orbScale=${persisted}`);
    });

    // S12d 电影运镜:3D 可用才测(2D 回退环境直接 PASS)
    await step('S12d', async () => {
      const mode = await ev("window.__APP_STARFIELD_3D");
      if (mode !== '1') {
        check('S12d 运镜:2D 回退环境跳过', true, 'mode=0');
        return;
      }
      const hasCam = await ev("!!(window.__APP_VIZ3D && window.__APP_VIZ3D.cameraman)");
      check('S12d 运镜:cameraman 实例存在', hasCam);
      if (!hasCam) return;
      // fx → cameraman 参数管线(走滑块路径,1.2 经 step 取整后为浮点近似,用容差比较)
      await ev("(()=>{const s=document.getElementById('fx-cineShake'); s.value='1.2'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      check('S12d 运镜:fx→cameraman 参数管线', await poll("Math.abs(window.__APP_VIZ3D.cameraman.params.cineShake - 1.2) < 1e-9", 2000));
      // 合成节拍:punch 立即 >0
      await ev("window.__APP_VIZ3D.cameraman.beat(1)");
      check('S12d 运镜:beat(1) → punch>0', await poll("window.__APP_VIZ3D.cameraman.punch > 0.1", 1000));
      // 相机位置漂移(0.4s 位移 >1 单位:轨道 + 漂移,headless 下 RAF 正常运行)
      const p1 = await ev("(()=>{const p=window.__APP_VIZ3D.camera.position;return [p.x,p.y,p.z];})()");
      await sleep(400);
      const p2 = await ev("(()=>{const p=window.__APP_VIZ3D.camera.position;return [p.x,p.y,p.z];})()");
      const drift = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
      check('S12d 运镜:相机位置漂移', drift > 1, `${drift.toFixed(2)} 单位`);
      // FOV 收缩:punch 残余 + 呼吸脉冲 → 低于 fovBase(58)
      const fov = await ev("window.__APP_VIZ3D.camera.fov");
      check('S12d 运镜:FOV 收缩 < fovBase', fov < 58, `fov=${fov.toFixed(1)}`);
      // 恢复默认,避免影响后续
      await ev("document.getElementById('fx-reset').click()");
    });

    // S12e 壁纸模式:页内合成图片 File/视频 Blob 走完整管线(压缩/IndexedDB/CSS 变量/恢复/清除)
    await step('S12e', async () => {
      // 图片:canvas 合成 PNG → File → handleImageFile → WebP dataURL
      await ev("(()=>{const cv=document.createElement('canvas');cv.width=800;cv.height=600;const g=cv.getContext('2d');g.fillStyle='#1a6f8f';g.fillRect(0,0,800,600);window.__wpImgBlob=null;cv.toBlob(b=>{window.__wpImgBlob=b;},'image/png');return true;})()");
      check('S12e 壁纸:合成图片 Blob', await poll("!!window.__wpImgBlob", 3000));
      await ev("window.__APP_WALLPAPER_API.handleImageFile(new File([window.__wpImgBlob], 'wp-test.png', {type:'image/png'}))");
      check('S12e 壁纸:图片应用(标记 image)', await poll("window.__APP_WALLPAPER === 'image'", 5000));
      const imgSrc = await ev("document.getElementById('wallpaper-img').src");
      const imgHidden = await ev("document.getElementById('wallpaper-img').hidden");
      check('S12e 壁纸:WebP dataURL 生效', imgSrc.startsWith('data:image/webp') && imgHidden === false, imgSrc.slice(0, 40));
      const wpCfg1 = await ev("JSON.parse(localStorage.getItem('vmp.wallpaper.v1'))");
      check('S12e 壁纸:配置持久化', wpCfg1?.enabled === true && wpCfg1?.type === 'image' && wpCfg1?.src?.startsWith('data:'), 'vmp.wallpaper.v1');
      // fx 滑块 → CSS 变量
      await ev("(()=>{const s=document.getElementById('fx-bgOpacity'); s.value='0.5'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;})()");
      check('S12e 壁纸:bgOpacity→CSS 变量', await poll("getComputedStyle(document.getElementById('wallpaper-img')).opacity === '0.5'", 3000));
      // 视频:MediaRecorder 合成 1 帧 webm → applyVideoBlob → IndexedDB
      await ev("window.__wpChunks=[]; (()=>{const cv=document.createElement('canvas');cv.width=64;cv.height=64;cv.getContext('2d').fillRect(0,0,64,64);const st=cv.captureStream(5);window.__wpRec=new MediaRecorder(st);window.__wpRec.ondataavailable=(e)=>{if(e.data.size)window.__wpChunks.push(e.data);};window.__wpRec.start();return true;})()");
      await sleep(400);
      await ev("window.__wpRec.stop()");
      check('S12e 壁纸:合成视频 Blob', await poll("window.__wpChunks.length > 0", 5000));
      await ev("window.__APP_WALLPAPER_API.applyVideoBlob(new Blob(window.__wpChunks, {type:'video/webm'}))");
      check('S12e 壁纸:视频应用(标记 video)', await poll("window.__APP_WALLPAPER === 'video'", 5000));
      const vidSrc = await ev("document.getElementById('wallpaper-video').src");
      const idbN = await ev("window.__APP_WALLPAPER_API.idbCount()");
      const wpCfg2 = await ev("JSON.parse(localStorage.getItem('vmp.wallpaper.v1'))");
      check('S12e 壁纸:视频 blob: 回放 + IndexedDB 1 条', vidSrc.startsWith('blob:') && idbN === 1 && wpCfg2?.type === 'video', `idb=${idbN}`);
      // 刷新恢复(视频在 IndexedDB,不占 localStorage)
      await cdp.send('Page.reload');
      await sleep(2500);
      const restored = await poll("window.__APP_WALLPAPER === 'video'", 6000);
      const vidSrc2 = await ev("document.getElementById('wallpaper-video').src");
      check('S12e 壁纸:刷新后视频壁纸恢复', restored && vidSrc2.startsWith('blob:'), restored ? '已恢复' : '未恢复');
      // 清除归零
      await ev("window.__APP_WALLPAPER_API.clearWallpaper()");
      check('S12e 壁纸:清除归零', await poll("window.__APP_WALLPAPER === 'none'", 3000));
      const idbN2 = await ev("window.__APP_WALLPAPER_API.idbCount()");
      const wpCfg3 = await ev("JSON.parse(localStorage.getItem('vmp.wallpaper.v1'))");
      check('S12e 壁纸:清除后 IDB/配置归零', idbN2 === 0 && wpCfg3?.enabled === false, `idb=${idbN2}`);
      // 恢复默认 fx(透明度回 0.85),避免影响后续
      await ev("document.getElementById('fx-reset').click()");
    });

    // S12c 桌面歌词:独立小窗生命周期(打开/标记/推送/快照同步/seek/抽屉不联动/关闭)
    await step('S12c', async () => {
      // 前提:歌词抽屉保持关闭(桌词不依赖抽屉)
      await ev("(()=>{const d=document.getElementById('lyric-drawer'); if(d.classList.contains('open')) document.getElementById('lyric-close').click(); return true;})()");
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      const opened = await poll("window.__APP_DESKTOP_LYRICS === '1'", 3000);
      check('S12c 桌词:主窗标记打开', opened);
      if (!opened) return;
      const t2 = await attachTarget('desktop-lyrics.html');
      check('S12c 桌词:小窗目标存在', !!t2);
      if (!t2) return;
      const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = () => rej(new Error('ws2 connect failed')); });
      const cdp2 = new CDP(ws2);
      await cdp2.send('Runtime.enable');
      await cdp2.send('Log.enable');
      const ev2 = async (expr) => {
        const r = await cdp2.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error('小窗异常: ' + ((d.exception?.description || d.text || 'unknown').slice(0, 200)) + ' @ ' + expr.slice(0, 80));
        }
        return r.result?.value;
      };
      const poll2 = async (expr, timeout = 20000, interval = 500) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          try { if (await ev2(expr)) return true; } catch { return false; }
          await sleep(interval);
        }
        return false;
      };
      check('S12c 桌词:小窗就绪(标记=1)', await poll2("window.__APP_DESKTOP_LYRICS === '1'", 5000));
      const dlTitle = await ev2("document.title");
      check('S12c 桌词:小窗标题', dlTitle.includes('桌面歌词'), dlTitle);
      // 播放中:timeupdate 节流推送 + 心跳 2s 回推,快照源源不断
      await ev("(async()=>{const {player}=await import('/js/player.js'); if(player.state!=='playing') player.toggle(); return true;})()");
      await poll("(async()=>{const {player}=await import('/js/player.js'); return player.state==='playing';})()", 15000);
      check('S12c 桌词:接收推送 ≥5', await poll2("window.__APP_LYRIC_RX_COUNT >= 5", 8000));
      // 快照标题与主窗播放条一致
      const np = await ev("document.getElementById('np-name').textContent");
      const dlState = await ev2("window.__APP_DL_STATE");
      check('S12c 桌词:快照标题同步', !!dlState && dlState.title === np, `小窗「${dlState?.title}」`);
      // seek(10) → 推送继续增加(外推随 receivedAt 更新)
      const rx0 = await ev2("window.__APP_LYRIC_RX_COUNT");
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.seek(10); return true;})()");
      check('S12c 桌词:seek 后推送继续', await poll2(`window.__APP_LYRIC_RX_COUNT > ${rx0}`, 5000), `${rx0}→`);
      // 全程歌词抽屉保持关闭(闸门零改动)
      check('S12c 桌词:歌词抽屉未被动', await ev("!document.getElementById('lyric-drawer').classList.contains('open')"));
      // S12f 小窗审计:无异常/控制台错误
      check('S12f 小窗审计:无异常/控制台错误', (cdp2.exceptions || []).length === 0 && (cdp2.consoleErrors || []).length === 0,
        `异常 ${(cdp2.exceptions || []).length} · 控制台 ${(cdp2.consoleErrors || []).length}`);
      // 再点按钮 → bye 关闭,/json/list 无目标(测试侧查询,勿在页面内 fetch CDP 端口防 CORS 污染)
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      check('S12c 桌词:主窗标记关闭', await poll("window.__APP_DESKTOP_LYRICS === '0'", 3000));
      let gone = false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        const list = await httpReq('GET', `http://127.0.0.1:${DEBUG_PORT}/json/list`);
        const arr = Array.isArray(list) ? list : [];
        if (!arr.some((t) => (t.url || '').includes('desktop-lyrics.html'))) { gone = true; break; }
      }
      check('S12c 桌词:小窗已关闭(/json/list 无目标)', gone);
      ws2.close();
    });

    // S12f 小窗重开审计:第二次打开走全新 CDP 会话,再审计一次(覆盖重开路径)
    await step('S12f', async () => {
      // 先确保小窗处于关闭态(与 S12c 结果解耦:残留开启时先点关)
      await ev("window.__APP_DESKTOP_LYRICS === '1' && document.getElementById('desktop-lyrics-btn').click(), true");
      await poll("window.__APP_DESKTOP_LYRICS === '0'", 3000);
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      const opened = await poll("window.__APP_DESKTOP_LYRICS === '1'", 3000);
      check('S12f 桌词:小窗重开', opened);
      if (!opened) return;
      const t3 = await attachTarget('desktop-lyrics.html');
      if (!t3) { check('S12f 桌词:重开目标存在', false); return; }
      check('S12f 桌词:重开目标存在', true);
      const ws3 = new WebSocket(t3.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws3.onopen = res; ws3.onerror = () => rej(new Error('ws3 connect failed')); });
      const cdp3 = new CDP(ws3);
      await cdp3.send('Runtime.enable');
      await cdp3.send('Log.enable');
      const ev3 = async (expr) => {
        const r = await cdp3.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('小窗异常: ' + ((r.exceptionDetails.exception?.description || 'unknown').slice(0, 200)));
        return r.result?.value;
      };
      const poll3 = async (expr, timeout = 20000, interval = 500) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          try { if (await ev3(expr)) return true; } catch { return false; }
          await sleep(interval);
        }
        return false;
      };
      check('S12f 桌词:重开后接收推送 ≥2', await poll3("window.__APP_LYRIC_RX_COUNT >= 2", 8000));
      await sleep(1500);
      check('S12f 小窗审计:无异常/控制台错误', (cdp3.exceptions || []).length === 0 && (cdp3.consoleErrors || []).length === 0,
        `异常 ${(cdp3.exceptions || []).length} · 控制台 ${(cdp3.consoleErrors || []).length}${(cdp3.consoleErrors || []).length ? ' · ' + cdp3.consoleErrors[0].slice(0, 80) : ''}`);
      await ev("document.getElementById('desktop-lyrics-btn').click()");
      check('S12f 桌词:重开后关闭', await poll("window.__APP_DESKTOP_LYRICS === '0'", 3000));
      ws3.close();
    });

    // S14 视频壁纸大文件:默认上限 1000MB、>18MB 通过上限判定、钩子调小超限拒绝、配额预检拒绝
    // (保存钩子 setSaveHook 拦截落库,只验证判定逻辑;真实管线 S12e 已覆盖,大文件落库交给用户实测)
    await step('S14', async () => {
      const defCap = await ev("window.__APP_WALLPAPER_MAX_VIDEO");
      check('S14 上限:默认 1000MB', defCap === 1000 * 1024 * 1024, `cap=${defCap}`);

      // >18MB(旧上限)的 20MB 文件通过判定:挂保存钩子拦截落库
      await ev("window.__wpOk = 0; window.__APP_WALLPAPER_API.setSaveHook((n) => { window.__wpOk = n; }), true");
      await ev("window.__APP_WALLPAPER_API.handleVideoFile(new File([new Uint8Array(20 * 1024 * 1024)], 'big.mp4', {type:'video/mp4'})), true");
      check('S14 接受:20MB 通过上限判定', await poll("window.__wpOk === 20 * 1024 * 1024", 8000));

      // 钩子调小上限 → 3MB 拒绝(不进保存钩子,壁纸状态不变)
      await ev("window.__APP_WALLPAPER_MAX_VIDEO = 2 * 1024 * 1024, true");
      await ev("window.__APP_WALLPAPER_API.handleVideoFile(new File([new Uint8Array(3 * 1024 * 1024)], 'mid.mp4', {type:'video/mp4'})), true");
      await sleep(500);
      check('S14 拒绝:调小上限后不进保存钩子', (await ev("window.__wpOk")) === 20 * 1024 * 1024 && (await ev("window.__APP_WALLPAPER")) === 'none');
      await ev("window.__APP_WALLPAPER_MAX_VIDEO = 1000 * 1024 * 1024, true");

      // 配额预检:伪造 estimate 配额不足(usage 9MB + 文件 3MB > quota 10MB)→ 拒绝
      await ev("window.__wpEstOrig = navigator.storage.estimate.bind(navigator.storage); navigator.storage.estimate = async () => ({quota: 10 * 1024 * 1024, usage: 9 * 1024 * 1024}), true");
      check('S14 配额:estimate 伪造生效', (await ev("navigator.storage.estimate().then((e) => e.quota)")) === 10 * 1024 * 1024);
      await ev("window.__APP_WALLPAPER_API.handleVideoFile(new File([new Uint8Array(3 * 1024 * 1024)], 'q.mp4', {type:'video/mp4'})), true");
      await sleep(500);
      check('S14 配额:预检不足拒绝', (await ev("window.__wpOk")) === 20 * 1024 * 1024);
      await ev("navigator.storage.estimate = window.__wpEstOrig; window.__wpEstOrig = null, true");

      // 收尾:摘钩 + 释放内存(未真实落库,无壁纸状态残留)
      await ev("window.__APP_WALLPAPER_API.setSaveHook(null); window.__wpOk = null, true");
    });

    // S15 登录态持久化:API Set-Cookie 无 Max-Age(会话 cookie,关闭即丢)→
    // 前端用响应体 token/userid 重写为持久 cookie,重启保持登录
    await step('S15', async () => {
      await cdp.send('Network.enable');
      await ev("(async()=>{const m = await import('/js/api.js'); m.persistLoginCookies({token:'tokS15', userid:'uidS15'}); return true;})()");
      const ls = await ev("JSON.parse(localStorage.getItem('vmp.login.v1') || 'null')");
      check('S15 持久化:token/userid 写入 localStorage',
        !!ls && ls.token === 'tokS15' && ls.userid === 'uidS15', JSON.stringify(ls));
      check('S15 持久化:登录态判定 hasLogin()',
        await ev("(async()=>{const m = await import('/js/api.js'); return m.hasLogin();})()") === true);
      // 安全改造核心:token 不再由前端写 document.cookie(服务端 HttpOnly cookie 才是唯一副本)
      check('S15 持久化:document.cookie 无 token=', !(await ev('document.cookie')).includes('token='));
      await ev("(async()=>{const m = await import('/js/api.js'); await m.logoutKugou(); return true;})()");
      check('S15 持久化:退出后 localStorage 已清', await ev("localStorage.getItem('vmp.login.v1') === null"));
      await cdp.send('Network.disable');
    });

    // S16 歌单输入兜底:粘的不是链接/歌单号(朋友常直接粘歌单名)→ 按名称搜索挑选添加
    await step('S16', async () => {
      await openDrawer();
      await ev("document.querySelector('.nav-item[data-view=my]').click()");
      await poll("!!document.getElementById('my-input')", 8000);
      await ev("localStorage.removeItem('vmp.myplaylists.v1')"); // 清空旧数据保证可重复
      await ev("document.getElementById('my-input').value = '轻音乐'");
      await ev("document.getElementById('my-add-btn').click()");
      const fallback = await poll("(document.querySelector('.view-title') || {}).textContent?.includes('按名称找歌单') && document.querySelectorAll('.card').length > 0", 15000);
      check('S16 兜底:非链接输入 → 按名称找歌单视图', fallback);
      if (!fallback) return;
      await ev("document.querySelectorAll('.card')[0].click()");
      const added = await poll("(JSON.parse(localStorage.getItem('vmp.myplaylists.v1') || '[]')).length === 1", 8000);
      check('S16 兜底:点卡片加入我的歌单', added);
      const plName = await ev("(JSON.parse(localStorage.getItem('vmp.myplaylists.v1') || '[]'))[0]?.specialname || ''");
      check('S16 兜底:已持久化歌单名', !!plName, plName);
      await poll("!!document.getElementById('my-input')", 8000); // 回到我的歌单视图
      await ev("document.querySelector('.card-remove').click()");
      check('S16 兜底:移除后归零', await poll("(JSON.parse(localStorage.getItem('vmp.myplaylists.v1') || '[]')).length === 0", 5000));
    });

    // S17 歌曲搜索:类型切「歌曲」→ 搜索 → 卡片 → 点卡片即播(lite 走 type=lyric 词曲检索通道)
    await step('S17', async () => {
      await openDrawer();
      await ev("document.querySelector('.st-btn[data-type=song]').click()");
      const ph = await ev("document.getElementById('search-input').placeholder");
      check('S17 歌曲:类型切换 + 占位符', ph.includes('歌曲'), ph);
      await ev("document.getElementById('search-input').value = '晴天'");
      await ev("document.getElementById('search-btn').click()");
      const cards = await poll("document.querySelectorAll('#main .card').length > 0", 15000);
      const firstName = await ev("document.querySelector('#main .card-name')?.textContent || ''");
      check('S17 歌曲:搜索出歌曲卡片', cards, `首张「${firstName}」`);
      if (!cards) return;
      // 「晴天」本身是 VIP 锁定曲,未登录 128k 可能不可播 → 挑第一个可播卡片
      const pick = await ev(playableIdxExpr('.card', 12));
      const idx = pick >= 0 ? pick : 0;
      await ev(`document.querySelectorAll('#main .card')[${idx}].click()`);
      const playing = await poll(
        "(()=>{const a=document.getElementById('audio');return a.src.startsWith('http') && !a.paused && document.getElementById('time-dur').textContent!=='--:--';})()", 20000);
      check('S17 歌曲:点卡片即播(时长已载入)', playing, `idx=${idx}`);
    });

    // S24 安全断言:Node 直连两个服务(不经浏览器,不受浏览器 CORS 拦截影响,验证服务端头)。
    // 阶段 2 首批:CORS 白名单 + 根服务三安全头;后续阶段追加禁用路由/SSRF/Cookie 属性断言
    await step('S24', async () => {
      // CORS/Cookie 中间件先于路由注册,故响应头断言用一个 dot-free 路径即可;
      // 此处复用已停用的 /search/hot(热搜功能已移除、白名单已摘除)兼验「未注册路由 404 不影响安全头」
      // 恶意 origin:api 不回 ACAO(反射任意 origin 已封)
      const evil = await httpRaw('GET', 'http://127.0.0.1:3000/search/hot', { Origin: 'http://evil.example.com' });
      check('S24 CORS:恶意 origin 无 ACAO', evil.headers['access-control-allow-origin'] === undefined,
        JSON.stringify({ acao: evil.headers['access-control-allow-origin'], status: evil.status }));
      check('S24 白名单:/search/hot(热搜已移除)→ 404', evil.status === 404, `status=${evil.status}`);
      // 白名单 origin:精确回显 + 允许凭据
      const good = await httpRaw('GET', 'http://127.0.0.1:3000/search/hot', { Origin: 'http://localhost:3001' });
      check('S24 CORS:localhost:3001 精确 ACAO', good.headers['access-control-allow-origin'] === 'http://localhost:3001',
        String(good.headers['access-control-allow-origin']));
      check('S24 CORS:白名单回 Allow-Credentials', good.headers['access-control-allow-credentials'] === 'true');
      // 127.0.0.1 变体同样在白名单(双地址访问入口)
      const good2 = await httpRaw('GET', 'http://127.0.0.1:3000/search/hot', { Origin: 'http://127.0.0.1:3001' });
      check('S24 CORS:127.0.0.1:3001 精确 ACAO', good2.headers['access-control-allow-origin'] === 'http://127.0.0.1:3001',
        String(good2.headers['access-control-allow-origin']));
      // 根服务:三安全头 + 不再发 ACAO
      const web = await httpRaw('GET', 'http://127.0.0.1:3001/');
      check('S24 安全头:X-Content-Type-Options=nosniff', web.headers['x-content-type-options'] === 'nosniff',
        String(web.headers['x-content-type-options']));
      check('S24 安全头:X-Frame-Options=DENY', web.headers['x-frame-options'] === 'DENY',
        String(web.headers['x-frame-options']));
      check('S24 安全头:Referrer-Policy', web.headers['referrer-policy'] === 'strict-origin-when-cross-origin',
        String(web.headers['referrer-policy']));
      check('S24 根服务:无 ACAO', web.headers['access-control-allow-origin'] === undefined,
        String(web.headers['access-control-allow-origin']));
      // 模块白名单:5 条敏感能力路由(模块文件存在但未注册)→ 404
      for (const p of ['/captcha/sent', '/login/cellphone', '/login/token', '/register/dev', '/song/url/new']) {
        const r = await httpRaw('GET', `http://127.0.0.1:3000${p}`);
        check(`S24 白名单:${p} → 404`, r.status === 404, `status=${r.status}`);
      }
      // 错误脱敏:畸形 JSON body 触发中间件错误 → 400 JSON,响应体无堆栈/敏感字样
      const bad = await httpRaw('POST', 'http://127.0.0.1:3000/search', { 'Content-Type': 'application/json' }, '{bad json');
      const b = bad.body.toLowerCase();
      const leak = ['stack', 'token=', 'userid', 'kugou_api_proxy', 'node_modules', '.js:'].filter((k) => b.includes(k));
      check('S24 脱敏:错误响应无堆栈/敏感字样', bad.status === 400 && leak.length === 0,
        leak.length ? '泄漏:' + leak.join(',') : `status=${bad.status}`);
      // SSRF 拦截:4 类绕过(userinfo 欺骗/路径子串/伪子域/file:)均 502 且不出网
      for (const evilUrl of [
        'http://kugou.com@127.0.0.1:3001/api/url?hash=test',
        'http://127.0.0.1:3001/kugou.com',
        'http://kugou.com.evil.example.com/',
        'file:///etc/passwd',
      ]) {
        const r = await httpRaw('GET', `http://127.0.0.1:3001/api/playlist?url=${encodeURIComponent(evilUrl)}`);
        const ok2 = r.status === 502 && /非法上游地址/.test(r.body);
        check(`S24 SSRF:${evilUrl.slice(0, 42)} → 502`, ok2, `status=${r.status}`);
      }
      // Cookie 属性(阶段 5):身份 cookie 统一 HttpOnly + Max-Age + SameSite=Lax
      // (平台 cookie 注入中间件同样先于路由,未注册路径也带 Set-Cookie)
      const idc = await httpRaw('GET', 'http://127.0.0.1:3000/search/hot', { Cookie: '' });
      const setc = (idc.headers['set-cookie'] || []).map((s) => s.toLowerCase());
      check('S24 Cookie:身份 Set-Cookie 含 HttpOnly/Max-Age/SameSite',
        setc.length > 0 && setc.every((s) => s.includes('httponly') && s.includes('max-age=31536000') && s.includes('samesite=lax')),
        setc.slice(0, 2).join(' | '));
      // /auth/logout:9 键过期 Set-Cookie(Max-Age=0)+ 正常响应
      const lo = await httpRaw('POST', 'http://127.0.0.1:3000/auth/logout');
      const loc = (lo.headers['set-cookie'] || []).map((s) => s.toLowerCase());
      const names = ['token', 'userid', 'vip_token', 'dfid', 'kugou_api_mid', 'kugou_api_guid', 'kugou_api_dev', 'kugou_api_mac', 'kugou_api_webgl'];
      check('S24 Cookie:/auth/logout 清 9 键(Max-Age=0)',
        lo.status === 200 && names.every((n) => loc.some((s) => s.startsWith(n + '=') && s.includes('max-age=0'))),
        `status=${lo.status} 头数=${loc.length}`);
      // HttpOnly 不影响服务端读 cookie:携带 Cookie: token= 请求 /user/vip/detail 仍到达模块
      const vip = await httpRaw('GET', 'http://127.0.0.1:3000/user/vip/detail', { Cookie: 'token=testtoken; userid=999' });
      check('S24 Cookie:携带 token cookie 请求 /user/vip/detail 到达模块',
        vip.status !== 404 && vip.body.includes('{'), `status=${vip.status}`);
      // CSP meta:两个页面 head 均含 Content-Security-Policy,且 connect-src 白名单完整
      // (data: 壁纸 dataURL fetch、blob: 本地音乐封面 blob 回读,缺失任一 S12e/S14/S21b 必挂)
      const idx = await httpRaw('GET', 'http://127.0.0.1:3001/');
      const dl = await httpRaw('GET', 'http://127.0.0.1:3001/desktop-lyrics.html');
      check('S24 CSP:index.html 含 CSP meta 且 connect-src 完整',
        idx.status === 200 && idx.body.includes('Content-Security-Policy') && idx.body.includes("connect-src 'self' data: blob:"),
        `status=${idx.status}`);
      check('S24 CSP:desktop-lyrics.html 含 CSP meta 且 connect-src 完整',
        dl.status === 200 && dl.body.includes('Content-Security-Policy') && dl.body.includes("connect-src 'self' data: blob:"),
        `status=${dl.status}`);
    });

    // S25 旧登录态迁移冒烟(2026-08 安全改造):老版本把 token 写在非 HttpOnly cookie;
    // 升级后首次启动 migrateLegacyLogin 读旧 cookie → localStorage(vmp.login.v1),
    // 并后台调服务端 /auth/logout 幂等清除旧 cookie(响应到达前 UI 已按 localStorage 判定登录态)。
    await step('S25', async () => {
      await ev("localStorage.removeItem('vmp.login.v1'); document.cookie='token=legacyTok25; path=/'; document.cookie='userid=9527; path=/'");
      await cdp.send('Page.reload');
      const migrated = await poll("JSON.parse(localStorage.getItem('vmp.login.v1') || 'null')?.token === 'legacyTok25'", 8000);
      check('S25 迁移:旧 token cookie → localStorage', migrated);
      check('S25 迁移:userid 同步迁移',
        await ev("JSON.parse(localStorage.getItem('vmp.login.v1') || 'null')?.userid === '9527'") === true);
      check('S25 迁移:hasLogin() 判定为已登录',
        await ev("(async()=>{const m = await import('/js/api.js'); return m.hasLogin();})()") === true);
      const cleared = await poll("!document.cookie.includes('token=')", 8000);
      check('S25 迁移:旧 cookie 已清(/auth/logout)', cleared, await ev('document.cookie'));
      await ev("localStorage.removeItem('vmp.login.v1')"); // 恢复未登录态
    });

    // S26 播放模式:播放条 btn-mode 三态(顺序循环🔁/单曲循环🔂/随机播放🔀)+
    // 持久化(vmp.playmode.v1)+ ended 实际切歌行为(本地双曲队列,不依赖网络)
    await step('S26', async () => {
      // 重复运行安全:清持久键 + 内存态归位 order(构造时可能从上次运行残留的键恢复了非默认模式)
      await ev("localStorage.removeItem('vmp.playmode.v1')");
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.clear(); player.setPlayMode('order'); return true;})()");
      check('S26 模式:默认顺序循环(🔁)', (await ev("window.__APP_PLAY_MODE")) === 'order'
        && (await ev("document.getElementById('btn-mode').textContent")) === '🔁',
        String(await ev("window.__APP_PLAY_MODE")));
      // 本地双曲队列(A 30s / B 10s):ended 行为断言不依赖网络
      await mkWavFixtures();
      const q = await ev(`(async()=>{
        const {importFiles}=await import('/js/local-music.js');
        const r=await importFiles([window.__wavA, window.__wavB]);
        const {player}=await import('/js/player.js');
        player.setQueue(r.songs, 0);
        return r.songs.map((s)=>s.name);
      })()`);
      check('S26 队列:本地双曲就绪(A+B)', Array.isArray(q) && q.length === 2, JSON.stringify(q));
      if (!Array.isArray(q) || q.length !== 2) return;
      await poll("document.getElementById('audio').src.startsWith('blob:') && !document.getElementById('audio').paused", 15000);
      // 三态循环切换:图标 / 标记 / 持久化 / 高亮 四联动
      await ev("document.getElementById('btn-mode').click()");
      check('S26 切换:→ 单曲循环(🔂 + 标记)', await poll("window.__APP_PLAY_MODE === 'loop-one' && document.getElementById('btn-mode').textContent === '🔂'", 3000),
        String(await ev("window.__APP_PLAY_MODE")));
      check('S26 持久化:vmp.playmode.v1=loop-one', (await ev("localStorage.getItem('vmp.playmode.v1')")) === 'loop-one');
      check('S26 高亮:非顺序模式点亮薄荷色', await ev("document.getElementById('btn-mode').classList.contains('active')") === true);
      await ev("document.getElementById('btn-mode').click()");
      check('S26 切换:→ 随机播放(🔀)', await poll("window.__APP_PLAY_MODE === 'shuffle' && document.getElementById('btn-mode').textContent === '🔀'", 3000));
      await ev("document.getElementById('btn-mode').click()");
      check('S26 切换:→ 顺序循环(🔁 + 高亮熄灭)', await poll("window.__APP_PLAY_MODE === 'order' && document.getElementById('btn-mode').textContent === '🔁'", 3000)
        && (await ev("document.getElementById('btn-mode').classList.contains('active')")) === false);
      // ended 行为:单曲循环 → 重播当前曲(进度归零继续播)
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.setPlayMode('loop-one'); const a=document.getElementById('audio'); a.currentTime=a.duration-0.15; return true;})()");
      check('S26 单曲循环:ended 重播当前曲(进度归零)', await poll(
        "(()=>{const a=document.getElementById('audio');return !a.paused && a.currentTime < 5 && document.getElementById('np-name').textContent==='测试静音A';})()", 15000),
        await ev("document.getElementById('np-name').textContent"));
      // ended 行为:随机播放 → 双曲队列必然切到另一首(B)
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.setPlayMode('shuffle'); const a=document.getElementById('audio'); a.currentTime=a.duration-0.15; return true;})()");
      check('S26 随机播放:ended 切到另一首(B)', await poll(
        "(()=>{const a=document.getElementById('audio');return !a.paused && document.getElementById('np-name').textContent==='测试静音B';})()", 15000),
        await ev("document.getElementById('np-name').textContent"));
      // ended 行为:顺序循环 → 队尾(B)循环回队首(A)
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.setPlayMode('order'); const a=document.getElementById('audio'); a.currentTime=a.duration-0.15; return true;})()");
      check('S26 顺序循环:ended 队尾循环回队首(A)', await poll(
        "(()=>{const a=document.getElementById('audio');return !a.paused && document.getElementById('np-name').textContent==='测试静音A';})()", 15000),
        await ev("document.getElementById('np-name').textContent"));
      // 收尾:归位 order + 清队列/本地库/持久键,不污染后续 S9 审计与可重复性
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.setPlayMode('order'); player.clear(); return true;})()");
      await ev("window.__APP_LOCAL_API.reset()");
      await ev("localStorage.removeItem('vmp.playmode.v1')");
    });

    // S27 本地歌单增强:在线歌(推荐/搜索)加入本地歌单 + 自定义歌单封面
    await step('S27', async () => {
      await ev("(async()=>{ await window.__APP_LOCAL_API.reset(); localStorage.removeItem('vmp.myplaylists.v1'); return true;})()");
      // 模块级:建歌单 → 加入在线歌(hash 去重)→ 混合曲目读取
      const mix = await ev(`(async()=>{
        const {createPlaylist, addSongToPlaylist, getPlaylistSongs} = window.__APP_LOCAL_API;
        const pl = await createPlaylist('测试歌单', [], []);
        window.__s27pl = pl;
        addSongToPlaylist(pl.id, {hash:'fakehash27', name:'假在线歌', artists:'测试歌手', img:'', duration:200});
        addSongToPlaylist(pl.id, {hash:'fakehash27', name:'重复加', artists:'x'});
        const songs = getPlaylistSongs(pl);
        return {id: pl.id, n: songs.length, first: songs[0]?.hash, online: pl.onlineSongs?.length};
      })()`);
      check('S27 歌单:在线歌入列 + hash 去重', !!mix && mix.n === 1 && mix.first === 'fakehash27' && mix.online === 1, JSON.stringify(mix));
      // UI:队列行 ＋ 按钮 → 弹层选歌单 → 本地歌经弹层入歌单
      await mkWavFixtures();
      await ev(`(async()=>{
        const {importFiles}=await import('/js/local-music.js');
        const r=await importFiles([window.__wavA]);
        const {player}=await import('/js/player.js');
        player.setQueue(r.songs, 0);
        return true;
      })()`);
      await openDrawer();
      await ev("document.querySelector('.drawer-tab-btn[data-tab=queue]').click()");
      const hasAdd = await poll("!!document.querySelector('#queue-view .row-add')", 5000);
      check('S27 UI:队列行有「＋」按钮', hasAdd);
      if (!hasAdd) return;
      await ev("document.querySelector('#queue-view .row-add').click()");
      check('S27 UI:点击＋弹出歌单选择层', await poll("!!document.querySelector('.vmp-overlay')", 3000));
      check('S27 UI:选择层列出已有歌单', await ev("document.querySelectorAll('.vmp-item').length") >= 1);
      await ev("document.querySelector('.vmp-item').click()");
      check('S27 UI:选择后弹层关闭', await poll("!document.querySelector('.vmp-overlay')", 3000));
      const after = await ev("(async()=>{const pl=window.__s27pl; return {songIds: pl.songIds.length, online: pl.onlineSongs?.length};})()");
      check('S27 UI:本地歌经弹层入歌单(songIds+1)', after.songIds === 1 && after.online === 1, JSON.stringify(after));
      // 封面:合成 PNG → setCustomCover 存 IDB → 可读 blob URL
      const cov = await ev(`(async()=>{
        const cv=document.createElement('canvas'); cv.width=cv.height=8;
        const b=await new Promise(r=>cv.toBlob(r,'image/png'));
        const ok=await window.__APP_LOCAL_API.setCustomCover(window.__s27pl.id, b);
        const url=await window.__APP_LOCAL_API.getCustomCoverUrl(window.__s27pl.id);
        return {ok, blob: url.startsWith('blob:')};
      })()`);
      check('S27 封面:自定义封面写入 IDB 并可读 URL', cov?.ok === true && cov?.blob === true, JSON.stringify(cov));
      // 清理
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.clear(); await window.__APP_LOCAL_API.reset(); localStorage.removeItem('vmp.myplaylists.v1'); return true;})()");
    });

    // S28 生命周期内存优化:hide 时视频壁纸解码休眠(src 摘除)+ 可视化 rAF 挂起 +
    // Web Audio 未播放挂起;show 后全部唤醒且播放链正常(桌面歌词不接入生命周期,心跳存活)
    await step('S28', async () => {
      check('S28 生命周期:初始标记 active', (await ev("window.__APP_LIFECYCLE")) === 'active');
      // 合成 1 帧 webm 视频壁纸(同 S12e 手法)→ 应用后 video 有 blob: src
      await ev("window.__wpChunks=[]; (()=>{const cv=document.createElement('canvas');cv.width=64;cv.height=64;cv.getContext('2d').fillRect(0,0,64,64);const st=cv.captureStream(5);window.__wpRec=new MediaRecorder(st);window.__wpRec.ondataavailable=(e)=>{if(e.data.size)window.__wpChunks.push(e.data);};window.__wpRec.start();return true;})()");
      await sleep(400);
      await ev("window.__wpRec.stop()");
      await ev("window.__APP_WALLPAPER_API.applyVideoBlob(new Blob(window.__wpChunks, {type:'video/webm'}))");
      check('S28 壁纸:视频就绪(标记 video + blob src)', await poll(
        "window.__APP_WALLPAPER === 'video' && document.getElementById('wallpaper-video').getAttribute('src')?.startsWith('blob:')", 5000));
      // hide:壁纸解码休眠(src 摘除 + paused)+ 可视化 rAF 挂起(时间冻结)
      await ev("window.__APP_LIFECYCLE_API.hide()");
      check('S28 生命周期:hide → 标记 hidden', await poll("window.__APP_LIFECYCLE === 'hidden'", 2000));
      const vidSrc = await ev("document.getElementById('wallpaper-video').getAttribute('src')");
      const vidPaused = await ev("document.getElementById('wallpaper-video').paused");
      check('S28 壁纸:hidden 摘除视频 src(解码休眠)', vidSrc === null && vidPaused === true, `src=${JSON.stringify(vidSrc)} paused=${vidPaused}`);
      const is3d = (await ev("window.__APP_STARFIELD_3D")) === '1';
      const vizKey = is3d ? '__APP_VIZ3D' : '__APP_VIZ2D';
      const susp = await ev(`window.${vizKey}._suspended === true`);
      const t1 = await ev(`window.${vizKey}.t`);
      await sleep(600);
      const t2 = await ev(`window.${vizKey}.t`);
      check(`S28 ${is3d ? '3D' : '2D'}:hidden 挂起 rAF(时间冻结)`, susp && Math.abs(t2 - t1) < 1e-9, `susp=${susp} t1=${t1.toFixed(2)} t2=${t2.toFixed(2)}`);
      // show:全部唤醒(标记/rAF 前进/壁纸 src 恢复)
      await ev("window.__APP_LIFECYCLE_API.show()");
      check('S28 生命周期:show → 标记 active', await poll("window.__APP_LIFECYCLE === 'active'", 2000));
      const tA = await ev(`window.${vizKey}.t`);
      await sleep(500);
      const tB = await ev(`window.${vizKey}.t`);
      check(`S28 ${is3d ? '3D' : '2D'}:show 后 rAF 恢复(时间前进)`, tB > tA, `tA=${tA.toFixed(2)} tB=${tB.toFixed(2)}`);
      check('S28 壁纸:show 恢复视频 src', await poll("document.getElementById('wallpaper-video').getAttribute('src')?.startsWith('blob:')", 5000));
      // Web Audio:本地 WAV 播 → ctx running;暂停 + hide → suspended;show → running;再播正常
      await mkWavFixtures();
      await ev(`(async()=>{
        const {importFiles}=await import('/js/local-music.js');
        const r=await importFiles([window.__wavA]);
        const {player}=await import('/js/player.js');
        player.setQueue(r.songs, 0);
        return true;
      })()`);
      check('S28 音频:播放后 ctx running',
        await poll("(async()=>{const {player}=await import('/js/player.js'); return player._ctx?.state === 'running';})()", 15000),
        String(await ev("(async()=>{const {player}=await import('/js/player.js'); return player._ctx?.state;})()")));
      await poll("!document.getElementById('audio').paused", 10000); // 确保已进入 playing 态
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.toggle(); return true;})()"); // 暂停
      await ev("window.__APP_LIFECYCLE_API.hide()");
      check('S28 音频:hidden + 未播放 → ctx suspended', await poll(
        "(async()=>{const {player}=await import('/js/player.js'); return player._ctx?.state === 'suspended';})()", 3000),
        String(await ev("(async()=>{const {player}=await import('/js/player.js'); return player._ctx?.state;})()")));
      await ev("window.__APP_LIFECYCLE_API.show()");
      check('S28 音频:show → ctx running', await poll(
        "(async()=>{const {player}=await import('/js/player.js'); return player._ctx?.state === 'running';})()", 3000));
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.toggle(); return true;})()"); // 续播
      check('S28 音频:挂起循环后播放链正常', await poll("!document.getElementById('audio').paused", 5000));
      // 收尾:清队列/本地库/壁纸,生命周期归位 active,不污染 S9 审计与可重复性
      await ev("(async()=>{const {player}=await import('/js/player.js'); player.clear(); return true;})()");
      await ev("window.__APP_LOCAL_API.reset()");
      await ev("window.__APP_WALLPAPER_API.clearWallpaper()");
      await ev("window.__APP_LIFECYCLE_API.show()");
    });

    // S9 控制台/异常审计(始终执行,环境噪声豁免见 isEnvNoise)
    const errs = [...cdp.exceptions, ...cdp.consoleErrors].filter((e) => !isEnvNoise(e));
    check('S9 全程无未捕获异常/控制台报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (err) {
    check('测试驱动异常', false, err.message);
  } finally {
    try { ws?.close(); } catch {}
    chrome?.kill();
    await sleep(300);
    if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n========== ${results.length - fails.length}/${results.length} 通过 ==========`);
  process.exit(fails.length ? 1 : 0);
})();
