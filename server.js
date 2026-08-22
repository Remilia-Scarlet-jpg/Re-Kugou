/**
 * RE:KG — 本地服务(零依赖,仅 Node 内置模块)
 *
 * 职责:
 * 1. 托管 web/ 目录下的静态页面
 * 2. GET /api/url?hash=H 代理酷狗 trackercdn 解析播放地址
 *    (trackercdn 不返回 CORS 头,浏览器无法直连,必须经本服务转发;
 *     mp3 CDN 本身带 CORS 头,拿到地址后浏览器可直接播放并做频谱分析)
 *
 * 启动: node server.js [端口],默认 3001
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || process.argv[2] || 3001);
const WEB_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  // 安全头(SECURITY_RULES):页面全同源,不再发 ACAO(收紧 CORS);
  // nosniff 防 MIME 嗅探;X-Frame-Options 防 iframe 嵌入;Referrer-Policy 避免泄露完整路径给第三方 CDN
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

/** 静态文件服务:路径穿越防护 + 按扩展名给 MIME */
function serveStatic(res, urlPath) {
  const p = path.normalize(path.join(WEB_DIR, urlPath));
  if (p !== WEB_DIR && !p.startsWith(WEB_DIR + path.sep)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  // 根路径(win32 下 join 结果带尾部分隔符,不能直接与 WEB_DIR 比较)
  const filePath = urlPath === '/' ? path.join(WEB_DIR, 'index.html') : p;
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  });
}

// 上游 trackercdn 协议开关(SECURITY_RULES 规则10:优先 https,明文 http 仅作回退)。
// 若 https 下 trackercdn v2 大面积 502(实测该接口时好时坏),curl -v 验证后置 false
// 并在 CLAUDE.md 记录回退原因
const TRACKERCDN_HTTPS = true;

/**
 * 解析播放地址:酷狗旧版 trackercdn 接口
 * key = md5(hash + "kgcloudv2"),appid=1005 / pid=2 / cmd=25
 */
function resolveUrl(res, query) {
  const hash = (query.get('hash') || '').trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(hash)) {
    return sendJson(res, 400, { ok: false, error: '无效的歌曲标识' });
  }

  const key = crypto.createHash('md5').update(hash + 'kgcloudv2').digest('hex');
  const upstream =
    `${TRACKERCDN_HTTPS ? 'https' : 'http'}://trackercdn.kugou.com/i/v2/?appid=1005&pid=2&cmd=25&behavior=play` +
    `&hash=${hash}&key=${key}`;

  let done = false;
  const finish = (status, obj) => {
    if (done) return;
    done = true;
    sendJson(res, status, obj);
  };

  const up = (TRACKERCDN_HTTPS ? https : http).get(
    upstream,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: '*/*',
      },
    },
    (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.status === 1 && Array.isArray(data.url)) {
            finish(200, { ok: true, urls: data.url.filter((u) => typeof u === 'string') });
          } else {
            finish(200, { ok: false, error: '无可用音源,该歌曲可能为VIP或已下架' });
          }
        } catch {
          finish(502, { ok: false, error: '音源服务响应异常' });
        }
      });
    }
  );
  up.on('error', () => finish(502, { ok: false, error: '音源服务不可用' }));
  up.setTimeout(5000, () => {
    up.destroy();
    finish(504, { ok: false, error: '音源服务超时' });
  });
}

/**
 * SSRF 防护(SECURITY_RULES 规则3):上游 URL 白名单校验。
 * 只允许 http/https 的 kugou.com 及其子域;拒绝 userinfo(kugou.com@127.0.0.1 欺骗)、
 * 拒绝 file: 等协议、拒绝子串/伪子域伪造(kugou.com.evil.com)。
 * 返回规范化 href,非法返回 null。
 */
function safeUpstreamUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.hostname !== 'kugou.com' && !u.hostname.endsWith('.kugou.com')) return null;
  return u.href;
}

/**
 * 上游请求(自动跟随最多 3 次重定向,http/https 自适应;回调第二参数为最终 URL)
 * 入口与每一跳重定向都过 safeUpstreamUrl 白名单,非法立即回调 {ssrf:true}(调用方回 502)。
 * once 防重:超时 destroy 后 socket 仍可能再触发 error,且重试期间迟到的事件不得二次回调
 * (否则重试成功后 finishShare 撞上已发送的响应头 → ERR_HTTP_HEADERS_SENT,实测崩溃过)
 */
function upstreamGet(url, headers, hops, cb, timeoutMs = 6000) {
  const safe = safeUpstreamUrl(url);
  if (!safe) return cb({ ssrf: true });
  const lib = safe.startsWith('https:') ? https : http;
  let done = false;
  const once = (...a) => {
    if (done) return;
    done = true;
    cb(...a);
  };
  const up = lib.get(safe, { headers }, (upRes) => {
    if ([301, 302, 307, 308].includes(upRes.statusCode) && upRes.headers.location && hops > 0) {
      upRes.resume();
      return upstreamGet(new URL(upRes.headers.location, safe).href, headers, hops - 1, cb, timeoutMs);
    }
    once(upRes, safe);
  });
  up.on('error', () => once(null));
  up.setTimeout(timeoutMs, () => {
    up.destroy();
    once(null);
  });
}

/** 上游请求(带一次重试):网络抖动/超时后自动再试,仍失败回调 null;finish 防重(同 once) */
function upstreamGetRetry(url, headers, hops, cb, timeoutMs = 6000, tries = 2) {
  let done = false;
  const finish = (...a) => {
    if (done) return;
    done = true;
    cb(...a);
  };
  upstreamGet(url, headers, hops, (upRes, finalUrl) => {
    if (!upRes && tries > 1) {
      return upstreamGetRetry(url, headers, hops, finish, timeoutMs, tries - 1);
    }
    finish(upRes, finalUrl);
  }, timeoutMs);
}

/** HTML 实体解码(&amp; &#039; 等) */
function decodeHtml(s) {
  return String(s || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&nbsp;', ' ');
}

/**
 * 从 wwwapi 分享页 HTML 提取 var dataFromSmarty = [...] 完整曲目数组
 * (JS 变量声明含尾部注释/逗号,无法直接 JSON.parse,用方括号计数截取)
 */
function parseShareTracks(body) {
  const start = body.indexOf('var dataFromSmarty');
  if (start < 0) return null;
  const eq = body.indexOf('[', start);
  if (eq < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = eq; i < body.length; i++) {
    const ch = body[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(body.slice(eq, end));
  } catch {
    return null;
  }
}

/**
 * 新式概念版分享页(activity.kugou.com SPA 壳,无内嵌曲目数据)解析:
 * 最终 URL 带 global_specialid(collection_ 开头)→ 走 pubsongscdn H5 签名接口
 * /v2/get_other_list_file 一次取全列表(pagesize 实测 200/500/1000 均接受,
 * 已放宽到 1000;实测好友歌单 145 首全量),每首自带 cover/timelen(毫秒)/album_id,无需封面补全。
 * 签名 = md5(盐 + 按键排序的 key=value 串 + 盐),盐与参数形状来自分享页 SPA
 * 源码(@kg_request chunk),勿改动字段集合(实测缺失即 1001/20006)。
 */
// 注意:SECURITY_RULES 规则1 豁免——H5_SALT 是酷狗分享页 SPA 公开的客户端签名常量
// (浏览器端可见,非用户密钥/凭据),硬编码不构成泄露;真正的密钥一律走环境变量
const H5_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

function h5Sign(params) {
  const pre = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  return crypto.createHash('md5').update(H5_SALT + pre + H5_SALT).digest('hex');
}

function fetchCollectionPlaylist(globalId, res) {
  const t = String(Date.now());
  const p = {
    appid: '1058',
    type: '0',
    module: 'playlist',
    page: '1',
    pagesize: '1000',
    global_collection_id: globalId,
    mid: t,
    uid: '0',
    token: '',
    dfid: '-',
    srcappid: '2919',
    clientver: '20000',
    clienttime: t,
    uuid: t,
  };
  p.signature = h5Sign(p);
  const qs = Object.entries(p)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  upstreamGetRetry(
    `https://pubsongscdn.kugou.com/v2/get_other_list_file?${qs}`,
    { 'User-Agent': MOBILE_UA, Accept: '*/*', 'Accept-Encoding': 'identity' },
    0,
    (upRes) => {
      if (upRes?.ssrf) return sendJson(res, 502, { ok: false, error: '非法上游地址' });
      if (!upRes || upRes.statusCode !== 200) {
        if (upRes) upRes.resume();
        return sendJson(res, 200, { ok: false, error: '分享链接的歌曲列表暂不可用,请稍后重试' });
      }
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        let info = null;
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          info = d?.status === 1 ? d.data?.info : null;
        } catch {
          info = null;
        }
        if (!Array.isArray(info) || !info.length) {
          return sendJson(res, 200, { ok: false, error: '该分享链接暂不可用(可能是私密歌单),请确认后重试' });
        }
        // name 形如 "歌手 - 歌名"(与 m.kugou filename 同构,复用同一拆分逻辑)
        const songs = info
          .filter((s) => s && s.hash && s.name)
          .map((s) => {
            const parts = String(s.name).split(' - ');
            return {
              hash: s.hash,
              name: parts.length > 1 ? parts[parts.length - 1] : parts[0],
              artists: parts.length > 1 ? parts.slice(0, -1).join(' - ') : '',
              img: s.cover || '',
              albumId: s.album_id || '',
              duration: Number.isFinite(s.timelen) ? Math.round(s.timelen / 1000) : undefined,
            };
          });
        sendJson(res, 200, { ok: true, id: '', name: '', songs });
      });
    },
    10000
  );
}

/**
 * 歌单曲目:酷狗旧版移动网页接口 m.kugou.com/plist/list/{id}?json=true
 * (exe 内两条曲目路由均因 cloudlist 服务签名失效,本接口仍存活但只返回前 10 首、仅公开歌单)
 * 支持 id= 或 url=(任意酷狗链接,含 t1.kugou.com 短链,先跟随重定向再提取歌单号)
 */
function proxyPlaylist(res, query) {
  const urlParam = String(query.get('url') || '').trim();
  const id = String(query.get('id') || '').replace(/[^0-9]/g, '');
  if (!id && urlParam) {
    // SSRF 防护:入口过 kugou.com 白名单(禁 userinfo/子串/伪子域/非 http(s)),非法直接 502
    const safe = safeUpstreamUrl(urlParam);
    if (!safe) return sendJson(res, 502, { ok: false, error: '非法上游地址' });
    // 短链分享涉及 t1 → wwwapi 两跳,放宽超时并失败重试一次
    upstreamGetRetry(
      safe,
      {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
      5,
      (upRes, finalUrl) => {
        // 重定向跳到白名单外(SSRF)→ 502
        if (upRes?.ssrf) return sendJson(res, 502, { ok: false, error: '非法上游地址' });
        // 上游失败按友好 200 返回,避免前端抛泛化的「无法连接歌单服务」
        if (!upRes) return sendJson(res, 200, { ok: false, error: '分享链接无法打开,请检查网络或稍后重试' });
        // 新式概念版分享页(activity.kugou.com SPA):无内嵌数据,URL 带 global_specialid → H5 签名接口
        const coll = (finalUrl || '').match(/[?&]global_specialid=([^&]+)/i);
        if (coll) {
          upRes.resume();
          return fetchCollectionPlaylist(decodeURIComponent(coll[1]), res);
        }
        // 分享页(wwwapi.kugou.com/share/...):页面内嵌完整曲目 JSON(酷狗 App 分享短链的落点)
        if (upRes.statusCode === 200 && /\/share\/[a-z]+\.html/i.test(finalUrl || '')) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const arr = parseShareTracks(Buffer.concat(chunks).toString('utf8'));
            if (!Array.isArray(arr) || !arr.length) {
              return sendJson(res, 200, { ok: false, error: '分享链接解析失败,请确认是歌单分享链接' });
            }
            const songs = arr
              .filter((s) => s && s.hash)
              .map((s) => {
                const audioName = decodeHtml(s.audio_name || '');
                const fallbackName = audioName.includes(' - ') ? audioName.split(' - ').slice(-1)[0] : audioName;
                return {
                  hash: s.hash,
                  name: decodeHtml(s.song_name || '') || fallbackName || '未知歌曲',
                  artists: decodeHtml(s.author_name || '') || '未知歌手',
                  img: '',
                  // 分享页无封面 URL 但有 album_id,前端按需用 /images(hash+album_id) 补全封面
                  albumId: s.album_id || '',
                  duration: Number.isFinite(s.timelength) ? Math.round(s.timelength / 1000) : undefined,
                };
              });
            // 分享页不含歌单名,交由前端命名(默认「分享歌单(n首)」,可重命名)
            finishShare(res, songs);
          });
          return;
        }
        upRes.resume();
        const m =
          (finalUrl || '').match(/(?:plist\/list|special\/single)\/(\d+)/i) ||
          (finalUrl || '').match(/\/(\d{6,})/);
        if (!m) return sendJson(res, 200, { ok: false, error: '链接解析失败,请确认是歌单分享链接' });
        proxyPlaylistById(res, String(m[1]));
      },
      12000
    );
    return;
  }
  if (!id) return sendJson(res, 400, { ok: false, error: '无效的歌单标识' });
  proxyPlaylistById(res, id);
}

function finishShare(res, songs) {
  sendJson(res, 200, { ok: true, id: '', name: '', songs });
}

function proxyPlaylistById(res, id) {
  let done = false;
  const finish = (status, obj) => {
    if (done) return;
    done = true;
    sendJson(res, status, obj);
  };

  upstreamGetRetry(
    `https://m.kugou.com/plist/list/${id}?json=true`,
    {
      // 移动网页接口按 UA 分流,需手机 UA 才返回 JSON
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    },
    3,
    (upRes) => {
      // 重定向跳到白名单外(SSRF)→ 502
      if (upRes?.ssrf) return finish(502, { ok: false, error: '非法上游地址' });
      // 上游失败按友好 200 返回,避免前端抛泛化的「无法连接歌单服务」
      if (!upRes) return finish(200, { ok: false, error: '歌单服务暂时不可用,请检查网络或稍后重试' });
      // 非 200(歌单不存在/私有 → 404/403 或重定向到错误页)→ 转友好提示,不抛 502
      if (upRes.statusCode !== 200) {
        upRes.resume();
        return finish(200, { ok: false, error: '该歌单不存在或为私有歌单(酷狗接口限制),请将歌单设为公开' });
      }
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const d = JSON.parse(body);
          const info = d?.list?.list?.info;
          if (!Array.isArray(info) || !info.length) {
            return finish(200, { ok: false, error: '歌单为空或为私有歌单(酷狗接口限制),请将歌单设为公开' });
          }
          const meta = d?.info?.list || {};
          // filename 形如 "歌手 - 歌名";封面藏在 trans_param.union_cover
          const songs = info
            .filter((s) => s && s.hash && s.filename)
            .map((s) => {
              const parts = s.filename.split(' - ');
              const name = parts.length > 1 ? parts[parts.length - 1] : parts[0];
              const artists = parts.length > 1 ? parts.slice(0, -1).join(' - ') : meta.singername || '';
              return {
                hash: s.hash,
                name,
                artists: artists || '未知歌手',
                img: s.trans_param?.union_cover || meta.imgurl || '',
                // union_cover 缺失时前端可凭 album_id 走 /images 补封面
                albumId: s.album_id || '',
                duration: Number.isFinite(s.duration) ? s.duration : undefined,
              };
            });
          finish(200, { ok: true, id, name: meta.specialname || '', songs });
        } catch {
          // 返回 HTML(通常是重定向到了登录/错误页)→ 友好提示
          if (body.includes('<html')) {
            finish(200, { ok: false, error: '该歌单为私有歌单或已失效(酷狗接口限制),请将歌单设为公开' });
          } else {
            finish(502, { ok: false, error: '歌单服务响应异常' });
          }
        }
      });
    },
    12000
  );
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad request' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  if (url.pathname === '/api/url') return resolveUrl(res, url.searchParams);
  if (url.pathname === '/api/playlist') return proxyPlaylist(res, url.searchParams);

  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad request' });
  }
  serveStatic(res, p);
});

// 安全:只监听回环地址,不暴露局域网(SECURITY_RULES 规则4)
server.listen(PORT, '127.0.0.1', () => {
  console.log(`RE:KG 服务已启动: http://localhost:${PORT}`);
});
